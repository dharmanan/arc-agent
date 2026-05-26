'use strict';

const path = require('path');
const { ethers } = require('ethers');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { createArcOracleBuyer } = require('./arcOracleBuyerHelper');

const SUPPORTED_ACTIONS = new Set(['apply', 'deliver']);
const AGENTIC_COMMERCE_ADDRESS = process.env.AGENTIC_COMMERCE_ADDRESS || null;
const ARC_RPC_URL = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const AGENTIC_COMMERCE_ABI = [
  'function deliver(uint256 jobId, bytes32 deliverableHash)',
  'function getJob(uint256 jobId) view returns (tuple(uint256 id,address client,address provider,uint256 amount,string description,uint8 status,bytes32 deliverableHash,uint256 createdAt,uint256 updatedAt))',
];

function printUsage() {
  console.log([
    'Usage:',
    '  node examples/publicJobPaidIntakeExample.js --preview',
    '  node examples/publicJobPaidIntakeExample.js',
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

function normalizeAddress(value) {
  return ethers.getAddress(String(value || '').trim());
}

async function loadPublicJob(baseUrl, jobId) {
  const response = await fetch(new URL(`/api/jobs/public/${jobId}`, baseUrl));
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error || `Failed to load public job ${jobId}`);
  }
  return body?.job || body;
}

async function maybeDeliverPublicJobOnchain({ request, privateKey }) {
  if (request.action !== 'deliver') {
    return null;
  }

  if (!AGENTIC_COMMERCE_ADDRESS) {
    return {
      skipped: true,
      reason: 'agentic_commerce_address_missing',
    };
  }

  const job = await loadPublicJob(process.env.PUBLIC_JOB_BASE_URL, process.env.PUBLIC_JOB_ID);
  if (!job?.jobIdOnchain) {
    return {
      skipped: true,
      reason: 'job_id_onchain_missing',
    };
  }

  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, { chainId: 5042002, name: 'Arc Testnet' });
  const signer = new ethers.Wallet(privateKey, provider);
  const signerAddress = normalizeAddress(signer.address);
  const assignedProvider = normalizeAddress(job.providerAddress || '');

  if (signerAddress !== assignedProvider) {
    throw new Error('PUBLIC_JOB_BUYER_PRIVATE_KEY does not match the assigned provider wallet');
  }

  const contract = new ethers.Contract(AGENTIC_COMMERCE_ADDRESS, AGENTIC_COMMERCE_ABI, signer);
  const onchainJob = await contract.getJob(BigInt(job.jobIdOnchain));
  const statusCode = Number(onchainJob.status);
  const statusLabel = ['Open', 'Funded', 'Delivered', 'Completed', 'Cancelled'][statusCode] || 'Unknown';

  if (statusCode === 2 || statusCode === 3) {
    return {
      skipped: true,
      reason: statusCode === 2 ? 'already_delivered' : 'already_completed',
      jobIdOnchain: job.jobIdOnchain,
      statusLabel,
    };
  }

  if (statusCode !== 1) {
    return {
      skipped: true,
      reason: `unexpected_status_${statusCode}`,
      jobIdOnchain: job.jobIdOnchain,
      statusLabel,
    };
  }

  const deliverableHash = String(request.body?.deliverableHash || '').trim();
  const hashBytes = deliverableHash.startsWith('0x')
    ? deliverableHash
    : ethers.keccak256(ethers.toUtf8Bytes(deliverableHash));

  const tx = await contract.deliver(BigInt(job.jobIdOnchain), hashBytes);
  const receipt = await tx.wait(1);

  return {
    skipped: false,
    jobIdOnchain: job.jobIdOnchain,
    txHash: receipt.hash,
    statusBefore: statusLabel,
    statusAfter: 'Delivered',
  };
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

  const onchainDelivery = await maybeDeliverPublicJobOnchain({
    request,
    privateKey,
  });

  const result = await buyer.pay(request.url, {
    method: 'POST',
    body: request.body,
  });
  console.log(JSON.stringify({ ...request, onchainDelivery, ...result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error.message,
    statusCode: error.statusCode || null,
    responseBody: error.responseBody || null,
  }, null, 2));
  process.exit(1);
});