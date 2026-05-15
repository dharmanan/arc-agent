'use strict';

const { BatchFacilitatorClient } = require('@circle-fin/x402-batching/server');
const {
  createGatewayAuthHeadersFactory,
  getGatewayConfig,
  getGatewayConfigSummary,
} = require('./gatewayConfig');
const { logGateway } = require('./logger');

const DEFAULT_SUPPORTED_CACHE_MS = 5 * 60 * 1000;

let facilitatorClient = null;
let facilitatorFingerprint = null;
let supportedCache = {
  value: null,
  loadedAt: 0,
  error: null,
};

function getCacheTtlMs() {
  return Math.max(parseInt(process.env.CIRCLE_GATEWAY_SUPPORTED_CACHE_MS || `${DEFAULT_SUPPORTED_CACHE_MS}`, 10) || DEFAULT_SUPPORTED_CACHE_MS, 1000);
}

function getConfigFingerprint(config) {
  return JSON.stringify({
    url: config.url,
    networks: config.networks,
    authMode: config.authMode,
  });
}

function resetSupportedCache() {
  supportedCache = {
    value: null,
    loadedAt: 0,
    error: null,
  };
}

function normalizeGatewayError(error) {
  const status = error?.status || error?.response?.status || null;
  const message = error?.message || 'Unknown Circle Gateway error';
  const normalized = new Error(message);

  normalized.status = status;
  normalized.code = status === 401 || status === 403
    ? 'GATEWAY_AUTH_REJECTED'
    : 'GATEWAY_REQUEST_FAILED';

  return normalized;
}

function getGatewayFacilitatorClient() {
  const config = getGatewayConfig();
  const fingerprint = getConfigFingerprint(config);

  if (!facilitatorClient || facilitatorFingerprint !== fingerprint) {
    facilitatorClient = new BatchFacilitatorClient({
      url: config.url,
      createAuthHeaders: createGatewayAuthHeadersFactory(config),
    });
    facilitatorFingerprint = fingerprint;
    resetSupportedCache();
    logGateway('info', 'Facilitator client refreshed', {
      authMode: config.authMode,
      networkCount: Array.isArray(config.networks) ? config.networks.length : 0,
      url: config.url,
    });
  }

  return facilitatorClient;
}

async function getGatewaySupported(options = {}) {
  const { forceRefresh = false } = options;
  const now = Date.now();
  const ttlMs = getCacheTtlMs();

  if (!forceRefresh && supportedCache.value && (now - supportedCache.loadedAt) < ttlMs) {
    return supportedCache.value;
  }

  try {
    const client = getGatewayFacilitatorClient();
    const supported = await client.getSupported();
    supportedCache = {
      value: supported,
      loadedAt: now,
      error: null,
    };
    return supported;
  } catch (error) {
    const normalized = normalizeGatewayError(error);
    supportedCache = {
      value: null,
      loadedAt: now,
      error: {
        code: normalized.code,
        status: normalized.status || null,
        message: normalized.message,
        at: new Date(now).toISOString(),
      },
    };
    logGateway('warn', 'Supported network fetch failed', {
      code: normalized.code,
      message: normalized.message,
      status: normalized.status || null,
      url: getGatewayConfig().url,
    });
    throw normalized;
  }
}

function getGatewayFacilitatorSummary() {
  const configSummary = getGatewayConfigSummary();
  return {
    ...configSummary,
    cacheTtlMs: getCacheTtlMs(),
    supportedCache: {
      loadedAt: supportedCache.loadedAt ? new Date(supportedCache.loadedAt).toISOString() : null,
      ready: Boolean(supportedCache.value),
      networkCount: Array.isArray(supportedCache.value?.kinds) ? supportedCache.value.kinds.length : 0,
      lastError: supportedCache.error,
    },
  };
}

module.exports = {
  getGatewayFacilitatorClient,
  getGatewayFacilitatorSummary,
  getGatewaySupported,
  normalizeGatewayError,
  resetSupportedCache,
};