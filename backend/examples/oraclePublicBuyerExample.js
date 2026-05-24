'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { createArcOracleBuyer } = require('./arcOracleBuyerHelper');

const SUPPORTED_ENDPOINTS = new Set([
  'stablecoin-fx',
  'pool-state',
  'peg-monitor',
  'pool-compare',
  'wallet-asset-snapshot',
  'prediction-market-check',
  'event-odds-compare',
  'arb-signal',
  'arb-scan-multi',
]);

function printUsage() {
  console.log([
    'Usage:',
    '  node examples/oraclePublicBuyerExample.js --preview',
    '  node examples/oraclePublicBuyerExample.js',
    '',
    'Environment:',
    '  ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url',
    '  ORACLE_PUBLIC_ENDPOINT=pool-state',
    '  ORACLE_PUBLIC_POOL=USDC-EURC',
    '  ORACLE_PUBLIC_ASSETS=USDC,EURC,USDT',
    '  ORACLE_PUBLIC_TARGETS=curve:USDC-EURC,curve:EURC-WUSDC,uniswap_v2_like:QTM-WUSDC',
    '  ORACLE_PUBLIC_WALLET_ADDRESS=0x000000000000000000000000000000000000dEaD',
    '  ORACLE_PUBLIC_TOPIC=crypto',
    '  ORACLE_PUBLIC_PRIMARY_TOPIC=bitcoin',
    '  ORACLE_PUBLIC_SECONDARY_TOPIC=ethereum',
    '  ORACLE_PUBLIC_LIMIT=4',
    '  ORACLE_BUYER_PRIVATE_KEY=0x...',
    '  ORACLE_BUYER_CHAIN=arcTestnet',
    '  ORACLE_BUYER_RPC_URL=https://rpc.testnet.arc.network',
    '  ORACLE_BUYER_FUNDING_BUFFER_USDC=0.00',
    '',
    'Preview mode does not require a private key.',
    'Paid mode requires an EOA private key.',
  ].join('\n'));
}

function parseJsonOrText(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function decodeBase64Json(headerValue) {
  if (!headerValue) return null;

  try {
    return JSON.parse(Buffer.from(String(headerValue), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function buildOracleUrl() {
  const baseUrl = String(process.env.ORACLE_PUBLIC_BASE_URL || '').trim();
  const endpoint = String(process.env.ORACLE_PUBLIC_ENDPOINT || 'pool-state').trim();

  if (!baseUrl) {
    throw new Error('ORACLE_PUBLIC_BASE_URL is required and should point to your public Arc Oracle API base URL');
  }

  if (!SUPPORTED_ENDPOINTS.has(endpoint)) {
    throw new Error(`Unsupported ORACLE_PUBLIC_ENDPOINT: ${endpoint}`);
  }

  const url = new URL(`/api/oracle/public/${endpoint}`, baseUrl);

  if (endpoint === 'stablecoin-fx') {
    url.searchParams.set('pair', process.env.ORACLE_PUBLIC_PAIR || 'EURC/USDC');
  }

  if (endpoint === 'pool-state') {
    url.searchParams.set('pool', process.env.ORACLE_PUBLIC_POOL || 'USDC-EURC');
  }

  if (endpoint === 'peg-monitor') {
    url.searchParams.set('assets', process.env.ORACLE_PUBLIC_ASSETS || 'USDC,EURC,USDT');
  }

  if (endpoint === 'pool-compare') {
    url.searchParams.set('targets', process.env.ORACLE_PUBLIC_TARGETS || 'curve:USDC-EURC,curve:EURC-WUSDC,uniswap_v2_like:QTM-WUSDC');
  }

  if (endpoint === 'wallet-asset-snapshot') {
    url.searchParams.set('walletAddress', process.env.ORACLE_PUBLIC_WALLET_ADDRESS || '0x000000000000000000000000000000000000dEaD');
  }

  if (endpoint === 'prediction-market-check') {
    url.searchParams.set('topic', process.env.ORACLE_PUBLIC_TOPIC || 'crypto');
    url.searchParams.set('limit', process.env.ORACLE_PUBLIC_LIMIT || '4');
  }

  if (endpoint === 'event-odds-compare') {
    url.searchParams.set('primaryTopic', process.env.ORACLE_PUBLIC_PRIMARY_TOPIC || 'bitcoin');
    url.searchParams.set('secondaryTopic', process.env.ORACLE_PUBLIC_SECONDARY_TOPIC || 'ethereum');
    url.searchParams.set('limit', process.env.ORACLE_PUBLIC_LIMIT || '4');
  }

  if (endpoint === 'arb-signal') {
    url.searchParams.set('strategy', process.env.ORACLE_PUBLIC_STRATEGY || 'stablecoin_fx');
  }

  if (endpoint === 'arb-scan-multi') {
    url.searchParams.set('targets', process.env.ORACLE_PUBLIC_TARGETS || 'curve:EURC-USDC,curve:EURC-WUSDC,curve:WUSDC-USDC');
  }

  return url.toString();
}

async function previewOraclePayment(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const raw = await response.text();
  const body = parseJsonOrText(raw);

  return {
    url,
    status: response.status,
    ok: response.ok,
    body,
    paymentRequired: decodeBase64Json(response.headers.get('PAYMENT-REQUIRED')),
  };
}

async function main() {
  const wantsHelp = process.argv.includes('--help');
  const previewOnly = process.argv.includes('--preview');

  if (wantsHelp) {
    printUsage();
    return;
  }

  const url = buildOracleUrl();

  if (previewOnly) {
    const preview = await previewOraclePayment(url);
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const privateKey = String(process.env.ORACLE_BUYER_PRIVATE_KEY || '').trim();
  if (!privateKey) {
    printUsage();
    throw new Error('ORACLE_BUYER_PRIVATE_KEY is required for paid mode');
  }

  const buyer = createArcOracleBuyer({
    privateKey,
    chain: process.env.ORACLE_BUYER_CHAIN || 'arcTestnet',
    rpcUrl: process.env.ORACLE_BUYER_RPC_URL || undefined,
    fundingBufferUsdc: process.env.ORACLE_BUYER_FUNDING_BUFFER_USDC || '0',
  });

  const result = await buyer.pay(url);
  console.log(JSON.stringify({ url, ...result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error.message,
    statusCode: error.statusCode || null,
    responseBody: error.responseBody || null,
  }, null, 2));
  process.exit(1);
});