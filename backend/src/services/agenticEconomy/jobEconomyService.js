'use strict';

const gatewayBuyerService = require('./gatewayBuyer');
const { logJobEconomy } = require('./logger');
const { buildJobReviewPolicy } = require('../jobRetentionService');

const DRY_RUN = process.env.DRY_RUN === 'true';
const JOB_ECONOMY_CHAIN = process.env.JOB_ECONOMY_CHAIN || 'Arc Testnet';
const JOB_ECONOMY_PAY_ADDRESS = process.env.JOB_ECONOMY_PAY_ADDRESS
  || process.env.AGENTIC_ECONOMY_PAY_ADDRESS
  || process.env.ORACLE_PAY_ADDRESS
  || null;
const JOB_ECONOMY_CREATE_FEE_USDC = Number(process.env.JOB_ECONOMY_CREATE_FEE_USDC || '0.05');

function getJobEconomyAddressSource() {
  if (process.env.JOB_ECONOMY_PAY_ADDRESS) return 'JOB_ECONOMY_PAY_ADDRESS';
  if (process.env.AGENTIC_ECONOMY_PAY_ADDRESS) return 'AGENTIC_ECONOMY_PAY_ADDRESS';
  if (process.env.ORACLE_PAY_ADDRESS) return 'ORACLE_PAY_ADDRESS';
  return 'missing';
}

function normalizeJobEconomyFee() {
  return Number.isFinite(JOB_ECONOMY_CREATE_FEE_USDC) && JOB_ECONOMY_CREATE_FEE_USDC > 0
    ? JOB_ECONOMY_CREATE_FEE_USDC
    : 0;
}

function getJobEconomyConfigSummary() {
  return {
    mode: 'job_escrow_with_gateway_fee',
    rail: 'agentic_job_economy',
    chain: JOB_ECONOMY_CHAIN,
    sellerAddress: JOB_ECONOMY_PAY_ADDRESS,
    createFeeUsdc: normalizeJobEconomyFee(),
    configured: Boolean(JOB_ECONOMY_PAY_ADDRESS),
    payAddressSource: getJobEconomyAddressSource(),
    dryRun: DRY_RUN,
  };
}

function buildJobCreateFeeFailure({
  jobId = null,
  amountUsdc,
  providerAddress,
  description,
  error,
}) {
  const summary = getJobEconomyConfigSummary();

  return {
    mode: 'circle_gateway_job_fee',
    rail: 'agentic_job_economy',
    phase: 'create',
    jobId,
    jobAmountUsdc: Number(amountUsdc),
    providerAddress,
    descriptionPreview: String(description || '').slice(0, 80) || null,
    feeUsdc: summary.createFeeUsdc,
    sourceChain: JOB_ECONOMY_CHAIN,
    destinationChain: JOB_ECONOMY_CHAIN,
    sellerAddress: summary.sellerAddress,
    status: 'failed',
    error,
  };
}

function logJobCreateFeeOutcome(result) {
  const logMeta = {
    feeUsdc: result.feeUsdc,
    jobId: result.jobId,
    phase: result.phase,
    rail: result.rail,
    reason: result.reason || null,
    status: result.status,
    txHash: result.gatewayMintTxHash || null,
  };

  if (result.status === 'confirmed') {
    logJobEconomy('info', 'Job create fee settled', logMeta);
  } else if (result.status === 'failed') {
    logJobEconomy('warn', 'Job create fee failed', logMeta);
  } else {
    logJobEconomy('info', 'Job create fee skipped', logMeta);
  }

  return result;
}

async function settleJobCreateFee({
  agent,
  jobId = null,
  amountUsdc,
  providerAddress,
  description,
  fromChain = JOB_ECONOMY_CHAIN,
  toChain = JOB_ECONOMY_CHAIN,
}) {
  const summary = getJobEconomyConfigSummary();
  const base = {
    mode: 'circle_gateway_job_fee',
    rail: 'agentic_job_economy',
    phase: 'create',
    jobId,
    jobAmountUsdc: Number(amountUsdc),
    providerAddress,
    descriptionPreview: String(description || '').slice(0, 80) || null,
    feeUsdc: summary.createFeeUsdc,
    sourceChain: fromChain,
    destinationChain: toChain,
    sellerAddress: summary.sellerAddress,
  };

  if (summary.createFeeUsdc <= 0) {
    return logJobCreateFeeOutcome({
      ...base,
      status: 'skipped',
      reason: 'job_economy_fee_disabled',
    });
  }

  if (DRY_RUN) {
    return logJobCreateFeeOutcome({
      ...base,
      status: 'skipped',
      reason: 'dry_run',
    });
  }

  if (!summary.sellerAddress) {
    return logJobCreateFeeOutcome({
      ...base,
      status: 'skipped',
      reason: 'job_economy_pay_address_missing',
    });
  }

  if (!agent) {
    return logJobCreateFeeOutcome({
      ...base,
      status: 'failed',
      reason: 'agent_missing',
    });
  }

  const result = await gatewayBuyerService.executeGatewayTransfer({
    agent,
    amountUsdc: summary.createFeeUsdc,
    recipient: summary.sellerAddress,
    fromChain,
    toChain,
  });

  return logJobCreateFeeOutcome({
    ...base,
    status: 'confirmed',
    deposited: result.deposited,
    gatewayApprovalTxHash: result.depositResult?.approvalTxHash || null,
    gatewayDepositTxHash: result.depositResult?.depositTxHash || null,
    gatewayMintTxHash: result.transferResult?.mintTxHash || null,
    recipient: result.transferResult?.recipient || summary.sellerAddress,
  });
}

function buildPayoutState({ jobStatus, txHashSettle = null, jobIdOnchain = null }) {
  const base = {
    mode: 'agentic_commerce_escrow',
    rail: 'agentic_job_escrow',
    onchainJobId: jobIdOnchain || null,
    txHashSettle: txHashSettle || null,
  };

  switch (jobStatus) {
    case 'completed':
      return {
        ...base,
        status: txHashSettle ? 'confirmed' : 'recorded',
      };
    case 'rejected':
      return {
        ...base,
        status: 'rejected',
      };
    case 'cancelled':
      return {
        ...base,
        status: 'cancelled',
      };
    case 'delivered':
      return {
        ...base,
        status: 'awaiting_completion',
      };
    default:
      return {
        ...base,
        status: 'pending',
      };
  }
}

function buildJobEconomy({ economy = null, job }) {
  const existing = economy && typeof economy === 'object' ? economy : {};
  const applications = Array.isArray(existing.applications)
    ? existing.applications
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => ({
          applicantAddress: entry.applicantAddress || null,
          note: entry.note || '',
          createdAt: entry.createdAt || null,
        }))
    : [];

  return {
    mode: 'job_escrow_with_gateway_fee',
    rail: 'agentic_job_economy',
    lifecycle: 'agentic_commerce_escrow',
    createFee: existing.createFee || null,
    applicationsOpen: existing.applicationsOpen === true,
    applications,
    reviewPolicy: buildJobReviewPolicy(existing.reviewPolicy),
    payout: buildPayoutState({
      jobStatus: job?.status,
      txHashSettle: job?.tx_hash_settle,
      jobIdOnchain: job?.job_id_onchain,
    }),
  };
}

module.exports = {
  buildJobCreateFeeFailure,
  buildJobEconomy,
  getJobEconomyConfigSummary,
  settleJobCreateFee,
};