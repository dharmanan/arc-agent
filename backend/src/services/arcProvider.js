'use strict';

const { ethers } = require('ethers');

const DEFAULT_ARC_RPC_URL = 'https://rpc.testnet.arc.network';
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 120000;

const ARC_TESTNET_NETWORK = Object.freeze({
  chainId: 5042002,
  name: 'Arc Testnet',
});
const ARC_TESTNET_STATIC_NETWORK = ethers.Network.from(ARC_TESTNET_NETWORK);

const providerCache = new Map();
const endpointCooldownUntil = new Map();

let endpointCursor = 0;

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function createArcRpcProvider(rpcUrl = getArcRpcUrl()) {
  const normalizedRpcUrl = normalizeRpcUrl(rpcUrl);
  let provider = providerCache.get(normalizedRpcUrl);

  if (!provider) {
    provider = new ethers.JsonRpcProvider(
      normalizedRpcUrl,
      ARC_TESTNET_NETWORK,
      { staticNetwork: ARC_TESTNET_STATIC_NETWORK },
    );
    providerCache.set(normalizedRpcUrl, provider);
  }

  return provider;
}

function getCooldownMs() {
  return readPositiveIntegerEnv('ARC_RPC_RATE_LIMIT_COOLDOWN_MS', DEFAULT_RATE_LIMIT_COOLDOWN_MS);
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

function isArcRpcRateLimitError(error) {
  const text = [
    error?.message,
    error?.shortMessage,
    error?.code,
    error?.info?.responseStatus,
    error?.info?.responseBody,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return text.includes('429')
    || text.includes('too many requests')
    || text.includes('rate limit')
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

  const text = [
    error?.message,
    error?.shortMessage,
    error?.error?.message,
    error?.info?.error?.message,
    error?.cause?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return text.includes('timeout')
    || text.includes('temporarily unavailable')
    || text.includes('socket hang up')
    || text.includes('connection reset')
    || text.includes('service unavailable')
    || text.includes('bad gateway')
    || text.includes('gateway timeout')
    || text.includes('503')
    || text.includes('504');
}

function getCooldownRemainingMs(rpcUrl, now = Date.now()) {
  const until = Number(endpointCooldownUntil.get(normalizeRpcUrl(rpcUrl)) || 0);
  return Math.max(until - now, 0);
}

function markArcRpcEndpointUnhealthy(rpcUrl, error, label = 'unknown') {
  if (!isArcRpcRateLimitError(error)) {
    return false;
  }

  const cooldownMs = getCooldownMs();
  const now = Date.now();
  const targets = rpcUrl
    ? [normalizeRpcUrl(rpcUrl)]
    : getArcRpcUrlPool().map((entry) => normalizeRpcUrl(entry));

  for (const endpoint of [...new Set(targets)]) {
    endpointCooldownUntil.set(endpoint, now + cooldownMs);
    console.warn(
      `[ARC_RPC] rate limited endpoint=${getEndpointLabel(endpoint)} label=${label} cooldown=${Math.round(cooldownMs / 1000)}s`,
    );
  }

  return true;
}

function selectArcRpcUrl(label = 'arc_rpc', excluded = new Set()) {
  const pool = getArcRpcUrlPool().map((entry) => normalizeRpcUrl(entry));

  if (pool.length === 0) {
    return normalizeRpcUrl(DEFAULT_ARC_RPC_URL);
  }

  const now = Date.now();
  const startIndex = endpointCursor % pool.length;
  let selectedIndex = -1;

  for (let offset = 0; offset < pool.length; offset += 1) {
    const index = (startIndex + offset) % pool.length;
    const candidate = pool[index];
    if (excluded.has(candidate)) continue;
    if (getCooldownRemainingMs(candidate, now) > 0) continue;
    selectedIndex = index;
    break;
  }

  let fallbackUsed = false;
  if (selectedIndex < 0) {
    for (let offset = 0; offset < pool.length; offset += 1) {
      const index = (startIndex + offset) % pool.length;
      const candidate = pool[index];
      if (excluded.has(candidate)) continue;
      selectedIndex = index;
      fallbackUsed = true;
      console.warn(`[ARC_RPC] all endpoints cooling down label=${label} fallback=true`);
      break;
    }
  }

  if (selectedIndex < 0) {
    selectedIndex = startIndex;
    fallbackUsed = true;
    console.warn(`[ARC_RPC] no healthy endpoint available label=${label} fallback=true`);
  }

  if (pool.length > 1 && (fallbackUsed || selectedIndex !== startIndex)) {
    console.info(`[ARC_RPC] using fallback endpoint label=${label}`);
  }

  endpointCursor = (selectedIndex + 1) % pool.length;
  return pool[selectedIndex];
}

function getHealthyArcRpcProvider(label = 'arc_rpc') {
  const rpcUrl = selectArcRpcUrl(label);
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
    const rpcUrl = selectArcRpcUrl(label, excluded);
    excluded.add(rpcUrl);
    const provider = createArcRpcProvider(rpcUrl);

    try {
      return await fn(provider, rpcUrl);
    } catch (error) {
      lastError = error;

      if (isArcRpcRateLimitError(error)) {
        markArcRpcEndpointUnhealthy(rpcUrl, error, label);
        continue;
      }

      if (isArcRpcTransientError(error) && excluded.size < pool.length) {
        continue;
      }

      break;
    }
  }

  if (arguments.length >= 3) {
    if (lastError) {
      if (isArcRpcRateLimitError(lastError)) {
        console.warn(`[ARC_RPC] no healthy endpoint available label=${label} fallback=true`);
      } else {
        console.error(`[ARC_RPC] rpc call failed label=${label} fallback=true`, lastError?.message || lastError);
      }
    }
    return fallbackValue;
  }

  throw lastError || new Error(`[ARC_RPC] safeArcRpcCall failed label=${label}`);
}

function getArcRpcHealthSnapshot() {
  const now = Date.now();

  return getArcRpcUrlPool().map((rpcUrl) => {
    const normalized = normalizeRpcUrl(rpcUrl);
    const cooldownRemainingMs = getCooldownRemainingMs(normalized, now);

    return {
      endpoint: getEndpointLabel(normalized),
      maskedUrl: maskRpcUrl(normalized),
      healthy: cooldownRemainingMs <= 0,
      cooldownRemainingMs,
    };
  });
}

function clearArcRpcProviderCache() {
  providerCache.clear();
  endpointCooldownUntil.clear();
  endpointCursor = 0;
}

module.exports = {
  ARC_TESTNET_NETWORK,
  createArcRpcProvider,
  getArcRpcUrl,
  getHealthyArcRpcProvider,
  safeArcRpcCall,
  isArcRpcRateLimitError,
  markArcRpcEndpointUnhealthy,
  getArcRpcHealthSnapshot,
  clearArcRpcProviderCache,
};
