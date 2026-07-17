'use strict';

const { ethers } = require('ethers');

const DEFAULT_ARC_RPC_URL = 'https://rpc.testnet.arc.network';
const DEFAULT_ENDPOINT_ERROR_COOLDOWN_MS = 120000;
const DEFAULT_BATCH_LIMIT_COOLDOWN_MS = 600000;
const DEFAULT_LOG_THROTTLE_MS = 60000;
const DEFAULT_BATCH_MAX_COUNT = 1;
const DEFAULT_BATCH_STALL_TIME_MS = 10;

const ARC_TESTNET_NETWORK = Object.freeze({
  chainId: 5042002,
  name: 'Arc Testnet',
});
const ARC_TESTNET_STATIC_NETWORK = ethers.Network.from(ARC_TESTNET_NETWORK);

const providerCache = new Map();
const endpointHealthState = new Map();
const throttledLogState = new Map();

let endpointCursor = 0;

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLogThrottleMs() {
  return readPositiveIntegerEnv('ARC_RPC_LOG_THROTTLE_MS', DEFAULT_LOG_THROTTLE_MS);
}

function getBatchMaxCount() {
  return readPositiveIntegerEnv('ARC_RPC_BATCH_MAX_COUNT', DEFAULT_BATCH_MAX_COUNT);
}

function getBatchStallTimeMs() {
  return readPositiveIntegerEnv('ARC_RPC_BATCH_STALL_TIME_MS', DEFAULT_BATCH_STALL_TIME_MS);
}

function getEndpointErrorCooldownMs() {
  return readPositiveIntegerEnv('ARC_RPC_ENDPOINT_ERROR_COOLDOWN_MS', DEFAULT_ENDPOINT_ERROR_COOLDOWN_MS);
}

function getBatchLimitCooldownMs() {
  return readPositiveIntegerEnv('ARC_RPC_BATCH_LIMIT_COOLDOWN_MS', DEFAULT_BATCH_LIMIT_COOLDOWN_MS);
}

function parseArcRpcUrlList(value) {
  if (!value) return [];

  return String(value)
    .split(/[\n,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getArcRpcUrlPool() {
  const pooledUrls = parseArcRpcUrlList(process.env.ARC_RPC_URLS);
  if (pooledUrls.length > 0) {
    return pooledUrls;
  }

  return [
    process.env.ARC_RPC_URL,
    process.env.ARC_TESTNET_RPC,
    DEFAULT_ARC_RPC_URL,
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function getArcRpcUrl() {
  return getArcRpcUrlPool()[0] || DEFAULT_ARC_RPC_URL;
}

function normalizeRpcUrl(rpcUrl = getArcRpcUrl()) {
  return String(rpcUrl || '').trim() || getArcRpcUrl();
}

function getProviderOptions() {
  return {
    staticNetwork: ARC_TESTNET_STATIC_NETWORK,
    batchMaxCount: getBatchMaxCount(),
    batchStallTime: getBatchStallTimeMs(),
  };
}

function createArcRpcProvider(rpcUrl = getArcRpcUrl()) {
  const normalizedRpcUrl = normalizeRpcUrl(rpcUrl);
  let provider = providerCache.get(normalizedRpcUrl);

  if (!provider) {
    provider = new ethers.JsonRpcProvider(
      normalizedRpcUrl,
      ARC_TESTNET_NETWORK,
      getProviderOptions(),
    );
    providerCache.set(normalizedRpcUrl, provider);
  }

  return provider;
}

function getEndpointLabel(rpcUrl) {
  try {
    const hostname = new URL(normalizeRpcUrl(rpcUrl)).hostname;
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length === 0) return 'unknown';
    if (parts[0] === 'rpc' && parts.length > 1) return parts[1];
    return parts[0];
  } catch {
    return 'unknown';
  }
}

function maskRpcUrl(rpcUrl) {
  try {
    const parsed = new URL(normalizeRpcUrl(rpcUrl));
    const host = String(parsed.hostname || '').trim();
    if (!host) return 'unknown';

    const parts = host.split('.').filter(Boolean);
    const prefix = parts.slice(0, 2).join('.') || host;
    return `${parsed.protocol}//${prefix}...`;
  } catch {
    return 'unknown';
  }
}

function extractArcRpcErrorText(error) {
  return [
    error?.message,
    error?.shortMessage,
    error?.code,
    error?.info?.responseStatus,
    error?.info?.responseBody,
    error?.error?.message,
    error?.cause?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isArcRpcBatchLimitError(error) {
  const text = extractArcRpcErrorText(error);
  return text.includes('batch of more than 3 requests are not allowed')
    || text.includes('batch of more than')
    || text.includes('code=31');
}

function isArcRpcRateLimitError(error) {
  const text = extractArcRpcErrorText(error);

  if (isArcRpcBatchLimitError(error)) {
    return true;
  }

  return text.includes('429')
    || text.includes('too many requests')
    || text.includes('rate limit')
    || text.includes('request limit reached')
    || text.includes('exceeded maximum retry limit');
}

function isArcRpcTransientError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (
    code === 'NETWORK_ERROR'
    || code === 'SERVER_ERROR'
    || code === 'TIMEOUT'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN'
  ) {
    return true;
  }

  const text = extractArcRpcErrorText(error);

  return text.includes('timeout')
    || text.includes('temporarily unavailable')
    || text.includes('socket hang up')
    || text.includes('connection reset')
    || text.includes('service unavailable')
    || text.includes('bad gateway')
    || text.includes('gateway timeout')
    || text.includes('503')
    || text.includes('504')
    || text.includes('500 internal server error');
}

function getEndpointState(rpcUrl) {
  const normalized = normalizeRpcUrl(rpcUrl);
  const existing = endpointHealthState.get(normalized);
  if (existing) return existing;

  const initial = {
    cooldownUntil: 0,
    lastErrorCode: null,
    lastErrorReason: null,
    lastErrorAt: null,
  };
  endpointHealthState.set(normalized, initial);
  return initial;
}

function getCooldownRemainingMs(rpcUrl, now = Date.now()) {
  const until = Number(getEndpointState(rpcUrl).cooldownUntil || 0);
  return Math.max(until - now, 0);
}

function getSuppressionKey({ level, kind, label, endpoint, errorCode }) {
  return [
    level || 'info',
    kind || 'generic',
    label || 'unknown',
    endpoint || 'unknown',
    errorCode || 'none',
  ].join('|');
}

function logWithThrottle({ level = 'info', kind = 'generic', label = 'unknown', endpoint = null, errorCode = null, message }) {
  const windowMs = getLogThrottleMs();
  const key = getSuppressionKey({ level, kind, label, endpoint, errorCode });
  const now = Date.now();
  const state = throttledLogState.get(key) || {
    windowStart: now,
    count: 0,
    suppressed: 0,
  };

  if (now - state.windowStart >= windowMs) {
    if (state.suppressed > 0) {
      console.info(`[ARC_RPC] suppressed repeated rpc logs label=${label} count=${state.suppressed} window=${Math.round(windowMs / 1000)}s`);
    }
    state.windowStart = now;
    state.count = 0;
    state.suppressed = 0;
  }

  if (state.count > 0) {
    state.suppressed += 1;
    throttledLogState.set(key, state);
    return;
  }

  if (level === 'error') {
    console.error(message);
  } else if (level === 'warn') {
    console.warn(message);
  } else if (level === 'info') {
    console.info(message);
  } else {
    console.log(message);
  }

  state.count += 1;
  throttledLogState.set(key, state);
}

function markArcRpcEndpointUnhealthy(rpcUrl, error, label = 'unknown') {
  if (!isArcRpcRateLimitError(error) && !isArcRpcBatchLimitError(error)) {
    return false;
  }

  const isBatchLimit = isArcRpcBatchLimitError(error);
  const cooldownMs = isBatchLimit
    ? getBatchLimitCooldownMs()
    : getEndpointErrorCooldownMs();
  const now = Date.now();
  const targets = rpcUrl
    ? [normalizeRpcUrl(rpcUrl)]
    : getArcRpcUrlPool().map((entry) => normalizeRpcUrl(entry));

  for (const endpoint of [...new Set(targets)]) {
    const state = getEndpointState(endpoint);
    state.cooldownUntil = now + cooldownMs;
    state.lastErrorCode = String(error?.code || error?.info?.responseStatus || 'unknown');
    state.lastErrorReason = isBatchLimit ? 'batch_limit' : 'rate_limit';
    state.lastErrorAt = new Date(now).toISOString();

    const kind = isBatchLimit ? 'batch_limit' : 'rate_limit';
    logWithThrottle({
      level: 'warn',
      kind,
      label,
      endpoint: getEndpointLabel(endpoint),
      errorCode: state.lastErrorCode,
      message: `[ARC_RPC] ${isBatchLimit ? 'batch limited' : 'rate limited'} endpoint=${getEndpointLabel(endpoint)} label=${label} cooldown=${Math.round(cooldownMs / 1000)}s`,
    });
  }

  return true;
}

function pickHealthyEndpoint(pool, excluded = new Set()) {
  if (!pool.length) return null;

  const now = Date.now();
  const startIndex = endpointCursor % pool.length;

  for (let offset = 0; offset < pool.length; offset += 1) {
    const index = (startIndex + offset) % pool.length;
    const candidate = pool[index];
    if (excluded.has(candidate)) continue;
    if (getCooldownRemainingMs(candidate, now) > 0) continue;

    endpointCursor = (index + 1) % pool.length;
    return {
      rpcUrl: candidate,
      usedFallbackEndpoint: index !== startIndex,
    };
  }

  return null;
}

function selectArcRpcUrl(label = 'arc_rpc', excluded = new Set()) {
  const pool = getArcRpcUrlPool().map((entry) => normalizeRpcUrl(entry));
  if (pool.length === 0) {
    return {
      rpcUrl: normalizeRpcUrl(DEFAULT_ARC_RPC_URL),
      usedFallbackEndpoint: false,
      unavailable: false,
    };
  }

  const selected = pickHealthyEndpoint(pool, excluded);
  if (!selected) {
    logWithThrottle({
      level: 'warn',
      kind: 'all_cooling',
      label,
      endpoint: 'pool',
      errorCode: 'cooldown',
      message: `[ARC_RPC] all endpoints cooling down label=${label} fallback=true`,
    });

    return {
      rpcUrl: null,
      usedFallbackEndpoint: false,
      unavailable: true,
    };
  }

  if (pool.length > 1 && selected.usedFallbackEndpoint) {
    logWithThrottle({
      level: 'info',
      kind: 'using_fallback',
      label,
      endpoint: getEndpointLabel(selected.rpcUrl),
      errorCode: 'fallback',
      message: `[ARC_RPC] using fallback endpoint label=${label}`,
    });
  }

  return {
    rpcUrl: selected.rpcUrl,
    usedFallbackEndpoint: selected.usedFallbackEndpoint,
    unavailable: false,
  };
}

function getHealthyArcRpcUrl(label = 'arc_rpc') {
  const selected = selectArcRpcUrl(label);
  return selected.rpcUrl || null;
}

function getHealthyArcRpcProvider(label = 'arc_rpc') {
  const rpcUrl = getHealthyArcRpcUrl(label);
  if (!rpcUrl) {
    return null;
  }
  return createArcRpcProvider(rpcUrl);
}

async function safeArcRpcCall(label, fn, fallbackValue) {
  if (typeof fn !== 'function') {
    throw new TypeError('safeArcRpcCall requires a callback function');
  }

  const pool = getArcRpcUrlPool().map((entry) => normalizeRpcUrl(entry));
  const attempts = Math.max(pool.length, 1);
  const excluded = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const selected = selectArcRpcUrl(label, excluded);
    if (!selected.rpcUrl) {
      break;
    }

    const rpcUrl = selected.rpcUrl;
    excluded.add(rpcUrl);
    const provider = createArcRpcProvider(rpcUrl);

    try {
      return await fn(provider, rpcUrl);
    } catch (error) {
      lastError = error;

      if (isArcRpcBatchLimitError(error) || isArcRpcRateLimitError(error)) {
        markArcRpcEndpointUnhealthy(rpcUrl, error, label);
        continue;
      }

      if (isArcRpcTransientError(error) && excluded.size < pool.length) {
        logWithThrottle({
          level: 'warn',
          kind: 'transient',
          label,
          endpoint: getEndpointLabel(rpcUrl),
          errorCode: String(error?.code || 'transient'),
          message: `[ARC_RPC] rpc transient error label=${label} endpoint=${getEndpointLabel(rpcUrl)} retrying_next=true`,
        });
        continue;
      }

      break;
    }
  }

  if (arguments.length >= 3) {
    if (lastError) {
      if (isArcRpcRateLimitError(lastError) || isArcRpcBatchLimitError(lastError)) {
        logWithThrottle({
          level: 'warn',
          kind: 'no_healthy',
          label,
          endpoint: 'pool',
          errorCode: String(lastError?.code || lastError?.info?.responseStatus || 'rate_limit'),
          message: `[ARC_RPC] no healthy endpoint available label=${label} fallback=true`,
        });
      } else {
        logWithThrottle({
          level: 'error',
          kind: 'rpc_failed',
          label,
          endpoint: 'pool',
          errorCode: String(lastError?.code || 'unknown'),
          message: `[ARC_RPC] rpc call failed label=${label} fallback=true error=${lastError?.message || lastError}`,
        });
      }
    }

    return fallbackValue;
  }

  throw lastError || new Error(`[ARC_RPC] safeArcRpcCall failed label=${label}`);
}

function getArcRpcHealthSnapshot() {
  const now = Date.now();
  const endpoints = getArcRpcUrlPool().map((rpcUrl) => {
    const normalized = normalizeRpcUrl(rpcUrl);
    const state = getEndpointState(normalized);
    const cooldownRemainingMs = getCooldownRemainingMs(normalized, now);

    return {
      endpoint: getEndpointLabel(normalized),
      maskedUrl: maskRpcUrl(normalized),
      healthy: cooldownRemainingMs <= 0,
      cooldownRemainingMs,
      lastErrorCode: state.lastErrorCode,
      lastErrorReason: state.lastErrorReason,
      lastErrorAt: state.lastErrorAt,
    };
  });

  const suppressedLogCounts = {};
  for (const [key, state] of throttledLogState.entries()) {
    if (state.suppressed > 0) {
      suppressedLogCounts[key] = state.suppressed;
    }
  }

  return {
    endpointCount: endpoints.length,
    healthyCount: endpoints.filter((entry) => entry.healthy).length,
    coolingDownCount: endpoints.filter((entry) => !entry.healthy).length,
    endpoints,
    suppressedLogCounts,
  };
}

function clearArcRpcProviderCache() {
  providerCache.clear();
  endpointHealthState.clear();
  throttledLogState.clear();
  endpointCursor = 0;
}

module.exports = {
  ARC_TESTNET_NETWORK,
  createArcRpcProvider,
  getArcRpcUrl,
  getHealthyArcRpcUrl,
  getHealthyArcRpcProvider,
  safeArcRpcCall,
  isArcRpcRateLimitError,
  markArcRpcEndpointUnhealthy,
  getArcRpcHealthSnapshot,
  clearArcRpcProviderCache,
};
