'use strict';

const gatewayAuditService = require('./gatewayAuditService');
const gatewayBuyerService = require('./gatewayBuyer');
const { logTaskEconomy } = require('./logger');

const DRY_RUN = process.env.DRY_RUN === 'true';
const TASK_ECONOMY_CHAIN = process.env.TASK_ECONOMY_CHAIN || 'Arc Testnet';
const TASK_ECONOMY_PAY_ADDRESS = process.env.TASK_ECONOMY_PAY_ADDRESS
  || process.env.AGENTIC_ECONOMY_PAY_ADDRESS
  || process.env.ORACLE_PAY_ADDRESS
  || null;

function getTaskEconomyAddressSource() {
  if (process.env.TASK_ECONOMY_PAY_ADDRESS) return 'TASK_ECONOMY_PAY_ADDRESS';
  if (process.env.AGENTIC_ECONOMY_PAY_ADDRESS) return 'AGENTIC_ECONOMY_PAY_ADDRESS';
  if (process.env.ORACLE_PAY_ADDRESS) return 'ORACLE_PAY_ADDRESS';
  return 'missing';
}

function getTaskEconomyConfigSummary() {
  return {
    mode: 'circle_gateway_task_fee',
    chain: TASK_ECONOMY_CHAIN,
    sellerAddress: TASK_ECONOMY_PAY_ADDRESS,
    configured: Boolean(TASK_ECONOMY_PAY_ADDRESS),
    payAddressSource: getTaskEconomyAddressSource(),
    dryRun: DRY_RUN,
  };
}

async function finalizeTaskEconomyResult(result, { agentId, taskId }) {
  const logMeta = {
    agentId,
    feeUsdc: result.feeUsdc,
    rail: result.rail,
    reason: result.reason || null,
    status: result.status,
    taskId,
    txHash: result.gatewayMintTxHash || null,
  };

  if (result.status === 'confirmed') {
    logTaskEconomy('info', 'Task fee settlement confirmed', logMeta);
  } else if (result.status === 'failed') {
    logTaskEconomy('warn', 'Task fee settlement failed', logMeta);
  } else {
    logTaskEconomy('info', 'Task fee settlement skipped', logMeta);
  }

  await gatewayAuditService.recordAgenticPaymentEventSafe({
    agentId,
    eventType: 'task_execution_fee',
    rail: result.rail,
    referenceType: 'task',
    referenceId: taskId,
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

async function settleTaskExecutionFee({
  agent,
  taskId,
  feeUsdc,
  fromChain = TASK_ECONOMY_CHAIN,
  toChain = TASK_ECONOMY_CHAIN,
}) {
  const summary = getTaskEconomyConfigSummary();
  const base = {
    mode: summary.mode,
    rail: 'agentic_task_economy',
    taskId,
    feeUsdc: Number(feeUsdc),
    sourceChain: fromChain,
    destinationChain: toChain,
    sellerAddress: summary.sellerAddress,
  };

  if (DRY_RUN) {
    return finalizeTaskEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'dry_run',
    }, { agentId: agent?.id || null, taskId });
  }

  if (!summary.sellerAddress) {
    return finalizeTaskEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'task_economy_pay_address_missing',
    }, { agentId: agent?.id || null, taskId });
  }

  if (!agent) {
    return finalizeTaskEconomyResult({
      ...base,
      status: 'failed',
      reason: 'agent_missing',
    }, { agentId: null, taskId });
  }

  const result = await gatewayBuyerService.executeGatewayTransfer({
    agent,
    amountUsdc: feeUsdc,
    recipient: summary.sellerAddress,
    fromChain,
    toChain,
  });

  return finalizeTaskEconomyResult({
    ...base,
    status: 'confirmed',
    deposited: result.deposited,
    gatewayApprovalTxHash: result.depositResult?.approvalTxHash || null,
    gatewayDepositTxHash: result.depositResult?.depositTxHash || null,
    gatewayMintTxHash: result.transferResult?.mintTxHash || null,
    formattedAmount: result.transferResult?.formattedAmount || String(feeUsdc),
    recipient: result.transferResult?.recipient || summary.sellerAddress,
  }, { agentId: agent.id, taskId });
}

module.exports = {
  getTaskEconomyConfigSummary,
  settleTaskExecutionFee,
};