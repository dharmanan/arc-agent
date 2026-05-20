'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const { decrypt } = require('./cryptoService');
const gatewayAuditService = require('./agenticEconomy/gatewayAuditService');
const { recordReputationEvent, EVENT_TYPES } = require('./reputationService');

const DEFAULT_JOB_REVIEW_TIMEOUT_HOURS = 48;
const DEFAULT_JOB_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_JOB_PRUNE_BATCH_SIZE = 200;
const DEFAULT_JOB_PRUNE_MAX_BATCHES_PER_RUN = 10;
const ARC_RPC_URL = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const AGENTIC_COMMERCE_ADDRESS = process.env.AGENTIC_COMMERCE_ADDRESS || null;
const AGENTIC_COMMERCE_ABI = [
  'function cancel(uint256 jobId)',
];

let pruneInFlight = false;
let pruneTimer = null;

function readIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function readPositiveIntegerEnv(name, fallback) {
  const parsed = readIntegerEnv(name, fallback);
  return parsed > 0 ? parsed : fallback;
}

function formatInterval(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

const JOB_REVIEW_TIMEOUT_HOURS = readPositiveIntegerEnv(
  'JOB_REVIEW_TIMEOUT_HOURS',
  DEFAULT_JOB_REVIEW_TIMEOUT_HOURS,
);
const JOB_PRUNE_INTERVAL_MS = readPositiveIntegerEnv(
  'JOB_PRUNE_INTERVAL_MS',
  DEFAULT_JOB_PRUNE_INTERVAL_MS,
);
const JOB_PRUNE_BATCH_SIZE = readPositiveIntegerEnv(
  'JOB_PRUNE_BATCH_SIZE',
  DEFAULT_JOB_PRUNE_BATCH_SIZE,
);
const JOB_PRUNE_MAX_BATCHES_PER_RUN = readPositiveIntegerEnv(
  'JOB_PRUNE_MAX_BATCHES_PER_RUN',
  DEFAULT_JOB_PRUNE_MAX_BATCHES_PER_RUN,
);

function buildJobReviewPolicy(existingPolicy = {}) {
  return {
    mode: 'manual_client_review',
    autoPenalty: true,
    timeoutHours: JOB_REVIEW_TIMEOUT_HOURS,
    timeoutAction: 'delete_without_payout',
    clientPenaltyEvent: EVENT_TYPES.JOB_REVIEW_TIMEOUT,
    disputeState: existingPolicy.disputeState || 'none',
    disputeReason: existingPolicy.disputeReason || '',
    disputeRaisedAt: existingPolicy.disputeRaisedAt || null,
    disputeRaisedBy: existingPolicy.disputeRaisedBy || null,
    note: `Client has ${JOB_REVIEW_TIMEOUT_HOURS} hour(s) to review delivered work. After that the job is hidden, deleted without payout, and the client agent receives a review-timeout reputation penalty.`,
  };
}

async function cancelOnchainJobIfNeeded(job) {
  if (!AGENTIC_COMMERCE_ADDRESS || !job.job_id_onchain || !job.private_key_encrypted) {
    return { status: 'skipped', txHash: null, reason: 'local_only_or_missing_key' };
  }

  try {
    const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, { chainId: 5042002, name: 'Arc Testnet' });
    const signer = new ethers.Wallet(decrypt(job.private_key_encrypted), provider);
    const contract = new ethers.Contract(AGENTIC_COMMERCE_ADDRESS, AGENTIC_COMMERCE_ABI, signer);
    const tx = await contract.cancel(BigInt(job.job_id_onchain));
    const receipt = await tx.wait(1);
    return { status: 'confirmed', txHash: receipt.hash || null };
  } catch (err) {
    console.error(`[JOB_RETENTION] on-chain cancel failed job=${job.id}:`, err.message);
    return { status: 'failed', txHash: null, reason: err.message };
  }
}

async function processExpiredBatch(rows) {
  if (!rows.length) return 0;

  const deleteIds = [];

  for (const row of rows) {
    const cancelResult = await cancelOnchainJobIfNeeded(row);

    deleteIds.push(row.id);

    await gatewayAuditService.recordAgenticPaymentEventSafe({
      agentId: row.agent_id,
      eventType: 'job_review_timeout',
      rail: 'agentic_job_review',
      referenceType: 'job',
      referenceId: row.id,
      txHash: cancelResult.txHash || null,
      amountUsdc: row.amount_usdc,
      token: 'USDC',
      status: cancelResult.status === 'failed' ? 'expired_onchain_cancel_failed' : 'expired',
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
      counterpartyAddress: row.provider_address || null,
      payload: {
        reviewDeadlineAt: row.review_deadline_at,
        onchainCancel: cancelResult,
      },
    });

    await recordReputationEvent(row.agent_id, EVENT_TYPES.JOB_REVIEW_TIMEOUT).catch(() => {});
  }

  await db.query(
    `DELETE FROM agent_jobs
      WHERE id = ANY($1::uuid[])`,
    [deleteIds],
  );

  return deleteIds.length;
}

async function pruneExpiredJobs() {
  if (pruneInFlight) {
    return { enabled: true, skipped: 'in_flight', deletedCount: 0 };
  }

  pruneInFlight = true;

  try {
    let deletedCount = 0;

    for (let batch = 0; batch < JOB_PRUNE_MAX_BATCHES_PER_RUN; batch += 1) {
      const { rows } = await db.query(
        `SELECT j.id,
                j.agent_id,
                j.job_id_onchain,
                j.provider_address,
                j.amount_usdc,
                j.review_deadline_at,
                a.private_key_encrypted
           FROM agent_jobs j
           LEFT JOIN agents a ON a.id = j.agent_id
          WHERE j.status = 'delivered'
            AND j.review_deadline_at IS NOT NULL
            AND j.review_deadline_at <= NOW()
          ORDER BY j.review_deadline_at ASC
          LIMIT $1`,
        [JOB_PRUNE_BATCH_SIZE],
      );

      const batchDeletedCount = await processExpiredBatch(rows);
      deletedCount += batchDeletedCount;

      if (rows.length < JOB_PRUNE_BATCH_SIZE) {
        break;
      }
    }

    if (deletedCount > 0) {
      console.log(
        `[JOB_RETENTION] Pruned ${deletedCount} delivered job(s) after ${JOB_REVIEW_TIMEOUT_HOURS}h review timeout`,
      );
    }

    return { enabled: true, deletedCount };
  } finally {
    pruneInFlight = false;
  }
}

function startJobRetention() {
  if (pruneTimer) return;

  if (JOB_REVIEW_TIMEOUT_HOURS < 1) {
    console.log('[JOB_RETENTION] Disabled (JOB_REVIEW_TIMEOUT_HOURS < 1)');
    return;
  }

  if (JOB_PRUNE_INTERVAL_MS < 60_000) {
    console.log('[JOB_RETENTION] Disabled (JOB_PRUNE_INTERVAL_MS < 60000)');
    return;
  }

  console.log(
    `[JOB_RETENTION] Enabled — delete delivered jobs after ${JOB_REVIEW_TIMEOUT_HOURS}h, interval ${formatInterval(JOB_PRUNE_INTERVAL_MS)}, batch ${JOB_PRUNE_BATCH_SIZE} x ${JOB_PRUNE_MAX_BATCHES_PER_RUN}`,
  );

  pruneExpiredJobs().catch((err) => {
    console.error('[JOB_RETENTION] Initial prune error:', err.message);
  });

  pruneTimer = setInterval(() => {
    pruneExpiredJobs().catch((err) => {
      console.error('[JOB_RETENTION] Scheduled prune error:', err.message);
    });
  }, JOB_PRUNE_INTERVAL_MS);
}

module.exports = {
  buildJobReviewPolicy,
  pruneExpiredJobs,
  startJobRetention,
  JOB_REVIEW_TIMEOUT_HOURS,
};
