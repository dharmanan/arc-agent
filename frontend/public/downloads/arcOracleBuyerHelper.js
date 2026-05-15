'use strict';

const { ethers } = require('ethers');
const { GatewayClient } = require('@circle-fin/x402-batching/client');

const DEFAULT_RPC_URLS = {
  arcTestnet: 'https://rpc.testnet.arc.network',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
  baseSepolia: 'https://sepolia.base.org',
  optimismSepolia: 'https://sepolia.optimism.io',
  arbitrumSepolia: 'https://sepolia-rollup.arbitrum.io/rpc',
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

function getAtomicUsdc(amountUsdc) {
  return ethers.parseUnits(normalizeUsdcAmount(amountUsdc), 6);
}

function decodeBase64Json(headerValue) {
  if (!headerValue) return null;

  try {
    return JSON.parse(Buffer.from(String(headerValue), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function resolveChainConfig(chain = 'arcTestnet', rpcUrl) {
  const normalizedChain = String(chain || 'arcTestnet').trim();
  const defaultRpcUrl = DEFAULT_RPC_URLS[normalizedChain];

  if (!defaultRpcUrl && !rpcUrl) {
    throw new Error(`Unsupported Gateway chain: ${normalizedChain}`);
  }

  return {
    chain: normalizedChain,
    rpcUrl: rpcUrl || defaultRpcUrl,
  };
}

async function parseResponseBody(response) {
  const raw = await response.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function selectBatchingOption(client, paymentRequired) {
  const accepts = paymentRequired?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new Error('No payment options found in PAYMENT-REQUIRED');
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
    throw new Error(`No Gateway batching option available for ${expectedNetwork}`);
  }

  return batchingOption;
}

async function readBalances(client) {
  const [wallet, gateway] = await Promise.all([
    client.getUsdcBalance(),
    client.getGatewayBalance(),
  ]);

  return {
    wallet,
    gateway,
  };
}

async function waitForGatewayAvailableBalance(client, requiredAtomic, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 400;
  const deadline = Date.now() + timeoutMs;
  let balances = await readBalances(client);

  while (balances.gateway.available < requiredAtomic && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    balances = await readBalances(client);
  }

  return balances;
}

async function ensureGatewayBalance(client, requiredAtomic, options = {}) {
  const balances = await readBalances(client);
  const bufferAtomic = options.bufferUsdc ? getAtomicUsdc(options.bufferUsdc) : 0n;
  const targetAtomic = requiredAtomic + bufferAtomic;

  if (balances.gateway.available >= targetAtomic) {
    return {
      deposited: false,
      requiredAtomic,
      targetAtomic,
      shortfallAtomic: 0n,
      depositResult: null,
      balances,
    };
  }

  const shortfallAtomic = targetAtomic - balances.gateway.available;
  const depositAmountUsdc = ethers.formatUnits(shortfallAtomic, 6);
  const depositResult = await client.deposit(depositAmountUsdc);
  const updatedBalances = await waitForGatewayAvailableBalance(client, targetAtomic, options);

  return {
    deposited: true,
    requiredAtomic,
    targetAtomic,
    shortfallAtomic,
    depositResult,
    balances: updatedBalances,
  };
}

class ArcOracleBuyer {
  constructor(options = {}) {
    const privateKey = String(options.privateKey || '').trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
      throw new Error('privateKey must be a 0x-prefixed 32-byte hex string');
    }

    const chainConfig = resolveChainConfig(options.chain, options.rpcUrl);

    this.client = new GatewayClient({
      chain: chainConfig.chain,
      privateKey,
      rpcUrl: chainConfig.rpcUrl,
    });
    this.fundingBufferUsdc = options.fundingBufferUsdc || '0';
  }

  async getBalances() {
    return readBalances(this.client);
  }

  async preview(url, requestOptions = {}) {
    if (!url) throw new Error('url is required');

    const response = await fetch(url, {
      method: requestOptions.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(requestOptions.headers || {}),
      },
      body: requestOptions.body === undefined
        ? undefined
        : (typeof requestOptions.body === 'string' ? requestOptions.body : JSON.stringify(requestOptions.body)),
    });

    const body = await parseResponseBody(response);
    const paymentRequired = decodeBase64Json(response.headers.get('PAYMENT-REQUIRED'));

    return {
      status: response.status,
      ok: response.ok,
      body,
      paymentRequired,
      docsUrl: body && typeof body === 'object' ? body.docsUrl || null : null,
    };
  }

  async pay(url, requestOptions = {}) {
    const preview = await this.preview(url, requestOptions);

    if (preview.status !== 402) {
      return {
        preview,
        paid: false,
        reason: preview.ok ? 'resource_not_paywalled' : 'preview_failed',
      };
    }

    if (!preview.paymentRequired) {
      throw new Error('Missing or invalid PAYMENT-REQUIRED header');
    }

    const batchingOption = selectBatchingOption(this.client, preview.paymentRequired);
    const amountAtomic = BigInt(batchingOption.amount);
    const funding = await ensureGatewayBalance(this.client, amountAtomic, {
      bufferUsdc: this.fundingBufferUsdc,
    });

    const paymentPayload = await this.client.createPaymentPayload(
      preview.paymentRequired.x402Version ?? 2,
      batchingOption,
    );

    const paymentHeader = Buffer.from(JSON.stringify({
      ...paymentPayload,
      resource: preview.paymentRequired.resource,
      accepted: batchingOption,
    })).toString('base64');

    const response = await fetch(url, {
      method: requestOptions.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(requestOptions.headers || {}),
        'Payment-Signature': paymentHeader,
      },
      body: requestOptions.body === undefined
        ? undefined
        : (typeof requestOptions.body === 'string' ? requestOptions.body : JSON.stringify(requestOptions.body)),
    });

    const body = await parseResponseBody(response);
    const paymentResponse = decodeBase64Json(response.headers.get('PAYMENT-RESPONSE'));

    if (!response.ok) {
      const error = new Error(`Paid retry failed with status ${response.status}`);
      error.statusCode = response.status;
      error.responseBody = body;
      throw error;
    }

    return {
      preview,
      paid: true,
      status: response.status,
      amountUsdc: ethers.formatUnits(amountAtomic, 6),
      deposited: funding.deposited,
      depositResult: funding.depositResult,
      paymentResponse,
      body,
    };
  }
}

function createArcOracleBuyer(options = {}) {
  return new ArcOracleBuyer(options);
}

module.exports = {
  ArcOracleBuyer,
  createArcOracleBuyer,
  ensureGatewayBalance,
  getAtomicUsdc,
  normalizeUsdcAmount,
  readBalances,
};