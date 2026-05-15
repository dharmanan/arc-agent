'use strict';

const DEFAULT_GATEWAY_URL = 'https://gateway-api-testnet.circle.com';
const DEFAULT_GATEWAY_NETWORKS = ['eip155:5042002'];
const DEFAULT_AUTH_MODE = 'none';
const SUPPORTED_AUTH_MODES = new Set(['none', 'bearer', 'static-json']);

function parseNetworks(rawValue) {
  if (!rawValue || !rawValue.trim()) return [...DEFAULT_GATEWAY_NETWORKS];

  const values = rawValue
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : [...DEFAULT_GATEWAY_NETWORKS];
}

function parseHeaderJson(envName) {
  const rawValue = process.env[envName];
  if (!rawValue || !rawValue.trim()) return {};

  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }

    return Object.entries(parsed).reduce((headers, [key, value]) => {
      if (typeof value === 'string' && value.trim()) {
        headers[key] = value;
      }
      return headers;
    }, {});
  } catch (error) {
    throw new Error(`${envName} is invalid: ${error.message}`);
  }
}

function resolveAuthMode() {
  const rawMode = (process.env.CIRCLE_GATEWAY_AUTH_MODE || DEFAULT_AUTH_MODE).trim().toLowerCase();
  if (!SUPPORTED_AUTH_MODES.has(rawMode)) {
    throw new Error(
      `CIRCLE_GATEWAY_AUTH_MODE must be one of: ${Array.from(SUPPORTED_AUTH_MODES).join(', ')}`,
    );
  }
  return rawMode;
}

function buildBearerHeaders() {
  const token = (process.env.CIRCLE_GATEWAY_AUTH_TOKEN || '').trim();
  if (!token) {
    throw new Error('CIRCLE_GATEWAY_AUTH_TOKEN is required when CIRCLE_GATEWAY_AUTH_MODE=bearer');
  }

  const scheme = (process.env.CIRCLE_GATEWAY_AUTH_SCHEME || 'Bearer').trim() || 'Bearer';
  return { Authorization: `${scheme} ${token}` };
}

function buildStaticHeaders() {
  return {
    verify: parseHeaderJson('CIRCLE_GATEWAY_VERIFY_HEADERS_JSON'),
    settle: parseHeaderJson('CIRCLE_GATEWAY_SETTLE_HEADERS_JSON'),
    supported: parseHeaderJson('CIRCLE_GATEWAY_SUPPORTED_HEADERS_JSON'),
  };
}

function getGatewayConfig() {
  const authMode = resolveAuthMode();
  const url = (process.env.CIRCLE_GATEWAY_URL || DEFAULT_GATEWAY_URL).trim() || DEFAULT_GATEWAY_URL;
  const networks = parseNetworks(process.env.CIRCLE_GATEWAY_NETWORKS || '');
  const requestTimeoutMs = Math.max(parseInt(process.env.CIRCLE_GATEWAY_TIMEOUT_MS || '15000', 10) || 15000, 1000);

  return {
    url,
    networks,
    authMode,
    requestTimeoutMs,
    authRequired: authMode !== 'none',
  };
}

function createGatewayAuthHeadersFactory(config = getGatewayConfig()) {
  if (config.authMode === 'none') return undefined;

  if (config.authMode === 'bearer') {
    const authorization = buildBearerHeaders();
    return async () => ({
      verify: { ...authorization },
      settle: { ...authorization },
      supported: { ...authorization },
    });
  }

  const staticHeaders = buildStaticHeaders();
  return async () => ({
    verify: { ...staticHeaders.verify },
    settle: { ...staticHeaders.settle },
    supported: { ...staticHeaders.supported },
  });
}

function getGatewayConfigSummary() {
  const config = getGatewayConfig();
  return {
    url: config.url,
    networks: config.networks,
    authMode: config.authMode,
    authRequired: config.authRequired,
    authConfigured: config.authMode === 'none'
      ? true
      : config.authMode === 'bearer'
        ? Boolean((process.env.CIRCLE_GATEWAY_AUTH_TOKEN || '').trim())
        : true,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

module.exports = {
  DEFAULT_GATEWAY_NETWORKS,
  DEFAULT_GATEWAY_URL,
  createGatewayAuthHeadersFactory,
  getGatewayConfig,
  getGatewayConfigSummary,
};