'use strict';

const crypto = require('crypto');

const DEFAULT_DETERMINISTIC_LANE_FAILURE_COOLDOWN_MS = 45 * 60 * 1000;

function readDeterministicLaneFailureCooldownMs() {
  const raw = Number.parseInt(process.env.DETERMINISTIC_LANE_FAILURE_COOLDOWN_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_DETERMINISTIC_LANE_FAILURE_COOLDOWN_MS;
  }
  return Math.max(raw, 60_000);
}

function normalizeText(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function normalizeAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return String(Math.floor(Math.max(numeric, 0) * 1_000_000) / 1_000_000);
}

function buildDeterministicLaneFailureScopeKey({
  policyLane,
  executionSource,
  pairOrPool,
  tokenIn,
  tokenOut,
  requestedAmount,
  routeMode,
  recommendationFingerprint,
}) {
  const scopeSeed = [
    normalizeText(policyLane, 'unknown_lane').toLowerCase(),
    normalizeText(executionSource, 'unknown_source').toLowerCase(),
    normalizeText(pairOrPool, 'unknown_pair').toUpperCase(),
    normalizeText(tokenIn, 'UNKNOWN').toUpperCase(),
    normalizeText(tokenOut, 'UNKNOWN').toUpperCase(),
    normalizeAmount(requestedAmount),
    normalizeText(routeMode, 'auto').toLowerCase(),
    normalizeText(recommendationFingerprint, 'none').toLowerCase(),
  ].join('|');

  return crypto.createHash('sha256').update(scopeSeed).digest('hex');
}

function buildDeterministicLaneFailureFingerprint({
  agentId,
  scopeKey,
  errorCode,
}) {
  const seed = [
    normalizeText(agentId, 'unknown_agent').toLowerCase(),
    normalizeText(scopeKey, 'missing_scope').toLowerCase(),
    normalizeText(errorCode, 'UNKNOWN').toUpperCase(),
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

function getCooldownStateForRow(row, { cooldownMs = readDeterministicLaneFailureCooldownMs(), nowMs = Date.now() } = {}) {
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

function buildDeterministicLaneFailureMeta(baseMeta = {}, {
  fingerprint,
  scopeKey,
  errorCode,
  cooldownMs = readDeterministicLaneFailureCooldownMs(),
  nowIso = new Date().toISOString(),
  repeatCount = 1,
} = {}) {
  return {
    ...baseMeta,
    deterministicPreBroadcastFailure: true,
    laneFailureFingerprint: normalizeText(fingerprint),
    laneFailureScopeKey: normalizeText(scopeKey),
    laneFailureErrorCode: normalizeText(errorCode, 'UNKNOWN').toUpperCase(),
    laneFailureCooldownMs: cooldownMs,
    firstSeenAt: baseMeta.firstSeenAt || nowIso,
    lastSeenAt: nowIso,
    repeatCount: Math.max(Number(repeatCount || 1), 1),
  };
}

async function findMatchingDeterministicLaneFailureRow(db, {
  agentId,
  transactionType,
  fingerprint,
}) {
  const { rows } = await db.query(
    `SELECT id, created_at::text AS created_at, meta
       FROM transactions
      WHERE agent_id = $1
        AND type = $2
        AND COALESCE(meta->>'deterministicPreBroadcastFailure', 'false') = 'true'
        AND COALESCE(meta->>'laneFailureFingerprint', '') = $3
      ORDER BY created_at ASC
      LIMIT 1`,
    [agentId, transactionType, fingerprint],
  );

  return rows[0] || null;
}

async function registerDeterministicLaneFailureCooldownHit(db, {
  agentId,
  transactionType,
  fingerprint,
  scopeKey,
  errorCode,
  cooldownMs = readDeterministicLaneFailureCooldownMs(),
  nowMs = Date.now(),
} = {}) {
  if (!agentId || !transactionType || !fingerprint) {
    return { active: false, retryAfterMs: 0, rowId: null, repeatCount: 0 };
  }

  const row = await findMatchingDeterministicLaneFailureRow(db, {
    agentId,
    transactionType,
    fingerprint,
  });

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
  const nextMeta = buildDeterministicLaneFailureMeta(row.meta || {}, {
    fingerprint,
    scopeKey,
    errorCode,
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

async function findActiveDeterministicLaneFailureByScope(db, {
  agentId,
  transactionType,
  scopeKey,
  cooldownMs = readDeterministicLaneFailureCooldownMs(),
  nowMs = Date.now(),
  limit = 20,
} = {}) {
  if (!agentId || !transactionType || !scopeKey) {
    return { active: false, retryAfterMs: 0, rowId: null, fingerprint: null };
  }

  const { rows } = await db.query(
    `SELECT id, created_at::text AS created_at, meta
       FROM transactions
      WHERE agent_id = $1
        AND type = $2
        AND COALESCE(meta->>'deterministicPreBroadcastFailure', 'false') = 'true'
        AND COALESCE(meta->>'laneFailureScopeKey', '') = $3
      ORDER BY created_at DESC
      LIMIT $4`,
    [agentId, transactionType, scopeKey, Math.max(Number(limit || 20), 1)],
  );

  for (const row of rows) {
    const cooldownState = getCooldownStateForRow(row, { cooldownMs, nowMs });
    if (!cooldownState.active) continue;

    return {
      active: true,
      retryAfterMs: cooldownState.retryAfterMs,
      rowId: row.id,
      fingerprint: row?.meta?.laneFailureFingerprint || null,
      repeatCount: Number(row?.meta?.repeatCount || 1),
      errorCode: row?.meta?.laneFailureErrorCode || null,
      firstSeenAt: row?.meta?.firstSeenAt || null,
      lastSeenAt: row?.meta?.lastSeenAt || null,
    };
  }

  return { active: false, retryAfterMs: 0, rowId: null, fingerprint: null };
}

module.exports = {
  DEFAULT_DETERMINISTIC_LANE_FAILURE_COOLDOWN_MS,
  readDeterministicLaneFailureCooldownMs,
  buildDeterministicLaneFailureScopeKey,
  buildDeterministicLaneFailureFingerprint,
  buildDeterministicLaneFailureMeta,
  getCooldownStateForRow,
  registerDeterministicLaneFailureCooldownHit,
  findActiveDeterministicLaneFailureByScope,
};
