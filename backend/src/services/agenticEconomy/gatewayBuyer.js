'use strict';

const { ethers } = require('ethers');
const { GatewayClient } = require('@circle-fin/x402-batching/client');
const { decrypt } = require('../cryptoService');
const { runProtectedWrite } = require('../txSecurityService');
const {
  getHealthyArcRpcUrl,
  safeArcRpcCall,
  isArcRpcRateLimitError,
  getArcRpcTrafficClassCooldownState,
} = require('../arcProvider');
const { logGateway } = require('./logger');

const DEFAULT_GATEWAY_TRANSFER_MAX_FEE_USDC = process.env.GATEWAY_TRANSFER_MAX_FEE_USDC || '0.005';
const DEFAULT_GATEWAY_PAY_RETRY_ATTEMPTS = process.env.GATEWAY_PAY_RETRY_ATTEMPTS || '2';
const DEFAULT_GATEWAY_PAY_RETRY_BASE_DELAY_MS = process.env.GATEWAY_PAY_RETRY_BASE_DELAY_MS || '750';
const DEFAULT_GATEWAY_WARM_MIN_AVAILABLE_USDC = process.env.GATEWAY_WARM_MIN_AVAILABLE_USDC || '1';
const DEFAULT_GATEWAY_WARM_TARGET_USDC = process.env.GATEWAY_WARM_TARGET_USDC || '3';
const DEFAULT_GATEWAY_TX_LOCK_TTL_SEC = readPositiveIntegerEnv('GATEWAY_TX_LOCK_TTL_SEC', 180);
const DEFAULT_GATEWAY_AUTO_WARM_LOCK_WAIT_MS = readNonNegativeIntegerEnv('GATEWAY_AUTO_WARM_LOCK_WAIT_MS', 0);
const DEFAULT_GATEWAY_SERVICE_RATE_LIMIT_COOLDOWN_MS = readPositiveIntegerEnv('GATEWAY_SERVICE_RATE_LIMIT_COOLDOWN_MS', 900000);
const ARC_RPC_COOLDOWN_CODE = 'ARC_RPC_COOLDOWN';
const ARC_RPC_COOLDOWN_MESSAGE = 'Arc RPC is cooling down';
const GATEWAY_SERVICE_RATE_LIMITED_CODE = 'GATEWAY_SERVICE_RATE_LIMITED';
const GATEWAY_DEFERRED_UNKNOWN_CODE = 'GATEWAY_DEFERRED_UNKNOWN';
const GATEWAY_TRAFFIC_CLASS_DEFAULT = 'gateway';
const GATEWAY_TRAFFIC_CLASS_READ = 'gateway_read';
const GATEWAY_TRAFFIC_CLASS_WRITE = 'gateway_write'; // legacy compatibility
const GATEWAY_TRAFFIC_CLASS_DEPOSIT = 'gateway_deposit';
const GATEWAY_TRAFFIC_CLASS_PAYMENT = 'gateway_payment';

const gatewayServiceCooldownByTrafficClass = new Map();

const GATEWAY_CHAIN_MAP = {
  'Arc Testnet': {
    chain: 'arcTestnet',
    rpcUrl: process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network',
  },
  'Sepolia': {
    chain: 'sepolia',
    rpcUrl: process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  'Base Sepolia': {
    chain: 'baseSepolia',
    rpcUrl: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
  },
  'Optimism Sepolia': {
    chain: 'optimismSepolia',
    rpcUrl: process.env.OPTIMISM_SEPOLIA_RPC || 'https://sepolia.optimism.io',
  },
  'Arbitrum Sepolia': {
    chain: 'arbitrumSepolia',
    rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc',
  },
};

function normalizeUsdcAmount(amountUsdc) {
  if (typeof amountUsdc === 'string') {
    const trimmed = amountUsdc.trim();
    if (!trimmed) throw new Error('amountUsdc is required');
    return trimmed;
  }

  if (typeof amountUsdc !== 'number' || !Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error('amountUsdc must be a positive number or decimal string');
  }

  return amountUsdc
    .toFixed(6)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeGatewayWalletAddress(value) {
  if (!value) return null;
  try {
    return ethers.getAddress(String(value));
  } catch {
    return null;
  }
}

function resolveAgentGatewayWalletAddress(agent, fallbackWalletAddress = null) {
  const explicitAddress = normalizeGatewayWalletAddress(
    fallbackWalletAddress || agent?.wallet_address || agent?.walletAddress,
  );
  if (explicitAddress) return explicitAddress;

  const privateKey = getAgentGatewayPrivateKey(agent);
  return new ethers.Wallet(privateKey).address;
}

async function runGatewayProtectedWrite({
  chainName = 'Arc Testnet',
  walletAddress = null,
  operation = 'gateway_write',
  replayFingerprint = null,
  waitForLockMs,
  lockTtlSec = DEFAULT_GATEWAY_TX_LOCK_TTL_SEC,
  protectedWrite = true,
}, execute) {
  const normalizedWalletAddress = normalizeGatewayWalletAddress(walletAddress);
  if (!protectedWrite || !normalizedWalletAddress) {
    return execute();
  }

  return runProtectedWrite({
    chainName,
    walletAddress: normalizedWalletAddress,
    operation,
    replayFingerprint,
    waitForLockMs,
    lockTtlSec,
  }, execute);
}

function getAtomicUsdc(amountUsdc) {
  return ethers.parseUnits(normalizeUsdcAmount(amountUsdc), 6);
}

function resolveGatewayTransferMaxFee(maxFee) {
  return normalizeUsdcAmount(maxFee == null ? DEFAULT_GATEWAY_TRANSFER_MAX_FEE_USDC : maxFee);
}

function resolveGatewayPayRetryAttempts(value) {
  const parsed = Number.parseInt(value == null ? DEFAULT_GATEWAY_PAY_RETRY_ATTEMPTS : value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.parseInt(DEFAULT_GATEWAY_PAY_RETRY_ATTEMPTS, 10);
}

function resolveGatewayPayRetryBaseDelayMs(value) {
  const parsed = Number.parseInt(value == null ? DEFAULT_GATEWAY_PAY_RETRY_BASE_DELAY_MS : value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.parseInt(DEFAULT_GATEWAY_PAY_RETRY_BASE_DELAY_MS, 10);
}

function resolveGatewayChainConfig(chainName = 'Arc Testnet') {
  const config = GATEWAY_CHAIN_MAP[chainName];
  if (!config) {
    throw new Error(`Unsupported Circle Gateway chain mapping: ${chainName}`);
  }

  return config;
}

function isArcTestnetChain(chainName = 'Arc Testnet') {
  return String(chainName || '').trim().toLowerCase() === 'arc testnet';
}

function extractGatewayErrorText(error) {
  return [
    error?.message,
    error?.shortMessage,
    error?.code,
    error?.cause?.message,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getGatewayOperationLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'gateway_operation';
}

function getRpcEndpointLabel(rpcUrl) {
  try {
    const hostname = new URL(String(rpcUrl || '').trim()).hostname;
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length === 0) return 'unknown';
    if (parts[0] === 'rpc' && parts.length > 1) return parts[1];
    return parts[0];
  } catch {
    return 'unknown';
  }
}

function normalizeGatewayTrafficClass(trafficClass) {
  const normalized = String(trafficClass || '').trim().toLowerCase();
  if (
    normalized === GATEWAY_TRAFFIC_CLASS_READ
    || normalized === GATEWAY_TRAFFIC_CLASS_DEPOSIT
    || normalized === GATEWAY_TRAFFIC_CLASS_PAYMENT
    || normalized === GATEWAY_TRAFFIC_CLASS_WRITE
    || normalized === GATEWAY_TRAFFIC_CLASS_DEFAULT
  ) {
    return normalized;
  }
  return GATEWAY_TRAFFIC_CLASS_DEFAULT;
}

function parseErrorHttpStatus(error) {
  const directStatus = Number.parseInt(String(error?.statusCode || error?.status || error?.httpStatus || ''), 10);
  if (Number.isInteger(directStatus) && directStatus >= 100 && directStatus <= 599) {
    return directStatus;
  }

  const text = extractGatewayErrorText(error);
  const statusMatch = text.match(/\b(4\d\d|5\d\d)\b/);
  if (!statusMatch) return null;

  const parsed = Number.parseInt(statusMatch[1], 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseErrorRpcCode(error) {
  if (error?.code == null) return null;
  return String(error.code).trim() || null;
}

function inferGatewayFailureSource(error, fallback = 'unknown') {
  const text = extractGatewayErrorText(error);

  // An explicit negative provenance marker must win. Gateway SDK/service errors
  // often include an RPC URL or the word "rpc" even when the failure came from
  // Circle/facilitator HTTP. Those errors must never poison Arc endpoint health.
  if (error?.rpcEndpointProven === false || error?.isArcRpcEndpointError === false) {
    return fallback;
  }

  if (
    text.includes('gateway api balance fetch failed')
    || text.includes('gateway api error')
    || text.includes('payment failed:')
  ) {
    return 'gateway_service';
  }

  if (
    text.includes('payment-required')
    || text.includes('protected resource')
    || text.includes('facilitator')
  ) {
    return 'facilitator_http';
  }

  const hasStructuredRpcEvidence = Boolean(
    error?.info?.responseStatus
    || error?.info?.responseBody
    || error?.info?.payload
    || error?.payload?.jsonrpc
    || error?.error?.code != null
  );

  if (
    hasStructuredRpcEvidence
    || text.includes('json-rpc')
    || text.includes('could not coalesce')
    || text.includes('batch of more than')
    || text.includes('-32603')
    || text.includes('-32000')
  ) {
    return 'json_rpc';
  }

  return fallback;
}

function annotateGatewayFailure(error, metadata = {}) {
  if (!error || typeof error !== 'object') return error;

  const operation = getGatewayOperationLabel(metadata.operation || error.operation);
  const fallbackSource = metadata.failureSource || 'unknown';
  const source = String(error.failureSource || '').trim().toLowerCase() || inferGatewayFailureSource(error, fallbackSource);
  const stage = String(metadata.failureStage || error.failureStage || '').trim() || null;
  const httpStatus = parseErrorHttpStatus(error);
  const rpcCode = parseErrorRpcCode(error);
  const trafficClass = normalizeGatewayTrafficClass(metadata.trafficClass || error.trafficClass || GATEWAY_TRAFFIC_CLASS_DEFAULT);
  const rpcEndpointLabel = metadata.rpcUrl ? getRpcEndpointLabel(metadata.rpcUrl) : (error.rpcEndpointLabel || null);
  const rpcEndpointProven = source === 'json_rpc' || source === 'rpc_endpoint' || source === 'rpc';

  error.operation = operation;
  error.failureStage = stage;
  error.failureSource = source;
  error.trafficClass = trafficClass;
  error.rpcEndpointLabel = rpcEndpointProven ? (rpcEndpointLabel || error.rpcEndpointLabel || 'unknown') : null;
  error.rpcEndpointProven = rpcEndpointProven;
  error.isArcRpcEndpointError = rpcEndpointProven;

  if (httpStatus != null) {
    error.httpStatus = httpStatus;
  }
  if (rpcCode != null) {
    error.rpcCode = rpcCode;
  }

  const mergedMeta = {
    ...(error.meta && typeof error.meta === 'object' ? error.meta : {}),
    operation,
    failureStage: stage,
    failureSource: source,
    rpcEndpointLabel: error.rpcEndpointLabel,
    rpcEndpointProven,
    httpStatus: error.httpStatus ?? null,
    rpcCode: error.rpcCode ?? null,
    trafficClass,
  };

  error.meta = mergedMeta;
  return error;
}

function isGatewayServiceFailureSource(error) {
  const source = String(error?.failureSource || error?.meta?.failureSource || '').trim().toLowerCase();
  return source === 'gateway_service' || source === 'facilitator_http';
}

function isGatewayServiceRateLimitError(error) {
  const status = parseErrorHttpStatus(error);
  const text = extractGatewayErrorText(error);

  if (!isGatewayServiceFailureSource(error)) {
    return false;
  }

  return status === 429
    || text.includes('429')
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('request limit reached');
}

function getGatewayServiceCooldownState(trafficClass, now = Date.now()) {
  const normalizedClass = normalizeGatewayTrafficClass(trafficClass);
  const cooldownUntil = Number(gatewayServiceCooldownByTrafficClass.get(normalizedClass) || 0);
  const retryAfterMs = Number.isFinite(cooldownUntil) && cooldownUntil > now
    ? Math.max(cooldownUntil - now, 0)
    : 0;

  return {
    trafficClass: normalizedClass,
    active: retryAfterMs > 0,
    retryAfterMs: retryAfterMs > 0 ? retryAfterMs : null,
    retryAt: retryAfterMs > 0 ? new Date(now + retryAfterMs).toISOString() : null,
  };
}

function markGatewayServiceRateLimited(trafficClass, retryAfterMs = null, now = Date.now()) {
  const normalizedClass = normalizeGatewayTrafficClass(trafficClass);
  const normalizedRetryAfterMs = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0
    ? Number(retryAfterMs)
    : DEFAULT_GATEWAY_SERVICE_RATE_LIMIT_COOLDOWN_MS;

  gatewayServiceCooldownByTrafficClass.set(normalizedClass, now + normalizedRetryAfterMs);
  return getGatewayServiceCooldownState(normalizedClass, now);
}

function isGatewayRateLimitError(error) {
  if (isArcRpcRateLimitError(error)) {
    return true;
  }

  const status = Number.parseInt(String(error?.statusCode || error?.status || ''), 10);
  if (status === 429) {
    return true;
  }

  const text = extractGatewayErrorText(error);
  return text.includes('request limit reached')
    || text.includes('rate limit')
    || text.includes('too many requests')
    || text.includes('exceeded maximum retry limit')
    || text.includes('batch of more than');
}

function isGatewayTransientRpcError(error) {
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

  const status = Number.parseInt(String(error?.statusCode || error?.status || ''), 10);
  if ([408, 425, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const text = extractGatewayErrorText(error);
  return text.includes('timeout')
    || text.includes('temporarily unavailable')
    || text.includes('socket hang up')
    || text.includes('connection reset')
    || text.includes('service unavailable')
    || text.includes('bad gateway')
    || text.includes('gateway timeout');
}

function buildArcRpcCooldownError(error = null, chainName = 'Arc Testnet', options = {}) {
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || error?.trafficClass || GATEWAY_TRAFFIC_CLASS_DEFAULT);
  const operation = getGatewayOperationLabel(options.operation || error?.operation);
  const cooldownState = getArcRpcTrafficClassCooldownState(trafficClass);
  const cooldownError = new Error(ARC_RPC_COOLDOWN_MESSAGE);
  cooldownError.code = ARC_RPC_COOLDOWN_CODE;
  cooldownError.chainName = chainName;
  cooldownError.retryable = true;
  cooldownError.deferred = true;
  cooldownError.status = 'deferred';
  cooldownError.statusCode = 503;
  cooldownError.operation = operation;
  cooldownError.trafficClass = trafficClass;
  cooldownError.failureStage = options.failureStage || error?.failureStage || null;
  cooldownError.failureSource = 'json_rpc';
  cooldownError.rpcEndpointLabel = error?.rpcEndpointLabel || null;
  cooldownError.rpcEndpointProven = true;
  cooldownError.isArcRpcEndpointError = true;
  cooldownError.httpStatus = parseErrorHttpStatus(error);
  cooldownError.rpcCode = parseErrorRpcCode(error);
  cooldownError.retryAfterMs = cooldownState.active ? cooldownState.retryAfterMs : null;
  cooldownError.retryAt = cooldownState.active ? cooldownState.retryAt : null;
  if (error) {
    cooldownError.cause = error;
    cooldownError.causeMessage = error.message || String(error);
  }
  cooldownError.meta = {
    operation,
    failureStage: cooldownError.failureStage,
    failureSource: cooldownError.failureSource,
    trafficClass,
    rpcEndpointLabel: cooldownError.rpcEndpointLabel,
    rpcEndpointProven: true,
    httpStatus: cooldownError.httpStatus,
    rpcCode: cooldownError.rpcCode,
    retryAfterMs: cooldownError.retryAfterMs,
    retryAt: cooldownError.retryAt,
  };
  return cooldownError;
}

function buildGatewayServiceRateLimitedError(error = null, chainName = 'Arc Testnet', options = {}) {
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || error?.trafficClass || GATEWAY_TRAFFIC_CLASS_DEFAULT);
  const operation = getGatewayOperationLabel(options.operation || error?.operation);
  const cooldownState = markGatewayServiceRateLimited(trafficClass, options.retryAfterMs ?? error?.retryAfterMs ?? null);

  const deferredError = new Error('Gateway service is temporarily rate limited');
  deferredError.code = GATEWAY_SERVICE_RATE_LIMITED_CODE;
  deferredError.chainName = chainName;
  deferredError.retryable = true;
  deferredError.deferred = true;
  deferredError.status = 'deferred';
  deferredError.statusCode = 503;
  deferredError.operation = operation;
  deferredError.trafficClass = trafficClass;
  deferredError.failureStage = options.failureStage || error?.failureStage || null;
  deferredError.failureSource = String(options.failureSource || error?.failureSource || 'gateway_service').trim().toLowerCase();
  deferredError.rpcEndpointLabel = null;
  deferredError.rpcEndpointProven = false;
  deferredError.isArcRpcEndpointError = false;
  deferredError.httpStatus = parseErrorHttpStatus(error);
  deferredError.rpcCode = parseErrorRpcCode(error);
  deferredError.retryAfterMs = cooldownState.retryAfterMs;
  deferredError.retryAt = cooldownState.retryAt;

  if (error) {
    deferredError.cause = error;
    deferredError.causeMessage = error.message || String(error);
  }

  deferredError.meta = {
    operation,
    failureStage: deferredError.failureStage,
    failureSource: deferredError.failureSource,
    trafficClass,
    rpcEndpointLabel: null,
    rpcEndpointProven: false,
    httpStatus: deferredError.httpStatus,
    rpcCode: deferredError.rpcCode,
    retryAfterMs: deferredError.retryAfterMs,
    retryAt: deferredError.retryAt,
  };

  return deferredError;
}

function buildGatewayConservativeDeferredError(error = null, chainName = 'Arc Testnet', options = {}) {
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || error?.trafficClass || GATEWAY_TRAFFIC_CLASS_DEFAULT);
  const operation = getGatewayOperationLabel(options.operation || error?.operation);
  const deferredError = new Error('Gateway operation deferred because failure provenance is unknown');
  deferredError.code = GATEWAY_DEFERRED_UNKNOWN_CODE;
  deferredError.chainName = chainName;
  deferredError.retryable = true;
  deferredError.deferred = true;
  deferredError.status = 'deferred';
  deferredError.statusCode = 503;
  deferredError.operation = operation;
  deferredError.trafficClass = trafficClass;
  deferredError.failureStage = options.failureStage || error?.failureStage || null;
  deferredError.failureSource = 'unknown';
  deferredError.rpcEndpointLabel = null;
  deferredError.rpcEndpointProven = false;
  deferredError.isArcRpcEndpointError = false;
  deferredError.httpStatus = parseErrorHttpStatus(error);
  deferredError.rpcCode = parseErrorRpcCode(error);
  deferredError.retryAfterMs = null;
  deferredError.retryAt = null;

  if (error) {
    deferredError.cause = error;
    deferredError.causeMessage = error.message || String(error);
  }

  deferredError.meta = {
    operation,
    failureStage: deferredError.failureStage,
    failureSource: deferredError.failureSource,
    trafficClass,
    rpcEndpointLabel: null,
    rpcEndpointProven: false,
    httpStatus: deferredError.httpStatus,
    rpcCode: deferredError.rpcCode,
    retryAfterMs: null,
    retryAt: null,
  };

  return deferredError;
}

function toRetryableGatewayError(error, chainName = 'Arc Testnet', context = {}) {
  const trafficClass = normalizeGatewayTrafficClass(context.trafficClass || error?.trafficClass || GATEWAY_TRAFFIC_CLASS_DEFAULT);
  const operation = getGatewayOperationLabel(context.operation || error?.operation);
  const code = String(error?.code || '').trim().toUpperCase();

  if (code === ARC_RPC_COOLDOWN_CODE) {
    if (error.retryAfterMs == null || error.retryAt == null) {
      const cooldownState = getArcRpcTrafficClassCooldownState(trafficClass);
      error.retryAfterMs = cooldownState.active ? cooldownState.retryAfterMs : null;
      error.retryAt = cooldownState.active ? cooldownState.retryAt : null;
    }
    return error;
  }

  if (code === GATEWAY_SERVICE_RATE_LIMITED_CODE || code === GATEWAY_DEFERRED_UNKNOWN_CODE) {
    return error;
  }

  const message = String(error?.message || '').trim();
  if (isArcTestnetChain(chainName) && /safeArcRpcCall failed label=gateway_/i.test(message)) {
    return buildArcRpcCooldownError(error, chainName, {
      trafficClass,
      operation,
      failureStage: error?.failureStage || null,
    });
  }

  const annotatedError = annotateGatewayFailure(error, {
    operation,
    failureStage: error?.failureStage || null,
    failureSource: error?.failureSource || 'unknown',
    trafficClass,
  });

  if (isArcTestnetChain(chainName) && isGatewayServiceRateLimitError(annotatedError)) {
    return buildGatewayServiceRateLimitedError(annotatedError, chainName, {
      trafficClass,
      operation,
      failureStage: annotatedError.failureStage || null,
      failureSource: annotatedError.failureSource || 'gateway_service',
      retryAfterMs: annotatedError.retryAfterMs ?? null,
    });
  }

  if (isArcTestnetChain(chainName) && annotatedError.rpcEndpointProven && isGatewayRateLimitError(annotatedError)) {
    return buildArcRpcCooldownError(annotatedError, chainName, {
      trafficClass,
      operation,
      failureStage: annotatedError.failureStage || null,
    });
  }

  if (isArcTestnetChain(chainName) && annotatedError.rpcEndpointProven && isGatewayTransientRpcError(annotatedError)) {
    return buildArcRpcCooldownError(annotatedError, chainName, {
      trafficClass,
      operation,
      failureStage: annotatedError.failureStage || null,
    });
  }

  if (isArcTestnetChain(chainName) && (isGatewayRateLimitError(annotatedError) || isGatewayTransientRpcError(annotatedError))) {
    return buildGatewayConservativeDeferredError(annotatedError, chainName, {
      trafficClass,
      operation,
      failureStage: annotatedError.failureStage || null,
    });
  }

  return error;
}

async function withGatewayClientFailover(agent, options = {}, execute) {
  const chainName = options.chainName || 'Arc Testnet';
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_DEFAULT);
  const operation = getGatewayOperationLabel(options.operationLabel || options.operation || 'gateway_operation');

  const serviceCooldownState = getGatewayServiceCooldownState(trafficClass);
  if (serviceCooldownState.active) {
    throw buildGatewayServiceRateLimitedError(null, chainName, {
      trafficClass,
      operation,
      failureStage: 'gateway_service_cooldown',
      failureSource: 'gateway_service',
      retryAfterMs: serviceCooldownState.retryAfterMs,
    });
  }

  if (!isArcTestnetChain(chainName)) {
    const client = createGatewayClientForAgent(agent, {
      ...options,
      trafficClass,
      bypassHealthCheck: true,
    });
    return execute(client, options.rpcUrl || null);
  }

  return safeArcRpcCall(
    `gateway_${operation}`,
    async (_provider, rpcUrl) => {
      const client = createGatewayClientForAgent(agent, {
        ...options,
        rpcUrl,
        trafficClass,
        bypassHealthCheck: true,
      });

      try {
        return await execute(client, rpcUrl);
      } catch (error) {
        const annotatedError = annotateGatewayFailure(error, {
          operation,
          failureStage: error?.failureStage || 'gateway_operation',
          failureSource: error?.failureSource || 'unknown',
          trafficClass,
          rpcUrl,
        });

        if (isGatewayServiceRateLimitError(annotatedError)) {
          markGatewayServiceRateLimited(trafficClass, annotatedError.retryAfterMs ?? null);
        }

        throw annotatedError;
      }
    },
    {
      trafficClass,
      strictRpcProvenance: true,
    },
  );
}

function getAgentGatewayPrivateKey(agent) {
  const encrypted = agent?.private_key_encrypted || agent?.encrypted_private_key;
  if (!encrypted) {
    throw new Error('Agent private key is missing');
  }

  const privateKey = decrypt(encrypted);
  return privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
}

function createGatewayClientForAgent(agent, options = {}) {
  const { chainName = 'Arc Testnet' } = options;
  const trafficClass = options.trafficClass || GATEWAY_TRAFFIC_CLASS_DEFAULT;
  const chainConfig = resolveGatewayChainConfig(chainName);
  let rpcUrl = options.rpcUrl || chainConfig.rpcUrl;
  const bypassHealthCheck = options.bypassHealthCheck === true;

  if (isArcTestnetChain(chainName) && !bypassHealthCheck) {
    const healthyArcRpcUrl = getHealthyArcRpcUrl('gateway_client', { trafficClass });
    if (!healthyArcRpcUrl) {
      throw buildArcRpcCooldownError(null, chainName);
    }
    rpcUrl = healthyArcRpcUrl;
  }

  return new GatewayClient({
    chain: chainConfig.chain,
    privateKey: getAgentGatewayPrivateKey(agent),
    rpcUrl,
  });
}

async function runGatewayStage(stageOptions, execute) {
  try {
    return await execute();
  } catch (error) {
    throw annotateGatewayFailure(error, stageOptions);
  }
}

async function readGatewayBalances(client, address, options = {}) {
  const operation = getGatewayOperationLabel(options.operation || 'gateway_balances');
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_READ);
  let wallet;
  let gateway;
  try {
    wallet = await runGatewayStage({
      operation,
      failureStage: 'wallet_balance_read',
      failureSource: 'unknown',
      trafficClass,
      rpcUrl: options.rpcUrl,
    }, () => client.getUsdcBalance(address));

    gateway = await runGatewayStage({
      operation,
      failureStage: 'gateway_balance_read_api',
      failureSource: 'gateway_service',
      trafficClass,
      rpcUrl: options.rpcUrl,
    }, () => client.getGatewayBalance(address));
  } catch (error) {
    throw toRetryableGatewayError(error, options.chainName || 'Arc Testnet', {
      operation,
      trafficClass,
    });
  }

  return {
    wallet: {
      balance: wallet.balance,
      formatted: wallet.formatted,
      total: wallet.balance,
      available: wallet.balance,
      withdrawing: 0n,
      withdrawable: wallet.balance,
      formattedTotal: wallet.formatted,
      formattedAvailable: wallet.formatted,
      formattedWithdrawing: '0',
      formattedWithdrawable: wallet.formatted,
    },
    gateway,
  };
}

async function getAgentGatewayBalances(agent, options = {}) {
  const chainName = options.chainName || 'Arc Testnet';
  const operation = 'gateway_balances';
  try {
    return await withGatewayClientFailover(agent, {
      ...options,
      chainName,
      operationLabel: operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_READ,
    }, async (client, rpcUrl) => readGatewayBalances(client, options.address, {
      chainName,
      operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_READ,
      rpcUrl,
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName, {
      operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_READ,
    });
  }
}

async function depositGatewayBalanceForAgent(agent, amountUsdc, options = {}) {
  const chainName = options.chainName || 'Arc Testnet';
  const walletAddress = normalizeGatewayWalletAddress(options.walletAddress || options.address || resolveAgentGatewayWalletAddress(agent));
  const operation = options.operation || 'gateway_deposit';

  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation,
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, async () => withGatewayClientFailover(agent, {
      ...options,
      chainName,
      operationLabel: operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_DEPOSIT,
    }, async (client, rpcUrl) => depositGatewayBalanceUnlocked(client, amountUsdc, {
      ...options,
      chainName,
      operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_DEPOSIT,
      rpcUrl,
      address: options.address || walletAddress,
    })));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName, {
      operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_DEPOSIT,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGatewayRateLimitStatus(status) {
  return Number(status) === 429;
}

function buildGatewayRequestHeaders(requestOptions = {}) {
  return {
    'Content-Type': 'application/json',
    ...(requestOptions.headers || {}),
  };
}

function buildGatewayRequestBody(requestOptions = {}) {
  if (requestOptions.body === undefined) return undefined;
  return typeof requestOptions.body === 'string'
    ? requestOptions.body
    : JSON.stringify(requestOptions.body);
}

function buildGatewayRateLimitError(status, attempt, retryAttempts) {
  const error = new Error(`Gateway protected resource request hit rate limit (${status})`);
  error.statusCode = status;
  error.httpStatus = status;
  error.retryAttempt = attempt;
  error.retryAttempts = retryAttempts;
  error.failureSource = 'facilitator_http';
  error.failureStage = 'gateway_protected_resource_initial_request';
  error.rpcEndpointProven = false;
  error.isArcRpcEndpointError = false;
  return error;
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;

  const numericSeconds = Number.parseInt(String(headerValue).trim(), 10);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return numericSeconds * 1000;
  }

  const parsedDateMs = Date.parse(String(headerValue));
  if (!Number.isFinite(parsedDateMs)) return null;

  const remainingMs = parsedDateMs - Date.now();
  return remainingMs > 0 ? remainingMs : 0;
}

function getGatewayTargetPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function selectGatewayBatchingOption(client, paymentRequired) {
  const accepts = paymentRequired?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new Error('No payment options in 402 response');
  }

  const expectedNetwork = `eip155:${client.chainConfig.chain.id}`;
  const batchingOption = accepts.find((option) => {
    const extra = option?.extra;
    return option?.network === expectedNetwork
      && extra?.name === 'GatewayWalletBatched'
      && extra?.version === '1'
      && typeof extra?.verifyingContract === 'string';
  });

  if (!batchingOption) {
    throw new Error(
      `No Gateway batching option available for network ${expectedNetwork} (${client.chainConfig.chain.name})`,
    );
  }

  return batchingOption;
}

async function executeGatewayProtectedPayment(client, url, requestOptions = {}, retryOptions = {}) {
  const method = requestOptions.method || 'GET';
  const headers = buildGatewayRequestHeaders(requestOptions);
  const body = buildGatewayRequestBody(requestOptions);
  const retryAttempts = resolveGatewayPayRetryAttempts(retryOptions.retryAttempts);
  const retryBaseDelayMs = resolveGatewayPayRetryBaseDelayMs(retryOptions.retryBaseDelayMs);

  let initialResponse = null;

  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    initialResponse = await fetch(url, { method, headers, body });

    if (!isGatewayRateLimitStatus(initialResponse.status)) {
      break;
    }

    logGateway('warn', 'Gateway protected resource hit rate limit', {
      statusCode: initialResponse.status,
      retryAttempt: attempt,
      retryAttempts,
      method,
      path: getGatewayTargetPath(url),
    });

    if (attempt >= retryAttempts) {
      const rateLimitError = buildGatewayRateLimitError(initialResponse.status, attempt, retryAttempts);
      rateLimitError.retryAfterMs = parseRetryAfterMs(initialResponse.headers.get('retry-after'));
      throw rateLimitError;
    }

    await sleep(retryBaseDelayMs * (2 ** attempt));
  }

  if (!initialResponse) {
    throw new Error('Gateway protected resource request did not return a response');
  }

  if (initialResponse.status !== 402) {
    if (initialResponse.ok) {
      const data = await initialResponse.json();
      return {
        data,
        amount: 0n,
        formattedAmount: '0',
        transaction: '',
        status: initialResponse.status,
      };
    }

    logGateway('error', 'Gateway protected resource failed before payment challenge', {
      statusCode: initialResponse.status,
      method,
      path: getGatewayTargetPath(url),
    });

    const requestError = new Error(`Request failed with status ${initialResponse.status}`);
    requestError.statusCode = initialResponse.status;
    requestError.httpStatus = initialResponse.status;
    requestError.failureSource = 'facilitator_http';
    requestError.failureStage = 'gateway_protected_resource_initial_request';
    requestError.retryAfterMs = parseRetryAfterMs(initialResponse.headers.get('retry-after'));
    requestError.rpcEndpointProven = false;
    requestError.isArcRpcEndpointError = false;
    throw requestError;
  }

  const paymentRequiredHeader = initialResponse.headers.get('PAYMENT-REQUIRED');
  if (!paymentRequiredHeader) {
    logGateway('warn', 'Gateway protected resource 402 response missed PAYMENT-REQUIRED header', {
      statusCode: initialResponse.status,
      method,
      path: getGatewayTargetPath(url),
    });
    const missingHeaderError = new Error('Missing PAYMENT-REQUIRED header in 402 response');
    missingHeaderError.statusCode = initialResponse.status;
    missingHeaderError.httpStatus = initialResponse.status;
    missingHeaderError.failureSource = 'facilitator_http';
    missingHeaderError.failureStage = 'gateway_protected_resource_challenge';
    missingHeaderError.rpcEndpointProven = false;
    missingHeaderError.isArcRpcEndpointError = false;
    throw missingHeaderError;
  }

  const paymentRequired = JSON.parse(Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8'));
  const batchingOption = selectGatewayBatchingOption(client, paymentRequired);
  const paymentPayload = await client.createPaymentPayload(paymentRequired.x402Version ?? 2, batchingOption);
  const paymentHeader = Buffer.from(JSON.stringify({
    ...paymentPayload,
    resource: paymentRequired.resource,
    accepted: batchingOption,
  })).toString('base64');

  const paidResponse = await fetch(url, {
    method,
    headers: {
      ...headers,
      'Payment-Signature': paymentHeader,
    },
    body,
  });

  if (!paidResponse.ok) {
    const errorPayload = await paidResponse.json().catch(() => ({}));
    logGateway('warn', 'Gateway protected resource paid retry failed', {
      statusCode: paidResponse.status,
      method,
      path: getGatewayTargetPath(url),
      error: errorPayload.error || paidResponse.statusText,
    });
    const paymentError = new Error(`Payment failed: ${errorPayload.error || paidResponse.statusText}`);
    paymentError.statusCode = paidResponse.status;
    paymentError.httpStatus = paidResponse.status;
    paymentError.failureSource = 'facilitator_http';
    paymentError.failureStage = 'gateway_protected_resource_payment';
    paymentError.retryAfterMs = parseRetryAfterMs(paidResponse.headers.get('retry-after'));
    paymentError.rpcEndpointProven = false;
    paymentError.isArcRpcEndpointError = false;
    throw paymentError;
  }

  const data = await paidResponse.json();
  const amount = BigInt(batchingOption.amount);
  let transaction = '';
  const paymentResponseHeader = paidResponse.headers.get('PAYMENT-RESPONSE');
  if (paymentResponseHeader) {
    const settleResponse = JSON.parse(Buffer.from(paymentResponseHeader, 'base64').toString('utf-8'));
    transaction = settleResponse.transaction || '';
  }

  return {
    data,
    amount,
    formattedAmount: ethers.formatUnits(amount, 6),
    transaction,
    status: paidResponse.status,
  };
}

function getGatewayBuyerSummary() {
  const supportedChains = Object.entries(GATEWAY_CHAIN_MAP).map(([name, config]) => ({
    name,
    gatewayChain: config.chain,
    rpcConfigured: Boolean(config.rpcUrl),
  }));

  return {
    mode: 'gateway-buyer',
    configured: supportedChains.length > 0,
    defaultMaxFeeUsdc: resolveGatewayTransferMaxFee(),
    chainCount: supportedChains.length,
    supportedChains,
  };
}

async function waitForGatewayAvailableBalance(client, requiredAtomic, options = {}) {
  const { timeoutMs = 15000, pollIntervalMs = 400 } = options;
  const deadline = Date.now() + timeoutMs;
  let balances = await readGatewayBalances(client, options.address, {
    chainName: options.chainName,
    operation: options.operation,
    trafficClass: options.trafficClass,
    rpcUrl: options.rpcUrl,
  });

  while (balances.gateway.available < requiredAtomic && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    balances = await readGatewayBalances(client, options.address, {
      chainName: options.chainName,
      operation: options.operation,
      trafficClass: options.trafficClass,
      rpcUrl: options.rpcUrl,
    });
  }

  return balances;
}

async function ensureGatewayAvailableBalanceUnlocked(client, amountUsdc, options = {}) {
  const operation = getGatewayOperationLabel(options.operation || 'gateway_available_balance');
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_PAYMENT);
  const transferAmountAtomic = getAtomicUsdc(amountUsdc);
  const maxFee = resolveGatewayTransferMaxFee(options.maxFee);
  const requiredAtomic = transferAmountAtomic + getAtomicUsdc(maxFee);
  const balances = await readGatewayBalances(client, options.address, {
    chainName: options.chainName || 'Arc Testnet',
    operation,
    trafficClass,
    rpcUrl: options.rpcUrl,
  });

  if (balances.gateway.available >= requiredAtomic) {
    return {
      deposited: false,
      balances,
      maxFee,
      requiredAtomic,
      shortfallAtomic: 0n,
      depositResult: null,
    };
  }

  const shortfallAtomic = requiredAtomic - balances.gateway.available;
  const shortfall = ethers.formatUnits(shortfallAtomic, 6);
  const depositResult = await runGatewayStage({
    operation,
    failureStage: 'gateway_available_balance_deposit',
    failureSource: 'unknown',
    trafficClass,
    rpcUrl: options.rpcUrl,
  }, () => client.deposit(shortfall));
  const updatedBalances = await waitForGatewayAvailableBalance(client, requiredAtomic, {
    ...options,
    chainName: options.chainName || 'Arc Testnet',
    operation,
    trafficClass,
  });

  return {
    deposited: true,
    balances: updatedBalances,
    maxFee,
    requiredAtomic,
    shortfallAtomic,
    depositResult,
  };
}

async function ensureGatewayAvailableBalance(client, amountUsdc, options = {}) {
  const walletAddress = normalizeGatewayWalletAddress(options.walletAddress || options.address);
  const chainName = options.chainName || 'Arc Testnet';
  const operation = options.operation || 'gateway_available_balance';
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_PAYMENT);

  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation,
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, () => ensureGatewayAvailableBalanceUnlocked(client, amountUsdc, {
      ...options,
      chainName,
      operation,
      trafficClass,
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName, {
      operation,
      trafficClass,
    });
  }
}

async function ensureGatewayPaymentBalanceUnlocked(client, amountUsdc, options = {}) {
  const operation = getGatewayOperationLabel(options.operation || 'gateway_payment_balance');
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_PAYMENT);
  const requiredAtomic = getAtomicUsdc(amountUsdc);
  const balances = await readGatewayBalances(client, options.address, {
    chainName: options.chainName || 'Arc Testnet',
    operation,
    trafficClass,
    rpcUrl: options.rpcUrl,
  });

  if (balances.gateway.available >= requiredAtomic) {
    return {
      deposited: false,
      balances,
      requiredAtomic,
      shortfallAtomic: 0n,
      depositResult: null,
    };
  }

  const shortfallAtomic = requiredAtomic - balances.gateway.available;
  const shortfall = ethers.formatUnits(shortfallAtomic, 6);
  const depositResult = await runGatewayStage({
    operation,
    failureStage: 'gateway_payment_balance_deposit',
    failureSource: 'unknown',
    trafficClass,
    rpcUrl: options.rpcUrl,
  }, () => client.deposit(shortfall));
  const updatedBalances = await waitForGatewayAvailableBalance(client, requiredAtomic, {
    ...options,
    chainName: options.chainName || 'Arc Testnet',
    operation,
    trafficClass,
  });

  return {
    deposited: true,
    balances: updatedBalances,
    requiredAtomic,
    shortfallAtomic,
    depositResult,
  };
}

async function ensureGatewayPaymentBalance(client, amountUsdc, options = {}) {
  const walletAddress = normalizeGatewayWalletAddress(options.walletAddress || options.address);
  const chainName = options.chainName || 'Arc Testnet';
  const operation = options.operation || 'gateway_payment_balance';
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_PAYMENT);

  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation,
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, () => ensureGatewayPaymentBalanceUnlocked(client, amountUsdc, {
      ...options,
      chainName,
      operation,
      trafficClass,
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName, {
      operation,
      trafficClass,
    });
  }
}

async function depositGatewayBalanceUnlocked(client, amountUsdc, options = {}) {
  const operation = getGatewayOperationLabel(options.operation || 'gateway_deposit');
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_DEPOSIT);
  const amount = normalizeUsdcAmount(amountUsdc);
  const depositAtomic = getAtomicUsdc(amount);
  const balancesBefore = await readGatewayBalances(client, options.address, {
    chainName: options.chainName || 'Arc Testnet',
    operation,
    trafficClass,
    rpcUrl: options.rpcUrl,
  });

  if (balancesBefore.wallet.available < depositAtomic) {
    const error = new Error('insufficient_wallet_balance_for_gateway_deposit');
    error.statusCode = 400;
    error.details = {
      requestedUsdc: amount,
      walletAvailableUsdc: balancesBefore.wallet.formattedAvailable,
    };
    throw error;
  }

  const depositResult = await runGatewayStage({
    operation,
    failureStage: 'gateway_manual_deposit_submission',
    failureSource: 'unknown',
    trafficClass,
    rpcUrl: options.rpcUrl,
  }, () => client.deposit(amount));
  const targetAvailableAtomic = balancesBefore.gateway.available + depositAtomic;
  const balancesAfter = await waitForGatewayAvailableBalance(client, targetAvailableAtomic, {
    ...options,
    chainName: options.chainName || 'Arc Testnet',
    operation,
    trafficClass,
  });

  return {
    amountUsdc: amount,
    balancesBefore,
    balancesAfter,
    depositResult,
    funded: balancesAfter.gateway.available > 0n,
  };
}

async function depositGatewayBalance(client, amountUsdc, options = {}) {
  const walletAddress = normalizeGatewayWalletAddress(options.walletAddress || options.address);
  const chainName = options.chainName || 'Arc Testnet';
  const operation = options.operation || 'gateway_deposit';
  const trafficClass = normalizeGatewayTrafficClass(options.trafficClass || GATEWAY_TRAFFIC_CLASS_DEPOSIT);

  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation,
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, () => depositGatewayBalanceUnlocked(client, amountUsdc, {
      ...options,
      chainName,
      operation,
      trafficClass,
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName, {
      operation,
      trafficClass,
    });
  }
}

async function ensureGatewayWarmBalance(agent, options = {}) {
  if (!agent) {
    return {
      attempted: false,
      deposited: false,
      reason: 'agent_missing',
    };
  }

  const chainName = options.chainName || 'Arc Testnet';
  const operation = options.operation || 'gateway_warm_balance';
  const minAvailableUsdc = normalizeUsdcAmount(
    options.minAvailableUsdc == null ? DEFAULT_GATEWAY_WARM_MIN_AVAILABLE_USDC : options.minAvailableUsdc,
  );
  const targetAvailableUsdc = normalizeUsdcAmount(
    options.targetAvailableUsdc == null ? DEFAULT_GATEWAY_WARM_TARGET_USDC : options.targetAvailableUsdc,
  );

  if (!(minAvailableUsdc > 0) || !(targetAvailableUsdc > 0) || targetAvailableUsdc < minAvailableUsdc) {
    return {
      attempted: false,
      deposited: false,
      reason: 'invalid_target',
    };
  }

  const walletAddress = resolveAgentGatewayWalletAddress(agent, options.walletAddress || options.address);
  const balanceAddress = options.address || walletAddress;
  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation,
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs == null ? DEFAULT_GATEWAY_AUTO_WARM_LOCK_WAIT_MS : options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, async () => withGatewayClientFailover(agent, {
      ...options,
      chainName,
      operationLabel: operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_DEPOSIT,
    }, async (client, rpcUrl) => {
      const balancesBefore = await readGatewayBalances(client, balanceAddress, {
        chainName,
        operation,
        trafficClass: GATEWAY_TRAFFIC_CLASS_DEPOSIT,
        rpcUrl,
      });
      const currentAvailableUsdc = Number(balancesBefore.gateway?.formattedAvailable || 0);

    if (Number.isFinite(currentAvailableUsdc) && currentAvailableUsdc >= minAvailableUsdc) {
      return {
        attempted: false,
        deposited: false,
        reason: 'already_warm',
        minAvailableUsdc,
        targetAvailableUsdc,
        balancesBefore,
        balancesAfter: balancesBefore,
        amountUsdc: '0',
      };
    }

    const depositAmountUsdc = normalizeUsdcAmount(Math.max(targetAvailableUsdc - currentAvailableUsdc, 0));
    if (!(depositAmountUsdc > 0)) {
      return {
        attempted: false,
        deposited: false,
        reason: 'target_already_met',
        minAvailableUsdc,
        targetAvailableUsdc,
        balancesBefore,
        balancesAfter: balancesBefore,
        amountUsdc: '0',
      };
    }

    const walletAvailableUsdc = Number(balancesBefore.wallet?.formattedAvailable || 0);
    if (!Number.isFinite(walletAvailableUsdc) || walletAvailableUsdc < depositAmountUsdc) {
      return {
        attempted: false,
        deposited: false,
        reason: 'wallet_balance_too_low',
        minAvailableUsdc,
        targetAvailableUsdc,
        balancesBefore,
        balancesAfter: balancesBefore,
        amountUsdc: String(depositAmountUsdc),
      };
    }

      const funding = await depositGatewayBalanceUnlocked(client, depositAmountUsdc, {
        ...options,
        address: balanceAddress,
        chainName,
        operation,
        trafficClass: GATEWAY_TRAFFIC_CLASS_DEPOSIT,
        rpcUrl,
      });
      return {
        attempted: true,
        deposited: true,
        reason: 'funded',
        minAvailableUsdc,
        targetAvailableUsdc,
        balancesBefore: funding.balancesBefore,
        balancesAfter: funding.balancesAfter,
        amountUsdc: funding.amountUsdc,
        depositResult: funding.depositResult,
        funded: funding.funded,
      };
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName, {
      operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_DEPOSIT,
    });
  }
}

async function payGatewayProtectedResource({
  agent,
  url,
  amountUsdc,
  chainName = 'Arc Testnet',
  requestOptions,
  replayFingerprint = null,
  waitForLockMs,
  protectedWrite = true,
}) {
  if (!url) {
    throw new Error('A protected resource URL is required');
  }

  const amount = normalizeUsdcAmount(amountUsdc);
  const walletAddress = resolveAgentGatewayWalletAddress(agent);
  const operation = 'gateway_protected_resource_pay';
  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation,
      replayFingerprint,
      waitForLockMs,
      protectedWrite,
    }, async () => withGatewayClientFailover(agent, {
      chainName,
      operationLabel: operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_PAYMENT,
    }, async (client, rpcUrl) => {
      const funding = await ensureGatewayPaymentBalanceUnlocked(client, amount, {
        address: walletAddress,
        chainName,
        operation,
        trafficClass: GATEWAY_TRAFFIC_CLASS_PAYMENT,
        rpcUrl,
      });
      const payResult = await executeGatewayProtectedPayment(client, url, requestOptions);

      return {
        mode: 'circle_gateway_resource_pay',
        sourceChain: chainName,
        amountUsdc: amount,
        deposited: funding.deposited,
        depositResult: funding.depositResult,
        payResult,
      };
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName, {
      operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_PAYMENT,
    });
  }
}

async function executeGatewayTransfer({
  agent,
  amountUsdc,
  recipient,
  fromChain = 'Arc Testnet',
  toChain = 'Arc Testnet',
  maxFee,
  idempotencyKey = null,
  replayFingerprint = null,
  retryIntentId = null,
  isRetryAttempt = false,
  waitForLockMs,
  protectedWrite = true,
}) {
  if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    throw new Error('A valid recipient address is required');
  }

  const amount = normalizeUsdcAmount(amountUsdc);
  const resolvedMaxFee = resolveGatewayTransferMaxFee(maxFee);
  const walletAddress = resolveAgentGatewayWalletAddress(agent);
  const operation = 'gateway_transfer';
  try {
    const destination = resolveGatewayChainConfig(toChain);

    return await runGatewayProtectedWrite({
      chainName: fromChain,
      walletAddress,
      operation,
      replayFingerprint: replayFingerprint ?? idempotencyKey ?? null,
      waitForLockMs,
      protectedWrite,
    }, async () => withGatewayClientFailover(agent, {
      chainName: fromChain,
      operationLabel: operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_PAYMENT,
    }, async (client, rpcUrl) => {
      const funding = await ensureGatewayAvailableBalanceUnlocked(client, amount, {
        maxFee: resolvedMaxFee,
        address: walletAddress,
        chainName: fromChain,
        operation,
        trafficClass: GATEWAY_TRAFFIC_CLASS_PAYMENT,
        rpcUrl,
      });

      const transferResult = await runGatewayStage({
        operation,
        failureStage: 'gateway_transfer_submission',
        failureSource: 'unknown',
        trafficClass: GATEWAY_TRAFFIC_CLASS_PAYMENT,
        rpcUrl,
      }, () => client.withdraw(amount, {
        chain: destination.chain,
        recipient,
        maxFee: resolvedMaxFee,
      }));

      return {
        mode: 'circle_gateway_buyer',
        sourceChain: fromChain,
        destinationChain: toChain,
        idempotencyKey,
        retryIntentId,
        isRetryAttempt: Boolean(isRetryAttempt),
        deposited: funding.deposited,
        maxFee: resolvedMaxFee,
        depositResult: funding.depositResult,
        transferResult,
      };
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, fromChain, {
      operation,
      trafficClass: GATEWAY_TRAFFIC_CLASS_PAYMENT,
    });
  }
}

module.exports = {
  GATEWAY_CHAIN_MAP,
  createGatewayClientForAgent,
  depositGatewayBalance,
  depositGatewayBalanceForAgent,
  ensureGatewayAvailableBalance,
  ensureGatewayPaymentBalance,
  executeGatewayTransfer,
  executeGatewayProtectedPayment,
  ensureGatewayWarmBalance,
  getAgentGatewayBalances,
  getGatewayBuyerSummary,
  getAgentGatewayPrivateKey,
  normalizeUsdcAmount,
  payGatewayProtectedResource,
  readGatewayBalances,
  resolveGatewayChainConfig,
  resolveGatewayTransferMaxFee,
  waitForGatewayAvailableBalance,
};