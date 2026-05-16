'use strict';

const gatewayAuditService = require('./gatewayAuditService');
const gatewayBuyerService = require('./gatewayBuyer');
const { logTaskEconomy } = require('./logger');
const { getRevenuePoolAddress, getRevenuePoolSource } = require('./revenuePoolConfig');

const DRY_RUN = process.env.DRY_RUN === 'true';
const TASK_ECONOMY_CHAIN = process.env.TASK_ECONOMY_CHAIN || 'Arc Testnet';
const TASK_ECONOMY_PAY_ADDRESS = process.env.TASK_ECONOMY_PAY_ADDRESS || null;

function getTaskEconomyRecipientConfig() {
  if (TASK_ECONOMY_PAY_ADDRESS) {
    return {
      address: TASK_ECONOMY_PAY_ADDRESS,
      configured: true,
      kind: 'explicit_address',
      source: 'TASK_ECONOMY_PAY_ADDRESS',
    };
  }

  return {
    address: getRevenuePoolAddress(),
    configured: true,
    kind: 'revenue_pool',
    source: getRevenuePoolSource() === 'env'
      ? 'REVENUE_POOL_ADDRESS'
      : 'verified_default_revenue_pool',
  };
}

function getTaskEconomyConfigSummary() {
  const recipient = getTaskEconomyRecipientConfig();

  return {
    mode: 'circle_gateway_execution_fee',
    chain: TASK_ECONOMY_CHAIN,
    sellerAddress: recipient.address,
    recipientAddress: recipient.address,
    recipientKind: recipient.kind,
    configured: recipient.configured,
    payAddressSource: recipient.source,
    dryRun: DRY_RUN,
  };
}

async function finalizeExecutionEconomyResult(result, { agentId, referenceId, referenceType }) {
  const logMeta = {
    agentId,
    feeUsdc: result.feeUsdc,
    rail: result.rail,
    reason: result.reason || null,
    status: result.status,
    referenceId,
    referenceType,
    txHash: result.gatewayMintTxHash || null,
  };

  if (result.status === 'confirmed') {
    logTaskEconomy('info', 'Execution fee settlement confirmed', logMeta);
  } else if (result.status === 'failed') {
    logTaskEconomy('warn', 'Execution fee settlement failed', logMeta);
  } else {
    logTaskEconomy('info', 'Execution fee settlement skipped', logMeta);
  }

  await gatewayAuditService.recordAgenticPaymentEventSafe({
    agentId,
    eventType: 'task_execution_fee',
    rail: result.rail,
    referenceType,
    referenceId,
    txHash: result.gatewayMintTxHash || null,
    amountUsdc: result.feeUsdc,
    token: 'USDC',
    status: result.status,
    sourceChain: result.sourceChain,
    destinationChain: result.destinationChain,
    counterpartyAddress: result.recipient || result.sellerAddress || null,
    payload: result,
  });

  return result;
}

async function settleExecutionFee({
  agent,
  referenceId,
  referenceType = 'task',
  feeUsdc,
  fromChain = TASK_ECONOMY_CHAIN,
  toChain = TASK_ECONOMY_CHAIN,
  mode = 'circle_gateway_execution_fee',
  rail = 'agentic_task_economy',
}) {
  const summary = getTaskEconomyConfigSummary();
  const normalizedFeeUsdc = Number(feeUsdc);
  const base = {
    mode,
    rail,
    referenceId,
    referenceType,
    feeUsdc: normalizedFeeUsdc,
    sourceChain: fromChain,
    destinationChain: toChain,
    sellerAddress: summary.sellerAddress,
    recipientAddress: summary.recipientAddress,
    recipientKind: summary.recipientKind,
  };

  if (!Number.isFinite(normalizedFeeUsdc) || normalizedFeeUsdc <= 0) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'execution_fee_disabled',
    }, { agentId: agent?.id || null, referenceId, referenceType });
  }

  if (DRY_RUN) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'dry_run',
    }, { agentId: agent?.id || null, referenceId, referenceType });
  }

  if (!summary.sellerAddress) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'task_economy_pay_address_missing',
    }, { agentId: agent?.id || null, referenceId, referenceType });
  }

  if (!agent) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'failed',
      reason: 'agent_missing',
    }, { agentId: null, referenceId, referenceType });
  }

  const result = await gatewayBuyerService.executeGatewayTransfer({
    agent,
    amountUsdc: normalizedFeeUsdc,
    recipient: summary.sellerAddress,
    fromChain,
    toChain,
  });

  return finalizeExecutionEconomyResult({
    ...base,
    status: 'confirmed',
    deposited: result.deposited,
    gatewayApprovalTxHash: result.depositResult?.approvalTxHash || null,
    gatewayDepositTxHash: result.depositResult?.depositTxHash || null,
    gatewayMintTxHash: result.transferResult?.mintTxHash || null,
    formattedAmount: result.transferResult?.formattedAmount || String(normalizedFeeUsdc),
    recipient: result.transferResult?.recipient || summary.sellerAddress,
  }, { agentId: agent.id, referenceId, referenceType });
}

async function settleTaskExecutionFee({
  agent,
  taskId,
  feeUsdc,
  fromChain = TASK_ECONOMY_CHAIN,
  toChain = TASK_ECONOMY_CHAIN,
}) {
  return settleExecutionFee({
    agent,
    referenceId: taskId,
    referenceType: 'task',
    feeUsdc,
    fromChain,
    toChain,
    mode: 'circle_gateway_task_fee',
    rail: 'agentic_task_economy',
  });
}

module.exports = {
  getTaskEconomyConfigSummary,
  settleExecutionFee,
  settleTaskExecutionFee,
};