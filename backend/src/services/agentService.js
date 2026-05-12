'use strict';
const { ethers } = require('ethers');
const db = require('../db');
const { encrypt, decrypt } = require('./cryptoService');

const DEFAULT_PERMISSIONS = [
  'defi_scan',
  'arbitrage',
  'testnet_explorer',
  'contract_scanner',
  'liquidations',
  'aggressive_mode',
];

// ── ERC-8004 IdentityRegistry (Arc Testnet) ───────────────────────────────────
const IDENTITY_REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const IDENTITY_REGISTRY_ABI = [
  'function registerAgent(string name, string description, string metadataUri) returns (uint256 tokenId)',
  'event AgentRegistered(uint256 indexed tokenId, address indexed owner, string name)',
];

async function _registerErc8004(agentId, walletAddress, agentName) {
  const rpc = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const relayerKey = process.env.RELAYER_PRIVATE_KEY;

  if (!relayerKey) {
    throw new Error('RELAYER_PRIVATE_KEY not set — cannot register on-chain identity');
  }

  const provider = new ethers.JsonRpcProvider(rpc, { chainId: 5042002, name: 'Arc Testnet' });
  const relayer  = new ethers.Wallet(relayerKey, provider);
  const registry = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ABI, relayer);

  const description = `Arc Machina autonomous agent — ${walletAddress}`;
  const metadataUri = `https://arc-machina.app/agents/${agentId}`;

  const tx = await registry.registerAgent(agentName, description, metadataUri);
  const receipt = await tx.wait(1);

  // Parse AgentRegistered event to get tokenId
  const iface = new ethers.Interface(IDENTITY_REGISTRY_ABI);
  let tokenId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'AgentRegistered') {
        tokenId = parsed.args.tokenId.toString();
        break;
      }
    } catch { /* skip unparseable logs */ }
  }

  return { tokenId, txHash: receipt.hash };
}

// ── ERC-8004 registration attempt — called after agent DB insert ──────────────
// Never throws: failures are recorded in DB so user can retry.
async function attemptErc8004Registration(agentId, walletAddress, agentName) {
  try {
    const { tokenId, txHash } = await _registerErc8004(agentId, walletAddress, agentName);
    await db.query(
      `UPDATE agents SET
         erc8004_status        = 'registered',
         erc8004_token_id      = $1,
         erc8004_tx_hash       = $2,
         erc8004_registered_at = NOW(),
         erc8004_error         = NULL
       WHERE id = $3`,
      [tokenId, txHash, agentId],
    );
    console.log(`[ERC-8004] Agent ${agentId} registered — tokenId=${tokenId} tx=${txHash}`);
    return { success: true, tokenId, txHash };
  } catch (err) {
    const message = err.message || 'Unknown error';
    await db.query(
      `UPDATE agents SET
         erc8004_status  = 'failed',
         erc8004_error   = $1
       WHERE id = $2`,
      [message.slice(0, 500), agentId],
    );
    console.warn(`[ERC-8004] Registration failed for agent ${agentId}: ${message}`);
    return { success: false, error: message };
  }
}

// ── Retry ERC-8004 registration (called from route handler) ───────────────────
async function retryErc8004Registration(agentId, userId) {
  const { rows } = await db.query(
    'SELECT id, wallet_address, name, erc8004_status FROM agents WHERE id = $1 AND user_id = $2',
    [agentId, userId],
  );
  if (!rows.length) return null;

  const agent = rows[0];
  if (agent.erc8004_status === 'registered') {
    return { alreadyRegistered: true };
  }

  // Mark as pending before attempting
  await db.query(
    "UPDATE agents SET erc8004_status = 'pending', erc8004_error = NULL WHERE id = $1",
    [agentId],
  );

  return attemptErc8004Registration(agentId, agent.wallet_address, agent.name);
}

// ── Create ────────────────────────────────────────────────────────────────────
async function createAgent(userId, data) {
  // Testnet limit: 1 active agent per user
  const { rows: existing } = await db.query(
    "SELECT id FROM agents WHERE user_id = $1 AND status != 'locked' LIMIT 1",
    [userId],
  );
  if (existing.length > 0) {
    const err = new Error('Testnet limit: only 1 active agent allowed per user');
    err.status = 409;
    throw err;
  }

  const client = await db.getClient();
  try {
    // Generate a fresh EOA wallet for this agent
    const wallet = ethers.Wallet.createRandom();
    const privateKeyEncrypted = encrypt(wallet.privateKey);

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO agents
         (user_id, name, wallet_address, private_key_encrypted,
          daily_limit_usdc, max_gas_gwei, slippage_percent, max_trade_usdc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        userId,
        data.name,
        wallet.address.toLowerCase(),
        privateKeyEncrypted,
        data.dailyLimitUsdc ?? 1000,
        data.maxGasGwei ?? 50,
        data.slippagePercent ?? 0.5,
        data.maxTradeUsdc ?? 200,
      ],
    );
    const agent = rows[0];

    // Insert default (disabled) permissions
    if (DEFAULT_PERMISSIONS.length) {
      const vals = DEFAULT_PERMISSIONS.map((k, i) => `($1, $${i + 2}, FALSE)`).join(',');
      await client.query(
        `INSERT INTO agent_permissions (agent_id, permission_key, is_enabled) VALUES ${vals}`,
        [agent.id, ...DEFAULT_PERMISSIONS],
      );
    }

    await client.query('COMMIT');

    // Return the private key ONCE so the frontend can show it to the user
    const formatted = { ...formatAgent(agent, []), privateKey: wallet.privateKey };

    // Attempt ERC-8004 onchain identity registration (non-blocking, never throws)
    // Result is written back to DB — frontend polls /status or retries via route
    setImmediate(() => attemptErc8004Registration(agent.id, wallet.address.toLowerCase(), data.name));

    return formatted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── List ──────────────────────────────────────────────────────────────────────
async function listAgents(userId) {
  const { rows } = await db.query(
    'SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  return rows.map(r => formatAgent(r, []));
}

// ── Get single (with permissions) ────────────────────────────────────────────
async function getAgent(agentId, userId) {
  const { rows } = await db.query(
    'SELECT * FROM agents WHERE id = $1 AND user_id = $2',
    [agentId, userId],
  );
  if (!rows.length) return null;

  const perms = await db.query(
    'SELECT permission_key, is_enabled FROM agent_permissions WHERE agent_id = $1',
    [agentId],
  );

  return formatAgent(rows[0], perms.rows);
}

// ── Update ────────────────────────────────────────────────────────────────────
async function updateAgent(agentId, userId, data) {
  // Map camelCase → snake_case for safe dynamic update
  const colMap = {
    name:                    'name',
    dailyLimitUsdc:          'daily_limit_usdc',
    maxGasGwei:              'max_gas_gwei',
    slippagePercent:         'slippage_percent',
    maxTradeUsdc:            'max_trade_usdc',
    autoLockMinutes:         'auto_lock_minutes',
    contractGuard:           'contract_guard_enabled',
    llmApiKeyEncrypted:      'llm_api_key_encrypted',
    llmModel:                'llm_model',
    isSmartMode:             'is_smart_mode',
    // Faza 2.0: opt-in feature flags
    dailyTasksEnabled:       'daily_tasks_enabled',
    marketAnalysisEnabled:   'market_analysis_enabled',
    oracleEnabled:           'oracle_enabled',
    defiLoopEnabled:         'defi_loop_enabled',
    reputationEnabled:       'reputation_enabled',
  };

  const setClauses = [];
  const values    = [];
  let   idx       = 1;

  for (const [key, col] of Object.entries(colMap)) {
    if (data[key] !== undefined) {
      setClauses.push(`${col} = $${idx++}`);
      values.push(data[key]);
    }
  }

  if (!setClauses.length) return getAgent(agentId, userId);

  values.push(agentId);
  values.push(userId);

  const { rows } = await db.query(
    `UPDATE agents SET ${setClauses.join(', ')} WHERE id = $${idx} AND user_id = $${idx + 1} RETURNING *`,
    values,
  );
  return rows.length ? formatAgent(rows[0], []) : null;
}

// ── Permissions ───────────────────────────────────────────────────────────────
async function updatePermissions(agentId, userId, permsMap) {
  const agent = await db.query('SELECT id FROM agents WHERE id = $1 AND user_id = $2', [agentId, userId]);
  if (!agent.rows.length) return null;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const [key, enabled] of Object.entries(permsMap)) {
      await client.query(
        `INSERT INTO agent_permissions (agent_id, permission_key, is_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, permission_key) DO UPDATE SET is_enabled = $3, updated_at = NOW()`,
        [agentId, key, Boolean(enabled)],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Status ────────────────────────────────────────────────────────────────────
async function getAgentStatus(agentId, userId) {
  const { rows } = await db.query(
    `SELECT a.id, a.status, a.daily_spent_usdc, a.daily_limit_usdc, a.is_smart_mode,
            a.llm_model, a.wallet_address, a.last_reset_day
     FROM agents a
     WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  );
  if (!rows.length) return null;

  const a = rows[0];
  const today = new Date().toISOString().slice(0, 10);

  // Reset daily spending counter if it's a new day
  if (a.last_reset_day.toISOString().slice(0, 10) < today) {
    await db.query(
      'UPDATE agents SET daily_spent_usdc = 0, last_reset_day = $1 WHERE id = $2',
      [today, agentId],
    );
    a.daily_spent_usdc = '0';
  }

  return {
    agentId:       a.id,
    status:        a.status,
    dailySpent:    parseFloat(a.daily_spent_usdc),
    dailyLimit:    parseFloat(a.daily_limit_usdc),
    remainingToday: parseFloat(a.daily_limit_usdc) - parseFloat(a.daily_spent_usdc),
    isSmartMode:   a.is_smart_mode,
    llmModel:      a.llm_model,
    walletAddress: a.wallet_address,
  };
}

// ── Deactivate ────────────────────────────────────────────────────────────────
async function deactivateAgent(agentId, userId) {
  await db.query(
    "UPDATE agents SET status = 'locked' WHERE id = $1 AND user_id = $2",
    [agentId, userId],
  );
}

// ── Format (strip sensitive fields) ──────────────────────────────────────────
function formatAgent(row, perms) {
  return {
    id:             row.id,
    name:           row.name,
    walletAddress:  row.wallet_address,   // EOA address of the agent's own wallet
    status:         row.status,
    isSmartMode:    row.is_smart_mode,
    llmModel:       row.llm_model,
    hasLlmKey:      !!row.llm_api_key_encrypted,
    identity: {
      status:       row.erc8004_status   || 'pending',  // pending|registered|failed
      tokenId:      row.erc8004_token_id || null,
      txHash:       row.erc8004_tx_hash  || null,
      registeredAt: row.erc8004_registered_at || null,
      error:        row.erc8004_error    || null,
      arcScanUrl:   row.erc8004_token_id
        ? `https://testnet.arcscan.app/tx/${row.erc8004_tx_hash}`
        : null,
    },
    settings: {
      dailyLimitUsdc:  parseFloat(row.daily_limit_usdc),
      maxGasGwei:      row.max_gas_gwei,
      slippagePercent: parseFloat(row.slippage_percent),
      maxTradeUsdc:    parseFloat(row.max_trade_usdc),
      autoLockMinutes: row.auto_lock_minutes,
      contractGuard:   row.contract_guard_enabled,
      passkeyEnabled:  row.passkey_enabled,
      totpEnabled:     row.totp_enabled,
    },
    permissions: Object.fromEntries(perms.map(p => [p.permission_key, p.is_enabled])),
    // Faza 2.0: opt-in feature flags
    features: {
      dailyTasksEnabled:     row.daily_tasks_enabled     ?? false,
      marketAnalysisEnabled: row.market_analysis_enabled ?? false,
      oracleEnabled:         row.oracle_enabled          ?? false,
      defiLoopEnabled:       row.defi_loop_enabled       ?? false,
      reputationEnabled:     row.reputation_enabled      ?? false,
    },
    createdAt:    row.created_at,
  };
}

// ── Raw agent row (includes private_key_encrypted — internal use only) ─────────
/**
 * Returns the full DB row for a given agent, including private_key_encrypted.
 * MUST NOT be exposed to clients. Used only by agentWalletService for signing.
 */
async function getAgentWithKey(agentId, userId) {
  const { rows } = await db.query(
    'SELECT * FROM agents WHERE id = $1 AND user_id = $2',
    [agentId, userId],
  );
  return rows[0] || null;
}

// Background poller injection: fetch agent by ID without userId check (internal use only)
async function getAgentWithKeyById(agentId) {
  const { rows } = await db.query(
    'SELECT * FROM agents WHERE id = $1',
    [agentId],
  );
  return rows[0] || null;
}

module.exports = {
  createAgent,
  listAgents,
  getAgent,
  getAgentWithKey,
  getAgentWithKeyById,
  updateAgent,
  updatePermissions,
  getAgentStatus,
  deactivateAgent,
  retryErc8004Registration,
};
