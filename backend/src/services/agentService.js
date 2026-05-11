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

// ── Create ────────────────────────────────────────────────────────────────────
async function createAgent(userId, data) {
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
    return { ...formatAgent(agent, []), privateKey: wallet.privateKey };
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
    name:                 'name',
    dailyLimitUsdc:       'daily_limit_usdc',
    maxGasGwei:           'max_gas_gwei',
    slippagePercent:      'slippage_percent',
    maxTradeUsdc:         'max_trade_usdc',
    autoLockMinutes:      'auto_lock_minutes',
    contractGuard:        'contract_guard_enabled',
    llmApiKeyEncrypted:   'llm_api_key_encrypted',
    llmModel:             'llm_model',
    isSmartMode:          'is_smart_mode',
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
};
