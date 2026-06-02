'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');
const redis = require('./redisClient');
const { recordSecurityEvent, recordSuspiciousAgentActivity } = require('./securityEventService');

const DEFAULT_TX_RATE_LIMIT_WINDOW_SEC = readPositiveIntegerEnv('AGENT_TX_RATE_LIMIT_WINDOW_SEC', 60);
const DEFAULT_TX_RATE_LIMIT_MAX = readPositiveIntegerEnv('AGENT_TX_RATE_LIMIT_MAX', 12);
const DEFAULT_CHAIN_LOCK_TTL_SEC = readPositiveIntegerEnv('AGENT_TX_CHAIN_LOCK_TTL_SEC', 120);
const DEFAULT_CHAIN_LOCK_WAIT_MS = readNonNegativeIntegerEnv('AGENT_TX_CHAIN_LOCK_WAIT_MS', 45000);
const DEFAULT_REPLAY_TTL_SEC = readPositiveIntegerEnv('AGENT_TX_REPLAY_TTL_SEC', 45);
const DEFAULT_GAS_MARGIN_BPS = readPositiveBigIntEnv('AGENT_TX_GAS_MARGIN_BPS', 12500n);

const memoryLocks = new Map();
const memoryReplays = new Map();
const memoryCounters = new Map();

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveBigIntEnv(name, fallback) {
  try {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function stableSerialize(value) {
  if (value == null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeChainName(chainName) {
  return String(chainName || 'Arc Testnet')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'arc-testnet';
}

function normalizeWalletAddress(walletAddress) {
  if (!walletAddress) return null;

  try {
    return ethers.getAddress(String(walletAddress)).toLowerCase();
  } catch {
    return String(walletAddress || '').trim().toLowerCase() || null;
  }
}

function resolveAgentKey({ agentId, walletAddress }) {
  const normalizedWallet = normalizeWalletAddress(walletAddress);
  if (normalizedWallet) return `wallet:${normalizedWallet}`;

  if (agentId) return `agent:${String(agentId).trim()}`;

  throw Object.assign(new Error('Missing agent identity for protected transaction execution'), {
    status: 500,
    code: 'AGENT_IDENTITY_REQUIRED',
  });
}

function buildReplayDigest(operation, replayFingerprint) {
  if (!replayFingerprint) return null;

  return crypto
    .createHash('sha256')
    .update(`${String(operation || 'tx')}|${stableSerialize(replayFingerprint)}`)
    .digest('hex');
}

function buildReplayKey(agentKey, chainKey, operation, replayFingerprint) {
  const digest = buildReplayDigest(operation, replayFingerprint);
  if (!digest) return null;
  return `agent-tx:replay:${agentKey}:${chainKey}:${digest}`;
}

function buildLockKey(agentKey, chainKey) {
  return `agent-tx:lock:${agentKey}:${chainKey}`;
}

function buildRateBucketKey(agentKey, bucketId) {
  return `agent-tx:rate:${agentKey}:${bucketId}`;
}

function buildBusyError(chainName) {
  return Object.assign(
    new Error(`Another transaction is already executing for this agent on ${chainName}. Try again in a moment.`),
    { status: 409, code: 'AGENT_TX_BUSY' },
  );
}

function buildReplayError() {
  return Object.assign(
    new Error('A matching transaction was already submitted recently. Wait a moment before retrying.'),
    { status: 409, code: 'TX_REPLAY_BLOCKED' },
  );
}

function buildRateLimitError(rateLimitMax, windowSec) {
  return Object.assign(
    new Error(`Agent transaction rate limit exceeded (${rateLimitMax} tx per ${windowSec}s window).`),
    { status: 429, code: 'AGENT_TX_RATE_LIMITED' },
  );
}

function buildSimulationError(methodName, error) {
  const message = error?.reason || error?.shortMessage || error?.message || `Transaction simulation failed for ${methodName}`;
  return Object.assign(new Error(message), {
    status: 422,
    code: 'TX_SIMULATION_FAILED',
    cause: error,
  });
}

async function getRedisClient() {
  if (process.env.NODE_ENV === 'test') return null;

  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    return redis;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneMemoryMap(map) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (!value || Number(value.expiresAt || 0) <= now) {
      map.delete(key);
    }
  }
}

async function tryAcquireChainLock({ agentKey, chainKey, lockTtlSec }) {
  const client = await getRedisClient();
  const key = buildLockKey(agentKey, chainKey);
  const token = crypto.randomUUID();

  if (client) {
    const result = await client.set(key, token, 'NX', 'EX', lockTtlSec).catch(() => null);
    if (result !== 'OK') return null;

    return async () => {
      const releaseScript = `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `;
      await client.eval(releaseScript, 1, key, token).catch(() => {});
    };
  }

  pruneMemoryMap(memoryLocks);
  const existing = memoryLocks.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return null;
  }

  memoryLocks.set(key, { token, expiresAt: Date.now() + (lockTtlSec * 1000) });
  return async () => {
    const current = memoryLocks.get(key);
    if (current?.token === token) {
      memoryLocks.delete(key);
    }
  };
}

async function acquireChainLock({ agentKey, chainKey, chainName, lockTtlSec, waitForLockMs = DEFAULT_CHAIN_LOCK_WAIT_MS }) {
  const timeoutMs = Math.max(Number(waitForLockMs) || 0, 0);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const releaseLock = await tryAcquireChainLock({ agentKey, chainKey, lockTtlSec });
    if (releaseLock) return releaseLock;

    if (Date.now() >= deadline) {
      throw buildBusyError(chainName);
    }

    await sleep(Math.min(250, Math.max(deadline - Date.now(), 1)));
  }
}

async function assertReplayNotSeen(replayKey) {
  if (!replayKey) return;

  const client = await getRedisClient();
  if (client) {
    const existing = await client.get(replayKey).catch(() => null);
    if (existing) throw buildReplayError();
    return;
  }

  pruneMemoryMap(memoryReplays);
  if (memoryReplays.has(replayKey)) {
    throw buildReplayError();
  }
}

async function rememberReplay(replayKey, replayTtlSec, txHash = null) {
  if (!replayKey) return;

  const client = await getRedisClient();
  if (client) {
    await client.set(replayKey, txHash || '1', 'EX', replayTtlSec).catch(() => {});
    return;
  }

  pruneMemoryMap(memoryReplays);
  memoryReplays.set(replayKey, {
    value: txHash || '1',
    expiresAt: Date.now() + (replayTtlSec * 1000),
  });
}

async function consumeRateLimit(agentKey, cost = 1, rateLimitMax = DEFAULT_TX_RATE_LIMIT_MAX, windowSec = DEFAULT_TX_RATE_LIMIT_WINDOW_SEC) {
  if (!(rateLimitMax > 0)) return;

  const bucketId = Math.floor(Date.now() / (windowSec * 1000));
  const key = buildRateBucketKey(agentKey, bucketId);
  const client = await getRedisClient();

  if (client) {
    const nextCount = await client.incrby(key, cost).catch(() => null);
    if (nextCount == null) {
      return;
    }
    if (Number(nextCount) === Number(cost)) {
      await client.expire(key, Math.max(windowSec + 5, 10)).catch(() => {});
    }
    if (Number(nextCount) > rateLimitMax) {
      await client.decrby(key, cost).catch(() => {});
      throw buildRateLimitError(rateLimitMax, windowSec);
    }
    return;
  }

  pruneMemoryMap(memoryCounters);
  const current = memoryCounters.get(key);
  const currentCount = Number(current?.count || 0);
  if ((currentCount + cost) > rateLimitMax) {
    throw buildRateLimitError(rateLimitMax, windowSec);
  }

  memoryCounters.set(key, {
    count: currentCount + cost,
    expiresAt: Date.now() + ((windowSec + 5) * 1000),
  });
}

function applyGasMargin(gasEstimate, gasMarginBps = DEFAULT_GAS_MARGIN_BPS) {
  const estimate = BigInt(gasEstimate || 0);
  if (estimate <= 0n) return estimate;

  return (estimate * BigInt(gasMarginBps)) / 10000n;
}

function resolveReplayFingerprint({ replayFingerprint, methodName, args }) {
  if (replayFingerprint !== undefined) return replayFingerprint;
  return [methodName, args];
}

function extractTxHash(result) {
  if (!result || typeof result !== 'object') return null;

  const directKeys = ['hash', 'txHash', 'mintTxHash', 'burnTxHash', 'topUpTxHash', 'approveTxHash'];
  for (const key of directKeys) {
    const value = result[key];
    if (typeof value === 'string' && value.startsWith('0x') && value.length > 10) {
      return value;
    }
  }

  const nestedKeys = ['transferResult', 'depositResult', 'result'];
  for (const key of nestedKeys) {
    const nested = extractTxHash(result[key]);
    if (nested) return nested;
  }

  return null;
}

async function auditProtectedWriteFailure({ agentId, walletAddress, chainName, operation, methodName }, error) {
  const code = String(error?.code || '').trim();
  if (!code) return;

  const metadata = {
    operation,
    methodName: methodName || null,
    errorCode: code,
    status: error?.status || null,
    message: error?.message || null,
  };

  try {
    if (code === 'AGENT_TX_RATE_LIMITED') {
      await recordSuspiciousAgentActivity({
        agentId,
        walletAddress,
        chainName,
        eventType: code.toLowerCase(),
        severity: 'critical',
        metadata,
      });
      return;
    }

    if (code === 'AGENT_TX_BUSY' || code === 'TX_REPLAY_BLOCKED') {
      await recordSecurityEvent({
        category: 'agent_tx',
        eventType: code.toLowerCase(),
        severity: 'info',
        action: 'deferred',
        agentId,
        walletAddress,
        chainName,
        metadata,
      });
      return;
    }

    if (code === 'TX_SIMULATION_FAILED') {
      await recordSecurityEvent({
        category: 'agent_tx',
        eventType: 'tx_simulation_failed',
        severity: 'info',
        action: 'blocked',
        agentId,
        walletAddress,
        chainName,
        metadata,
      });
    }
  } catch {
    // Never let audit logging block the original transaction protection error.
  }
}

async function sendProtectedContractTx({
  contract,
  methodName,
  args = [],
  txOptions = {},
  chainName = 'Arc Testnet',
  agentId = null,
  walletAddress = null,
  operation = methodName,
  replayFingerprint,
  replayTtlSec = DEFAULT_REPLAY_TTL_SEC,
  rateLimitCost = 1,
  rateLimitMax = DEFAULT_TX_RATE_LIMIT_MAX,
  windowSec = DEFAULT_TX_RATE_LIMIT_WINDOW_SEC,
  lockTtlSec = DEFAULT_CHAIN_LOCK_TTL_SEC,
  waitForLockMs = DEFAULT_CHAIN_LOCK_WAIT_MS,
  gasMarginBps = DEFAULT_GAS_MARGIN_BPS,
  waitConfirmations = 1,
}) {
  const runner = contract?.runner;
  const signerAddress = walletAddress || runner?.address || null;
  const agentKey = resolveAgentKey({ agentId, walletAddress: signerAddress });
  const chainKey = normalizeChainName(chainName);
  const replayKey = buildReplayKey(agentKey, chainKey, operation, resolveReplayFingerprint({ replayFingerprint, methodName, args }));
  const releaseLock = await acquireChainLock({ agentKey, chainKey, chainName, lockTtlSec, waitForLockMs });

  try {
    await assertReplayNotSeen(replayKey);

    const method = contract?.[methodName];
    if (typeof method !== 'function' || typeof method.estimateGas !== 'function') {
      throw new Error(`Contract method ${methodName} is not available for protected execution`);
    }

    let gasEstimate;
    try {
      gasEstimate = await method.estimateGas(...args, txOptions);
    } catch (error) {
      throw buildSimulationError(methodName, error);
    }

    const gasLimit = txOptions.gasLimit != null
      ? BigInt(txOptions.gasLimit)
      : applyGasMargin(gasEstimate, gasMarginBps);

    await consumeRateLimit(agentKey, rateLimitCost, rateLimitMax, windowSec);

    const tx = await method(...args, { ...txOptions, gasLimit });
    await rememberReplay(replayKey, replayTtlSec, tx?.hash || null);

    const receipt = waitConfirmations > 0
      ? await tx.wait(waitConfirmations)
      : null;

    return { tx, receipt, gasEstimate, gasLimit };
  } catch (error) {
    await auditProtectedWriteFailure({
      agentId,
      walletAddress: signerAddress,
      chainName,
      operation,
      methodName,
    }, error);
    throw error;
  } finally {
    await releaseLock();
  }
}

async function runProtectedWrite({
  chainName = 'Arc Testnet',
  agentId = null,
  walletAddress = null,
  operation = 'external_write',
  replayFingerprint = null,
  replayTtlSec = DEFAULT_REPLAY_TTL_SEC,
  rateLimitCost = 1,
  rateLimitMax = DEFAULT_TX_RATE_LIMIT_MAX,
  windowSec = DEFAULT_TX_RATE_LIMIT_WINDOW_SEC,
  lockTtlSec = DEFAULT_CHAIN_LOCK_TTL_SEC,
  waitForLockMs = DEFAULT_CHAIN_LOCK_WAIT_MS,
}, execute) {
  const agentKey = resolveAgentKey({ agentId, walletAddress });
  const chainKey = normalizeChainName(chainName);
  const replayKey = buildReplayKey(agentKey, chainKey, operation, replayFingerprint);
  const releaseLock = await acquireChainLock({ agentKey, chainKey, chainName, lockTtlSec, waitForLockMs });

  try {
    await assertReplayNotSeen(replayKey);
    await consumeRateLimit(agentKey, rateLimitCost, rateLimitMax, windowSec);
    const result = await execute();
    await rememberReplay(replayKey, replayTtlSec, extractTxHash(result));
    return result;
  } catch (error) {
    await auditProtectedWriteFailure({
      agentId,
      walletAddress,
      chainName,
      operation,
      methodName: operation,
    }, error);
    throw error;
  } finally {
    await releaseLock();
  }
}

function __resetForTests() {
  memoryLocks.clear();
  memoryReplays.clear();
  memoryCounters.clear();
}

module.exports = {
  applyGasMargin,
  extractTxHash,
  runProtectedWrite,
  sendProtectedContractTx,
  __resetForTests,
};