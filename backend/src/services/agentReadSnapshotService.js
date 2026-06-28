'use strict';

const db = require('../db');

const SNAPSHOT_KINDS = Object.freeze({
  POSITIONS: 'positions',
  LENDING: 'lending',
  STATUS: 'status',
});

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getUserReadCacheTtlMs() {
  return readPositiveIntegerEnv('ARC_RPC_USER_READ_CACHE_TTL_MS', 15000);
}

function getUserReadStaleTtlMs() {
  return readPositiveIntegerEnv('ARC_RPC_USER_READ_STALE_TTL_MS', 300000);
}

function getUserReadTimeoutMs() {
  return readPositiveIntegerEnv('ARC_RPC_USER_READ_TIMEOUT_MS', 800);
}

function getBackgroundRefreshTimeoutMs() {
  return readPositiveIntegerEnv('ARC_RPC_BACKGROUND_REFRESH_TIMEOUT_MS', 10000);
}

function normalizeSnapshotKind(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  if (!Object.values(SNAPSHOT_KINDS).includes(normalized)) {
    throw new Error(`Unsupported snapshot kind: ${kind}`);
  }
  return normalized;
}

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload || {}));
}

function buildSnapshotState(row, freshTtlMs = getUserReadCacheTtlMs(), staleTtlMs = getUserReadStaleTtlMs()) {
  if (!row) return null;

  const updatedAtMs = Date.parse(row.updated_at || row.updatedAt || '');
  const now = Date.now();
  const ageMs = Number.isFinite(updatedAtMs) ? Math.max(now - updatedAtMs, 0) : Number.MAX_SAFE_INTEGER;

  if (ageMs > staleTtlMs) {
    return null;
  }

  return {
    payload: clonePayload(row.payload),
    ageMs,
    stale: ageMs > freshTtlMs,
    fresh: ageMs <= freshTtlMs,
    updatedAt: row.updated_at || row.updatedAt || null,
  };
}

async function loadAgentReadSnapshot(agentId, kind, options = {}) {
  const normalizedKind = normalizeSnapshotKind(kind);

  try {
    const result = await db.query(
      `SELECT payload, updated_at
         FROM agent_read_snapshots
        WHERE agent_id = $1 AND kind = $2
        LIMIT 1`,
      [agentId, normalizedKind],
    );

    const row = result?.rows?.[0] || null;
    return buildSnapshotState(row, options.freshTtlMs, options.staleTtlMs);
  } catch {
    return null;
  }
}

async function saveAgentReadSnapshot(agentId, kind, payload) {
  const normalizedKind = normalizeSnapshotKind(kind);

  try {
    await db.query(
      `INSERT INTO agent_read_snapshots (agent_id, kind, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (agent_id, kind)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [agentId, normalizedKind, JSON.stringify(payload || {})],
    );
    return true;
  } catch {
    return false;
  }
}

function buildCachedResponseMeta(snapshotState) {
  return {
    stale: Boolean(snapshotState?.stale),
    dataFreshness: 'cached',
    cacheAgeMs: Number(snapshotState?.ageMs || 0),
  };
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  const durationMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : getBackgroundRefreshTimeoutMs();

  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage || `timed out after ${durationMs}ms`)), durationMs);
    }),
  ]);
}

module.exports = {
  SNAPSHOT_KINDS,
  getUserReadCacheTtlMs,
  getUserReadStaleTtlMs,
  getUserReadTimeoutMs,
  getBackgroundRefreshTimeoutMs,
  loadAgentReadSnapshot,
  saveAgentReadSnapshot,
  buildCachedResponseMeta,
  withTimeout,
};
