'use strict';

const crypto = require('crypto');

const DEFAULT_STABLE_LP_EXIT_FAILURE_COOLDOWN_MS = 21_600_000;

function readStableLpExitFailureCooldownMs() {
  const raw = Number.parseInt(process.env.STABLE_LP_EXIT_FAILURE_COOLDOWN_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_STABLE_LP_EXIT_FAILURE_COOLDOWN_MS;
  }
  return Math.max(raw, 60_000);
}

function normalizeFingerprintPart(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function buildStableLpExitFailureFingerprint({
  agentId,
  operationType,
  poolAddress,
  liveLpBalance,
  tokenOut,
  errorCode,
  simulationFingerprint,
  calldataHash,
}) {
  const seed = [
    normalizeFingerprintPart(agentId).toLowerCase(),
    normalizeFingerprintPart(operationType).toLowerCase(),
    normalizeFingerprintPart(poolAddress).toLowerCase(),
    normalizeFingerprintPart(liveLpBalance, '0'),
    normalizeFingerprintPart(tokenOut, 'USDC').toUpperCase(),
    normalizeFingerprintPart(errorCode, 'UNKNOWN').toUpperCase(),
    normalizeFingerprintPart(simulationFingerprint || calldataHash, 'none').toLowerCase(),
  ].join('|');

  return crypto.createHash('sha256').update(seed).digest('hex');
}

function toMs(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getFailureWindow(row) {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  const firstSeenAt = meta.firstSeenAt || row?.created_at || null;
  const lastSeenAt = meta.lastSeenAt || firstSeenAt;

  return {
    firstSeenAt,
    firstSeenAtMs: toMs(firstSeenAt),
    lastSeenAt,
    lastSeenAtMs: toMs(lastSeenAt),
    repeatCount: Number(meta.repeatCount || 1),
  };
}

function getCooldownStateForRow(row, { cooldownMs = readStableLpExitFailureCooldownMs(), nowMs = Date.now() } = {}) {
  const window = getFailureWindow(row);
  if (!Number.isFinite(window.firstSeenAtMs)) {
    return {
      active: false,
      retryAfterMs: 0,
      window,
    };
  }

  const expiresAtMs = window.firstSeenAtMs + cooldownMs;
  const retryAfterMs = Math.max(expiresAtMs - nowMs, 0);

  return {
    active: retryAfterMs > 0,
    retryAfterMs,
    window,
  };
}

function buildFailureMeta(baseMeta = {}, {
  fingerprint,
  cooldownMs = readStableLpExitFailureCooldownMs(),
  nowIso = new Date().toISOString(),
  repeatCount = 1,
} = {}) {
  return {
    ...baseMeta,
    deterministicPreBroadcastFailure: true,
    stableLpExitFailureFingerprint: fingerprint,
    stableLpExitFailureCooldownMs: cooldownMs,
    firstSeenAt: baseMeta.firstSeenAt || nowIso,
    lastSeenAt: nowIso,
    repeatCount: Math.max(Number(repeatCount || 1), 1),
  };
}

async function findMatchingFailureRow(db, {
  agentId,
  fingerprint,
}) {
  const { rows } = await db.query(
    `SELECT id, created_at::text AS created_at, meta
       FROM transactions
      WHERE agent_id = $1
        AND type = 'curve_lp_remove'
        AND status = 'failed'
        AND COALESCE(meta->>'deterministicPreBroadcastFailure', 'false') = 'true'
        AND COALESCE(meta->>'errorCode', '') = 'TX_SIMULATION_FAILED'
        AND COALESCE(meta->>'stableLpExitFailureFingerprint', '') = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [agentId, fingerprint],
  );

  return rows[0] || null;
}

async function registerStableLpExitFailureCooldownHit(db, {
  agentId,
  fingerprint,
  cooldownMs = readStableLpExitFailureCooldownMs(),
  nowMs = Date.now(),
} = {}) {
  if (!agentId || !fingerprint) {
    return { active: false, retryAfterMs: 0, rowId: null, repeatCount: 0 };
  }

  const row = await findMatchingFailureRow(db, { agentId, fingerprint });
  if (!row) {
    return { active: false, retryAfterMs: 0, rowId: null, repeatCount: 0 };
  }

  const cooldownState = getCooldownStateForRow(row, { cooldownMs, nowMs });
  if (!cooldownState.active) {
    return {
      active: false,
      retryAfterMs: 0,
      rowId: row.id,
      repeatCount: Number(cooldownState.window.repeatCount || 1),
    };
  }

  const nowIso = new Date(nowMs).toISOString();
  const updatedRepeatCount = Number(cooldownState.window.repeatCount || 1) + 1;
  const nextMeta = buildFailureMeta(row.meta || {}, {
    fingerprint,
    cooldownMs,
    nowIso,
    repeatCount: updatedRepeatCount,
  });

  await db.query(
    `UPDATE transactions
        SET meta = $2::jsonb
      WHERE id = $1`,
    [row.id, JSON.stringify(nextMeta)],
  );

  return {
    active: true,
    retryAfterMs: cooldownState.retryAfterMs,
    rowId: row.id,
    repeatCount: updatedRepeatCount,
    firstSeenAt: nextMeta.firstSeenAt,
    lastSeenAt: nextMeta.lastSeenAt,
  };
}

async function findActiveStableLpExitFailureCooldownForAgent(db, {
  agentId,
  cooldownMs = readStableLpExitFailureCooldownMs(),
  nowMs = Date.now(),
  limit = 25,
} = {}) {
  if (!agentId) {
    return { active: false, retryAfterMs: 0, fingerprint: null };
  }

  const { rows } = await db.query(
    `SELECT id, created_at::text AS created_at, meta
       FROM transactions
      WHERE agent_id = $1
        AND type = 'curve_lp_remove'
        AND status = 'failed'
        AND COALESCE(meta->>'deterministicPreBroadcastFailure', 'false') = 'true'
        AND COALESCE(meta->>'errorCode', '') = 'TX_SIMULATION_FAILED'
        AND COALESCE(meta->>'stableLpExitFailureFingerprint', '') <> ''
      ORDER BY created_at DESC
      LIMIT $2`,
    [agentId, Math.max(Number(limit || 25), 1)],
  );

  for (const row of rows) {
    const state = getCooldownStateForRow(row, { cooldownMs, nowMs });
    if (!state.active) continue;

    return {
      active: true,
      retryAfterMs: state.retryAfterMs,
      fingerprint: row?.meta?.stableLpExitFailureFingerprint || null,
      rowId: row?.id || null,
    };
  }

  return { active: false, retryAfterMs: 0, fingerprint: null };
}

module.exports = {
  DEFAULT_STABLE_LP_EXIT_FAILURE_COOLDOWN_MS,
  readStableLpExitFailureCooldownMs,
  buildStableLpExitFailureFingerprint,
  buildFailureMeta,
  getCooldownStateForRow,
  registerStableLpExitFailureCooldownHit,
  findActiveStableLpExitFailureCooldownForAgent,
};
