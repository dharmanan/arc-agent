'use strict';

const { ethers } = require('ethers');
const { GatewayClient } = require('@circle-fin/x402-batching/client');
const { decrypt } = require('../cryptoService');
const { runProtectedWrite } = require('../txSecurityService');
const { getHealthyArcRpcUrl, isArcRpcRateLimitError } = require('../arcProvider');
const { logGateway } = require('./logger');

const DEFAULT_GATEWAY_TRANSFER_MAX_FEE_USDC = process.env.GATEWAY_TRANSFER_MAX_FEE_USDC || '0.005';
const DEFAULT_GATEWAY_PAY_RETRY_ATTEMPTS = process.env.GATEWAY_PAY_RETRY_ATTEMPTS || '2';
const DEFAULT_GATEWAY_PAY_RETRY_BASE_DELAY_MS = process.env.GATEWAY_PAY_RETRY_BASE_DELAY_MS || '750';
const DEFAULT_GATEWAY_WARM_MIN_AVAILABLE_USDC = process.env.GATEWAY_WARM_MIN_AVAILABLE_USDC || '1';
const DEFAULT_GATEWAY_WARM_TARGET_USDC = process.env.GATEWAY_WARM_TARGET_USDC || '3';
const DEFAULT_GATEWAY_TX_LOCK_TTL_SEC = readPositiveIntegerEnv('GATEWAY_TX_LOCK_TTL_SEC', 180);
const DEFAULT_GATEWAY_AUTO_WARM_LOCK_WAIT_MS = readNonNegativeIntegerEnv('GATEWAY_AUTO_WARM_LOCK_WAIT_MS', 0);
const ARC_RPC_COOLDOWN_CODE = 'ARC_RPC_COOLDOWN';
const ARC_RPC_COOLDOWN_MESSAGE = 'Arc RPC is cooling down';

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

function buildArcRpcCooldownError(error = null, chainName = 'Arc Testnet') {
  const cooldownError = new Error(ARC_RPC_COOLDOWN_MESSAGE);
  cooldownError.code = ARC_RPC_COOLDOWN_CODE;
  cooldownError.chainName = chainName;
  cooldownError.retryable = true;
  cooldownError.deferred = true;
  cooldownError.status = 'deferred';
  if (error) {
    cooldownError.cause = error;
    cooldownError.causeMessage = error.message || String(error);
  }
  return cooldownError;
}

function toRetryableGatewayError(error, chainName = 'Arc Testnet') {
  if (isArcTestnetChain(chainName) && isGatewayRateLimitError(error)) {
    return buildArcRpcCooldownError(error, chainName);
  }

  return error;
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
  const chainConfig = resolveGatewayChainConfig(chainName);
  let rpcUrl = options.rpcUrl || chainConfig.rpcUrl;

  if (isArcTestnetChain(chainName)) {
    const healthyArcRpcUrl = getHealthyArcRpcUrl('gateway_client');
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

async function readGatewayBalances(client, address, options = {}) {
  let wallet;
  let gateway;
  try {
    [wallet, gateway] = await Promise.all([
      client.getUsdcBalance(address),
      client.getGatewayBalance(address),
    ]);
  } catch (error) {
    throw toRetryableGatewayError(error, options.chainName || 'Arc Testnet');
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
  try {
    const client = createGatewayClientForAgent(agent, options);
    return readGatewayBalances(client, options.address, {
      chainName: options.chainName || 'Arc Testnet',
    });
  } catch (error) {
    throw toRetryableGatewayError(error, options.chainName || 'Arc Testnet');
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
  error.retryAttempt = attempt;
  error.retryAttempts = retryAttempts;
  return error;
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
      throw buildGatewayRateLimitError(initialResponse.status, attempt, retryAttempts);
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

    throw new Error(`Request failed with status ${initialResponse.status}`);
  }

  const paymentRequiredHeader = initialResponse.headers.get('PAYMENT-REQUIRED');
  if (!paymentRequiredHeader) {
    logGateway('warn', 'Gateway protected resource 402 response missed PAYMENT-REQUIRED header', {
      statusCode: initialResponse.status,
      method,
      path: getGatewayTargetPath(url),
    });
    throw new Error('Missing PAYMENT-REQUIRED header in 402 response');
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
    throw new Error(`Payment failed: ${errorPayload.error || paidResponse.statusText}`);
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
  let balances = await readGatewayBalances(client, options.address);

  while (balances.gateway.available < requiredAtomic && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    balances = await readGatewayBalances(client, options.address);
  }

  return balances;
}

async function ensureGatewayAvailableBalanceUnlocked(client, amountUsdc, options = {}) {
  const transferAmountAtomic = getAtomicUsdc(amountUsdc);
  const maxFee = resolveGatewayTransferMaxFee(options.maxFee);
  const requiredAtomic = transferAmountAtomic + getAtomicUsdc(maxFee);
  const balances = await readGatewayBalances(client, options.address, {
    chainName: options.chainName || 'Arc Testnet',
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
  const depositResult = await client.deposit(shortfall);
  const updatedBalances = await waitForGatewayAvailableBalance(client, requiredAtomic, {
    ...options,
    chainName: options.chainName || 'Arc Testnet',
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

  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation: options.operation || 'gateway_available_balance',
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, () => ensureGatewayAvailableBalanceUnlocked(client, amountUsdc, {
      ...options,
      chainName,
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName);
  }
}

async function ensureGatewayPaymentBalanceUnlocked(client, amountUsdc, options = {}) {
  const requiredAtomic = getAtomicUsdc(amountUsdc);
  const balances = await readGatewayBalances(client, options.address, {
    chainName: options.chainName || 'Arc Testnet',
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
  const depositResult = await client.deposit(shortfall);
  const updatedBalances = await waitForGatewayAvailableBalance(client, requiredAtomic, {
    ...options,
    chainName: options.chainName || 'Arc Testnet',
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

  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation: options.operation || 'gateway_payment_balance',
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, () => ensureGatewayPaymentBalanceUnlocked(client, amountUsdc, {
      ...options,
      chainName,
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName);
  }
}

async function depositGatewayBalanceUnlocked(client, amountUsdc, options = {}) {
  const amount = normalizeUsdcAmount(amountUsdc);
  const depositAtomic = getAtomicUsdc(amount);
  const balancesBefore = await readGatewayBalances(client, options.address, {
    chainName: options.chainName || 'Arc Testnet',
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

  const depositResult = await client.deposit(amount);
  const targetAvailableAtomic = balancesBefore.gateway.available + depositAtomic;
  const balancesAfter = await waitForGatewayAvailableBalance(client, targetAvailableAtomic, {
    ...options,
    chainName: options.chainName || 'Arc Testnet',
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

  try {
    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation: options.operation || 'gateway_deposit',
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, () => depositGatewayBalanceUnlocked(client, amountUsdc, {
      ...options,
      chainName,
    }));
  } catch (error) {
    throw toRetryableGatewayError(error, chainName);
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
    const client = createGatewayClientForAgent(agent, { chainName });

    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation: options.operation || 'gateway_warm_balance',
      replayFingerprint: options.replayFingerprint || null,
      waitForLockMs: options.waitForLockMs == null ? DEFAULT_GATEWAY_AUTO_WARM_LOCK_WAIT_MS : options.waitForLockMs,
      protectedWrite: options.protectedWrite !== false,
    }, async () => {
      const balancesBefore = await readGatewayBalances(client, balanceAddress, { chainName });
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
    });
  } catch (error) {
    throw toRetryableGatewayError(error, chainName);
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
  try {
    const client = createGatewayClientForAgent(agent, { chainName });

    return await runGatewayProtectedWrite({
      chainName,
      walletAddress,
      operation: 'gateway_protected_resource_pay',
      replayFingerprint,
      waitForLockMs,
      protectedWrite,
    }, async () => {
      const funding = await ensureGatewayPaymentBalanceUnlocked(client, amount, {
        address: walletAddress,
        chainName,
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
    });
  } catch (error) {
    throw toRetryableGatewayError(error, chainName);
  }
}

async function executeGatewayTransfer({
  agent,
  amountUsdc,
  recipient,
  fromChain = 'Arc Testnet',
  toChain = 'Arc Testnet',
  maxFee,
  replayFingerprint = null,
  waitForLockMs,
  protectedWrite = true,
}) {
  if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    throw new Error('A valid recipient address is required');
  }

  const amount = normalizeUsdcAmount(amountUsdc);
  const resolvedMaxFee = resolveGatewayTransferMaxFee(maxFee);
  const walletAddress = resolveAgentGatewayWalletAddress(agent);
  try {
    const client = createGatewayClientForAgent(agent, { chainName: fromChain });
    const destination = resolveGatewayChainConfig(toChain);

    return await runGatewayProtectedWrite({
      chainName: fromChain,
      walletAddress,
      operation: 'gateway_transfer',
      replayFingerprint,
      waitForLockMs,
      protectedWrite,
    }, async () => {
      const funding = await ensureGatewayAvailableBalanceUnlocked(client, amount, {
        maxFee: resolvedMaxFee,
        address: walletAddress,
        chainName: fromChain,
      });

      const transferResult = await client.withdraw(amount, {
        chain: destination.chain,
        recipient,
        maxFee: resolvedMaxFee,
      });

      return {
        mode: 'circle_gateway_buyer',
        sourceChain: fromChain,
        destinationChain: toChain,
        deposited: funding.deposited,
        maxFee: resolvedMaxFee,
        depositResult: funding.depositResult,
        transferResult,
      };
    });
  } catch (error) {
    throw toRetryableGatewayError(error, fromChain);
  }
}

module.exports = {
  GATEWAY_CHAIN_MAP,
  createGatewayClientForAgent,
  depositGatewayBalance,
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