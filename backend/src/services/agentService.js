'use strict';
const { ethers } = require('ethers');
const db = require('../db');
const { encrypt, decrypt } = require('./cryptoService');
const { getDailyLimitBypass } = require('./dailyLimitBypass');
const { assertAgentOperational } = require('./securityEventService');

const DEFAULT_PERMISSIONS = [
  'defi_scan',
  'arbitrage',
  'testnet_explorer',
  'contract_scanner',
  'liquidations',
  'aggressive_mode',
];

const STABLE_MANUAL_ADD_COOLDOWN_MINUTES = Math.max(
  Number.parseInt(process.env.STABLE_MANUAL_LP_ADD_COOLDOWN_MINUTES || '45', 10) || 45,
  1,
);
const ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES = Math.max(
  Number.parseInt(process.env.ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES || '60', 10) || 60,
  0,
);
const DEFAULT_STABLE_TARGET_LP_ALLOCATION_PCT = 25;
const DEFAULT_STABLE_TARGET_LP_MIN_ALLOCATION_PCT = 20;
const DEFAULT_STABLE_TARGET_LP_MAX_ALLOCATION_PCT = 30;
const DAILY_ORACLE_CAP = Math.max(Number.parseInt(process.env.DAILY_ORACLE_CAP || '48', 10) || 48, 1);
const DAILY_DEFI_LOOP_CAP = Math.max(Number.parseInt(process.env.DAILY_DEFI_LOOP_CAP || '24', 10) || 24, 1);

function parseTimestampMs(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toPositiveFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeUsdcAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function readStableLpAllocationSnapshot(decision) {
  const minPct = toPositiveFiniteNumber(decision?.targetLpMinAllocationPct) || DEFAULT_STABLE_TARGET_LP_MIN_ALLOCATION_PCT;
  const maxPct = toPositiveFiniteNumber(decision?.targetLpMaxAllocationPct) || DEFAULT_STABLE_TARGET_LP_MAX_ALLOCATION_PCT;
  const unclampedTargetPct = toPositiveFiniteNumber(decision?.targetLpTargetAllocationPct) || DEFAULT_STABLE_TARGET_LP_ALLOCATION_PCT;
  const targetPct = Math.min(Math.max(unclampedTargetPct, minPct), maxPct);

  return {
    minPct,
    targetPct,
    maxPct,
    source: String(decision?.targetLpAllocationSource || '').trim() || 'policy_default',
  };
}

function readStableLpBandSnapshot(decision, allocationSnapshot) {
  const availableUsdcBalance = toPositiveFiniteNumber(decision?.availableUsdcBalance) || 0;
  const availableEurcBalance = toPositiveFiniteNumber(decision?.availableEurcBalance) || 0;
  const walletReserveUsdc = toPositiveFiniteNumber(decision?.walletReserveUsdc) || 0;
  const positionValueUsd = toPositiveFiniteNumber(decision?.positionValueUsd) || 0;
  const deployableUsdcBalance = normalizeUsdcAmount(Math.max(availableUsdcBalance - walletReserveUsdc, 0));
  const totalStableCapitalUsd = normalizeUsdcAmount(deployableUsdcBalance + availableEurcBalance + positionValueUsd);

  if (totalStableCapitalUsd > 0) {
    return {
      minUsd: normalizeUsdcAmount(totalStableCapitalUsd * (allocationSnapshot.minPct / 100)),
      targetUsd: normalizeUsdcAmount(totalStableCapitalUsd * (allocationSnapshot.targetPct / 100)),
      maxUsd: normalizeUsdcAmount(totalStableCapitalUsd * (allocationSnapshot.maxPct / 100)),
    };
  }

  return {
    minUsd: normalizeUsdcAmount(decision?.targetLpMinUsd),
    targetUsd: normalizeUsdcAmount(decision?.targetLpTargetUsd),
    maxUsd: normalizeUsdcAmount(decision?.targetLpMaxUsd),
  };
}

function isLegacyStableDecision(decision) {
  if (!decision || typeof decision !== 'object') return false;
  const executionSource = String(decision.executionSource || '').trim();
  const policyId = String(decision.policyId || '').trim();
  return executionSource === 'stable_policy_v1' || policyId === 'stable_usdc_eurc_curve_v1';
}

async function readOracleEntryCooldown(agentId) {
  if (!agentId || !(ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES > 0)) {
    return {
      active: false,
      until: null,
      lastExitAt: null,
      minutes: ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES,
      txHash: null,
    };
  }

  const { rows: [lastExit] } = await db.query(
    `SELECT created_at::text AS created_at,
            tx_hash
       FROM transactions
      WHERE agent_id = $1
        AND type = 'rebalance'
        AND status = 'confirmed'
        AND meta->>'executionSource' = 'oracle_strategy_v1'
        AND COALESCE(meta->>'fromToken', '') = 'EURC'
        AND COALESCE(meta->>'toToken', '') = 'USDC'
      ORDER BY created_at DESC
      LIMIT 1`,
    [agentId],
  );

  const lastExitAtMs = parseTimestampMs(lastExit?.created_at);
  if (lastExitAtMs == null) {
    return {
      active: false,
      until: null,
      lastExitAt: null,
      minutes: ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES,
      txHash: null,
    };
  }

  const untilMs = lastExitAtMs + (ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES * 60_000);

  return {
    active: untilMs > Date.now(),
    until: new Date(untilMs).toISOString(),
    lastExitAt: lastExit.created_at,
    minutes: ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES,
    txHash: lastExit.tx_hash || null,
  };
}

function buildStableManualCooldownDecision(lastDecision, manualCooldownUntil, { cooldownActive = false } = {}) {
  const baseDecision = lastDecision && typeof lastDecision === 'object' ? lastDecision : {};
  const allocationSnapshot = readStableLpAllocationSnapshot(baseDecision);
  const bandSnapshot = readStableLpBandSnapshot(baseDecision, allocationSnapshot);
  const cooldownUntilMs = parseTimestampMs(manualCooldownUntil);
  const legacyRecordedAtMs = parseTimestampMs(baseDecision.recordedAt);
  const recordedAtMs = cooldownActive && cooldownUntilMs != null
    ? cooldownUntilMs - (STABLE_MANUAL_ADD_COOLDOWN_MINUTES * 60_000)
    : (legacyRecordedAtMs != null ? legacyRecordedAtMs : Date.now());
  const summary = cooldownActive
    ? (manualCooldownUntil
      ? `A manual stable LP add was recorded. Stable LP automation is holding until ${manualCooldownUntil}, so soft trims and non-emergency exits stay paused.`
      : 'A manual stable LP add was recorded. Stable LP automation is holding while soft trims and non-emergency exits stay paused.')
    : 'This stable card is ignoring an older mixed-policy snapshot and is waiting for the next Stable LP lane review.';

  return {
    ...baseDecision,
    ok: true,
    lane: 'stable_curve_lp',
    error: null,
    action: 'hold',
    reason: cooldownActive ? 'manual_cooldown_active' : 'legacy_snapshot_ignored',
    status: 'policy_hold',
    txHash: null,
    execute: false,
    summary,
    lpAction: null,
    policyId: 'stable_usdc_eurc_lp_manager_v2',
    blockedBy: cooldownActive ? 'manualCooldown' : 'legacySnapshot',
    recordedAt: new Date(recordedAtMs).toISOString(),
    actionParams: null,
    operationType: null,
    executionSource: 'stable_lp_policy_v2',
    suggestedAmountUsdc: 0,
    suggestedLpExitAmount: null,
    suggestedLpExitValueUsd: 0,
    targetLpMinUsd: bandSnapshot.minUsd,
    targetLpTargetUsd: bandSnapshot.targetUsd,
    targetLpMaxUsd: bandSnapshot.maxUsd,
    targetLpMinAllocationPct: allocationSnapshot.minPct,
    targetLpTargetAllocationPct: allocationSnapshot.targetPct,
    targetLpMaxAllocationPct: allocationSnapshot.maxPct,
    targetLpAllocationSource: allocationSnapshot.source,
    manualCooldownUntil: manualCooldownUntil || null,
    manualCooldownActive: cooldownActive,
  };
}

function resolveStableAutomationState({
  lastStatus,
  lastDecision,
  manualCooldownUntil,
} = {}) {
  const stableDecision = extractStableAutomationDecision(lastDecision);
  const cooldownUntilMs = parseTimestampMs(manualCooldownUntil);
  const cooldownActive = cooldownUntilMs != null && cooldownUntilMs > Date.now();
  const legacyDecision = isLegacyStableDecision(stableDecision);

  if (!legacyDecision) {
    return {
      lastStatus: stableDecision?.status || lastStatus || 'idle',
      lastDecision: stableDecision,
      lastRunAt: stableDecision?.recordedAt || null,
    };
  }

  const maskedDecision = buildStableManualCooldownDecision(stableDecision, manualCooldownUntil, { cooldownActive });
  return {
    lastStatus: 'policy_hold',
    lastDecision: maskedDecision,
    lastRunAt: maskedDecision.recordedAt,
  };
}

function extractStableAutomationDecision(lastDecision) {
  if (!lastDecision || typeof lastDecision !== 'object') return null;

  const embeddedStableDecision = lastDecision.stableLaneDecision
    && typeof lastDecision.stableLaneDecision === 'object'
    && Object.keys(lastDecision.stableLaneDecision).length > 0
      ? lastDecision.stableLaneDecision
      : null;

  if (embeddedStableDecision) return embeddedStableDecision;
  if (lastDecision.lane === 'cirbtc_direct_pair_lp') return null;
  return lastDecision;
}

// ── ERC-8004 IdentityRegistry (Arc Testnet) ───────────────────────────────────
const IDENTITY_REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const IDENTITY_REGISTRY_ABI = [
  'function register(string agentURI) returns (uint256 agentId)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
];
// EIP-712 domain + type for setAgentWallet signature (signed by the agent's EOA)
const EIP712_DOMAIN = {
  name: 'ERC8004IdentityRegistry',
  version: '1',
  chainId: 5042002,
  verifyingContract: IDENTITY_REGISTRY_ADDRESS,
};
const EIP712_TYPES = {
  AgentWalletSet: [
    { name: 'agentId',   type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner',     type: 'address' },
    { name: 'deadline',  type: 'uint256' },
  ],
};

async function _registerErc8004(agentId, walletAddress, agentPrivateKey) {
  const rpc = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const relayerKey = process.env.RELAYER_PRIVATE_KEY;

  if (!relayerKey) throw new Error('RELAYER_PRIVATE_KEY not set');

  const provider   = new ethers.JsonRpcProvider(rpc, { chainId: 5042002, name: 'Arc Testnet' });
  const relayer    = new ethers.Wallet(relayerKey, provider);
  const agentEOA   = new ethers.Wallet(agentPrivateKey, provider);
  const registry   = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ABI, relayer);
  const agentURI   = `https://arc-machina.app/agents/${agentId}`;

  const TIMEOUT_MS = 60_000;
  const mkTimeout  = () => new Promise((_, rej) =>
    setTimeout(() => rej(new Error('ERC-8004 tx timed out')), TIMEOUT_MS));

  // Step 1: register(agentURI) — relayer pays gas, becomes NFT owner
  const tx1     = await registry['register(string)'](agentURI);
  const receipt1 = await Promise.race([tx1.wait(1), mkTimeout()]);

  // Parse Registered event → on-chain tokenId
  const iface   = new ethers.Interface(IDENTITY_REGISTRY_ABI);
  let tokenId   = null;
  for (const log of receipt1.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'Registered') { tokenId = parsed.args.agentId.toString(); break; }
    } catch { /* skip */ }
  }
  if (tokenId === null) throw new Error('Registered event not found in receipt');

  // Step 2: setAgentWallet — agent's EOA signs EIP-712 message, relayer sends tx
  // deadline must be within 5 minutes (MAX_DEADLINE_DELAY on contract)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 4 * 60);
  const sig = await agentEOA.signTypedData(EIP712_DOMAIN, EIP712_TYPES, {
    agentId:   BigInt(tokenId),
    newWallet: walletAddress,
    owner:     relayer.address,
    deadline,
  });

  const tx2 = await registry.setAgentWallet(tokenId, walletAddress, deadline, sig);
  await Promise.race([tx2.wait(1), mkTimeout()]);

  return { tokenId, txHash: receipt1.hash };
}

// ── ERC-8004 registration attempt — called after agent DB insert ──────────────
// Never throws: failures are recorded in DB so user can retry.
async function attemptErc8004Registration(agentId, walletAddress, agentPrivateKey) {
  // Allow disabling via env — useful when the contract is not yet live on testnet
  if (process.env.ERC8004_ENABLED === 'false') {
    // Silently skip — erc8004_status column may not exist yet; formatAgent defaults to 'skipped'
    console.log(`[ERC-8004] Skipped for agent ${agentId} (ERC8004_ENABLED=false)`);
    return { success: false, skipped: true };
  }

  try {
    const { tokenId, txHash } = await _registerErc8004(agentId, walletAddress, agentPrivateKey);
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
    'SELECT id, wallet_address, private_key_encrypted, erc8004_status FROM agents WHERE id = $1 AND user_id = $2',
    [agentId, userId],
  );
  if (!rows.length) return null;

  const agent = rows[0];
  if (agent.erc8004_status === 'registered') {
    return { alreadyRegistered: true };
  }

  if (!agent.private_key_encrypted) {
    throw new Error('Agent private key not found — cannot retry registration');
  }

  // Mark as pending before attempting
  await db.query(
    "UPDATE agents SET erc8004_status = 'pending', erc8004_error = NULL WHERE id = $1",
    [agentId],
  );

  const privateKey = decrypt(agent.private_key_encrypted);
  return attemptErc8004Registration(agentId, agent.wallet_address, privateKey);
}

// ── Create ────────────────────────────────────────────────────────────────────
async function createAgent(userId, data) {
  // Testnet limit: 1 active agent per user (bypass for whitelisted addresses)
  const whitelist = (process.env.AGENT_LIMIT_WHITELIST || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  let isWhitelisted = false;
  if (whitelist.length > 0) {
    const { rows: userRows } = await db.query(
      'SELECT owner_address FROM users WHERE id = $1',
      [userId],
    );
    const ownerAddr = (userRows[0]?.owner_address || '').toLowerCase();
    isWhitelisted = whitelist.includes(ownerAddr);
  }

  if (!isWhitelisted) {
    const { rows: existing } = await db.query(
      "SELECT id FROM agents WHERE user_id = $1 AND status != 'locked' LIMIT 1",
      [userId],
    );
    if (existing.length > 0) {
      const err = new Error('Testnet limit: only 1 active agent allowed per user');
      err.status = 409;
      throw err;
    }
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
         daily_limit_usdc, max_gas_gwei, slippage_percent, max_trade_usdc, defi_wallet_reserve_usdc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        data.defiWalletReserveUsdc ?? 0,
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
    // Pass the plaintext private key — it's still in memory here, not yet GC'd
    setImmediate(() => attemptErc8004Registration(agent.id, wallet.address.toLowerCase(), wallet.privateKey));

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
    defiWalletReserveUsdc:   'defi_wallet_reserve_usdc',
    oracleMaxEurcInventory:  'oracle_max_eurc_inventory',
    oracleMinEurcReserve:    'oracle_min_eurc_reserve',
    gatewayAutoTopupEnabled: 'gateway_auto_topup_enabled',
    gatewayAutoTopupMinUsdc: 'gateway_auto_topup_min_usdc',
    gatewayAutoTopupTargetUsdc: 'gateway_auto_topup_target_usdc',
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
    lendingAutomationEnabled:'lending_automation_enabled',
    carryAutomationEnabled:  'carry_automation_enabled',
    cirbtcLpEnabled:         'cirbtc_lp_enabled',
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
  return rows.length ? getAgent(agentId, userId) : null;
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
    return getAgent(agentId, userId);
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
            a.llm_model, a.wallet_address, a.last_reset_day, a.daily_limit_reset_at,
          a.market_analysis_enabled, a.oracle_enabled, a.defi_loop_enabled, a.lending_automation_enabled, a.carry_automation_enabled, a.cirbtc_lp_enabled, a.reputation_enabled,
            a.daily_market_analysis_count, a.daily_defi_loop_count, a.daily_auto_tx_count,
            a.market_analysis_last_run_at, a.market_analysis_last_status, a.market_analysis_last_decision,
            a.stable_manual_cooldown_until,
            a.oracle_last_run_at, a.oracle_last_status,
            a.defi_loop_last_run_at, a.defi_loop_last_status, a.defi_loop_last_decision,
            a.lending_automation_last_run_at, a.lending_automation_last_status, a.lending_automation_last_decision,
            a.carry_automation_last_run_at, a.carry_automation_last_status, a.carry_automation_last_decision,
            a.cirbtc_lp_last_run_at, a.cirbtc_lp_last_status, a.cirbtc_lp_last_decision,
            a.reputation_last_run_at, a.reputation_last_status
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

  const dailyLimitBypass = getDailyLimitBypass(a);
  const suspendScanJobsWhenDefiCapReached = String(process.env.SUSPEND_CAP_REACHED_SCAN_JOBS || '').trim().toLowerCase() === 'true';
  const dailyCapResetAtMs = a.daily_limit_reset_at
    ? new Date(a.daily_limit_reset_at).getTime() + 86_400_000
    : Number.NaN;
  const dailyCapResetsAt = Number.isFinite(dailyCapResetAtMs)
    ? new Date(dailyCapResetAtMs).toISOString()
    : null;
  const marketAnalysisLastDecision = a.market_analysis_last_decision
    && typeof a.market_analysis_last_decision === 'object'
    && Object.keys(a.market_analysis_last_decision).length > 0
    ? a.market_analysis_last_decision
    : null;
  const defiLoopLastDecision = a.defi_loop_last_decision
    && typeof a.defi_loop_last_decision === 'object'
    && Object.keys(a.defi_loop_last_decision).length > 0
    ? a.defi_loop_last_decision
    : null;
  const stableLoopState = resolveStableAutomationState({
    lastStatus: a.defi_loop_last_status || 'idle',
    lastDecision: defiLoopLastDecision,
    manualCooldownUntil: a.stable_manual_cooldown_until,
  });
  const cirbtcLpLastDecision = a.cirbtc_lp_last_decision
    && typeof a.cirbtc_lp_last_decision === 'object'
    && Object.keys(a.cirbtc_lp_last_decision).length > 0
    ? a.cirbtc_lp_last_decision
    : null;
  const lendingAutomationLastDecision = a.lending_automation_last_decision
    && typeof a.lending_automation_last_decision === 'object'
    && Object.keys(a.lending_automation_last_decision).length > 0
    ? a.lending_automation_last_decision
    : null;
  const carryAutomationLastDecision = a.carry_automation_last_decision
    && typeof a.carry_automation_last_decision === 'object'
    && Object.keys(a.carry_automation_last_decision).length > 0
    ? a.carry_automation_last_decision
    : null;
  const oracleEntryCooldown = await readOracleEntryCooldown(agentId);

  return {
    agentId:       a.id,
    status:        a.status,
    dailySpent:    parseFloat(a.daily_spent_usdc),
    dailyLimit:    parseFloat(a.daily_limit_usdc),
    remainingToday: parseFloat(a.daily_limit_usdc) - parseFloat(a.daily_spent_usdc),
    isSmartMode:   a.is_smart_mode,
    llmModel:      a.llm_model,
    walletAddress: a.wallet_address,
    dailyLimitBypass,
    config: {
      reputationRegistryConfigured: Boolean(process.env.REPUTATION_REGISTRY_ADDRESS),
      swapConfigured: Boolean(process.env.CIRCLE_KIT_KEY || process.env.KIT_KEY),
      suspendScanJobsWhenDefiCapReached,
    },
    automation: {
      marketAnalysis: {
        enabled: a.market_analysis_enabled ?? false,
        lastRunAt: a.market_analysis_last_run_at,
        lastStatus: a.market_analysis_last_status || 'idle',
        lastDecision: marketAnalysisLastDecision,
        dailyCapResetsAt,
      },
      oracle: {
        enabled: a.oracle_enabled ?? false,
        lastRunAt: a.oracle_last_run_at,
        lastStatus: a.oracle_last_status || 'idle',
        entryCooldown: oracleEntryCooldown,
        todayCount: a.daily_market_analysis_count ?? 0,
        dailyCap: DAILY_ORACLE_CAP,
        dailyCapResetsAt,
        bypassDailyCap: dailyLimitBypass.enabled,
      },
      defiLoop: {
        enabled: a.defi_loop_enabled ?? false,
        lastRunAt: stableLoopState.lastRunAt || a.defi_loop_last_run_at,
        lastStatus: stableLoopState.lastStatus,
        lastDecision: stableLoopState.lastDecision,
        manualCooldownUntil: a.stable_manual_cooldown_until,
        todayCount: a.daily_defi_loop_count ?? 0,
        dailyCap: DAILY_DEFI_LOOP_CAP,
        dailyCapResetsAt,
        autoTxToday: a.daily_auto_tx_count ?? 0,
        bypassDailyCap: dailyLimitBypass.enabled,
      },
      lendingAutomation: {
        enabled: a.lending_automation_enabled ?? false,
        lastRunAt: a.lending_automation_last_run_at,
        lastStatus: a.lending_automation_last_status || 'idle',
        lastDecision: lendingAutomationLastDecision,
        todayCount: a.daily_defi_loop_count ?? 0,
        dailyCap: DAILY_DEFI_LOOP_CAP,
        dailyCapResetsAt,
        autoTxToday: a.daily_auto_tx_count ?? 0,
        bypassDailyCap: dailyLimitBypass.enabled,
      },
      carryAutomation: {
        enabled: a.carry_automation_enabled ?? false,
        lastRunAt: a.carry_automation_last_run_at,
        lastStatus: a.carry_automation_last_status || 'idle',
        lastDecision: carryAutomationLastDecision,
        todayCount: a.daily_defi_loop_count ?? 0,
        dailyCap: DAILY_DEFI_LOOP_CAP,
        dailyCapResetsAt,
        autoTxToday: a.daily_auto_tx_count ?? 0,
        bypassDailyCap: dailyLimitBypass.enabled,
      },
      cirbtcLp: {
        enabled: a.cirbtc_lp_enabled ?? false,
        lastRunAt: a.cirbtc_lp_last_run_at,
        lastStatus: a.cirbtc_lp_last_status || 'idle',
        lastDecision: cirbtcLpLastDecision,
        todayCount: a.daily_defi_loop_count ?? 0,
        dailyCap: DAILY_DEFI_LOOP_CAP,
        dailyCapResetsAt,
        autoTxToday: a.daily_auto_tx_count ?? 0,
        bypassDailyCap: dailyLimitBypass.enabled,
      },
      reputation: {
        enabled: a.reputation_enabled ?? false,
        lastRunAt: a.reputation_last_run_at,
        lastStatus: a.reputation_last_status || 'idle',
      },
    },
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
      status:       row.erc8004_status   || 'skipped',  // pending|registered|failed|skipped
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
      defiWalletReserveUsdc: parseFloat(row.defi_wallet_reserve_usdc || 0),
      oracleMaxEurcInventory: row.oracle_max_eurc_inventory != null ? parseFloat(row.oracle_max_eurc_inventory) : null,
      oracleMinEurcReserve: row.oracle_min_eurc_reserve != null ? parseFloat(row.oracle_min_eurc_reserve) : null,
      gatewayAutoTopupEnabled: row.gateway_auto_topup_enabled ?? true,
      gatewayAutoTopupMinUsdc: parseFloat(row.gateway_auto_topup_min_usdc || 1),
      gatewayAutoTopupTargetUsdc: parseFloat(row.gateway_auto_topup_target_usdc || 3),
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
      lendingAutomationEnabled: row.lending_automation_enabled ?? false,
      carryAutomationEnabled: row.carry_automation_enabled ?? false,
      cirbtcLpEnabled:       row.cirbtc_lp_enabled       ?? false,
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
  return rows[0] ? assertAgentOperational(rows[0]) : null;
}

// Background poller injection: fetch agent by ID without userId check (internal use only)
async function getAgentWithKeyById(agentId) {
  const { rows } = await db.query(
    'SELECT * FROM agents WHERE id = $1',
    [agentId],
  );
  return rows[0] ? assertAgentOperational(rows[0]) : null;
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
  readOracleEntryCooldown,
  deactivateAgent,
  retryErc8004Registration,
};
