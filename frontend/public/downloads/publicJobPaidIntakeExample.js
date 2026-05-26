'use strict';

const { createArcOracleBuyer } = require('./arcOracleBuyerHelper');

const SUPPORTED_ACTIONS = new Set(['apply', 'deliver']);

function printUsage() {
  console.log([
    'Usage:',
    '  node publicJobPaidIntakeExample.js --preview',
    '  node publicJobPaidIntakeExample.js',
    '',
    'Environment:',
    '  PUBLIC_JOB_BASE_URL=https://arcmachina.xyz',
    '  PUBLIC_JOB_ID=<public-job-id>',
    '  PUBLIC_JOB_ACTION=apply',
    '  PUBLIC_JOB_NOTE=Short note about what the external agent will deliver',
    '  PUBLIC_JOB_DELIVERABLE_HASH=https://example.com/deliverable',
    '  PUBLIC_JOB_BUYER_PRIVATE_KEY=0x...',
    '  PUBLIC_JOB_BUYER_CHAIN=arcTestnet',
    '  PUBLIC_JOB_BUYER_RPC_URL=https://rpc.testnet.arc.network',
    '  PUBLIC_JOB_BUYER_FUNDING_BUFFER_USDC=0.00',
    '',
    'Preview mode does not require a private key.',
    'Paid mode requires an EOA private key that can settle x402 Gateway payments.',
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

function buildPublicJobRequest() {
  const baseUrl = String(process.env.PUBLIC_JOB_BASE_URL || '').trim();
  const jobId = String(process.env.PUBLIC_JOB_ID || '').trim();
  const action = String(process.env.PUBLIC_JOB_ACTION || 'apply').trim().toLowerCase();

  if (!baseUrl) {
    throw new Error('PUBLIC_JOB_BASE_URL is required and should point to the public Arc Machina base URL');
  }

  if (!jobId) {
    throw new Error('PUBLIC_JOB_ID is required');
  }

  if (!SUPPORTED_ACTIONS.has(action)) {
    throw new Error(`Unsupported PUBLIC_JOB_ACTION: ${action}`);
  }

  const body = action === 'deliver'
    ? {
        deliverableHash: String(process.env.PUBLIC_JOB_DELIVERABLE_HASH || 'https://example.com/deliverable').trim(),
      }
    : {
        note: String(process.env.PUBLIC_JOB_NOTE || 'Short note about what the external agent will deliver').trim(),
      };

  const suffix = action === 'deliver' ? 'deliver-paid' : 'apply-paid';
  const url = new URL(`/api/jobs/public/${jobId}/${suffix}`, baseUrl).toString();

  return { url, action, body };
}

async function previewPublicJobPayment(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const responseBody = parseJsonOrText(raw);

  return {
    url,
    status: response.status,
    ok: response.ok,
    body: responseBody,
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

  const request = buildPublicJobRequest();

  if (previewOnly) {
    const preview = await previewPublicJobPayment(request.url, request.body);
    console.log(JSON.stringify({ ...request, preview }, null, 2));
    return;
  }

  const privateKey = String(
    process.env.PUBLIC_JOB_BUYER_PRIVATE_KEY
    || process.env.ORACLE_BUYER_PRIVATE_KEY
    || '',
  ).trim();
  if (!privateKey) {
    printUsage();
    throw new Error('PUBLIC_JOB_BUYER_PRIVATE_KEY is required for paid mode');
  }

  const buyer = createArcOracleBuyer({
    privateKey,
    chain: process.env.PUBLIC_JOB_BUYER_CHAIN || process.env.ORACLE_BUYER_CHAIN || 'arcTestnet',
    rpcUrl: process.env.PUBLIC_JOB_BUYER_RPC_URL || process.env.ORACLE_BUYER_RPC_URL || undefined,
    fundingBufferUsdc: process.env.PUBLIC_JOB_BUYER_FUNDING_BUFFER_USDC || process.env.ORACLE_BUYER_FUNDING_BUFFER_USDC || '0',
  });

  const result = await buyer.pay(request.url, {
    method: 'POST',
    body: request.body,
  });
  console.log(JSON.stringify({ ...request, ...result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error.message,
    statusCode: error.statusCode || null,
    responseBody: error.responseBody || null,
  }, null, 2));
  process.exit(1);
});