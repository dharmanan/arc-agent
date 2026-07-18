'use strict';

const gatewayAuditService = require('./gatewayAuditService');
const gatewayBuyerService = require('./gatewayBuyer');
const paymentRetryService = require('./paymentRetryService');
const { logTaskEconomy } = require('./logger');
const { getRevenuePoolAddress, getRevenuePoolSource } = require('./revenuePoolConfig');

const DRY_RUN = process.env.DRY_RUN === 'true';
const TASK_ECONOMY_CHAIN = process.env.TASK_ECONOMY_CHAIN || 'Arc Testnet';
const TASK_ECONOMY_PAY_ADDRESS = process.env.TASK_ECONOMY_PAY_ADDRESS || null;
const ARC_RPC_COOLDOWN_CODE = 'ARC_RPC_COOLDOWN';

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

function extractEconomyErrorText(error) {
  return [
    error?.message,
    error?.shortMessage,
    error?.code,
    error?.cause?.message,
    error?.causeMessage,
    error?.error?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isArcRpcCooldownDeferral(error) {
  if (paymentRetryService.isArcRpcCooldownError(error)) {
    return true;
  }

  const code = String(error?.code || '').trim().toUpperCase();
  return code === ARC_RPC_COOLDOWN_CODE;
}

function isPreflightTransientRpcDeferral(error) {
  const text = extractEconomyErrorText(error);

  if (
    text.includes('request limit reached')
    || text.includes('rate limit')
    || text.includes('arc rpc is cooling down')
  ) {
    return true;
  }

  return text.includes('temporarily unavailable')
    || text.includes('service unavailable')
    || text.includes('bad gateway')
    || text.includes('gateway timeout')
    || text.includes('connection reset')
    || text.includes('socket hang up')
    || text.includes('timeout before send');
}

function hasPotentialBroadcastAmbiguity(error) {
  const text = extractEconomyErrorText(error);
  const knownTxHash = Boolean(
    error?.gatewayApprovalTxHash
    || error?.gatewayDepositTxHash
    || error?.gatewayMintTxHash
    || error?.approvalTxHash
    || error?.depositTxHash
    || error?.mintTxHash
    || error?.transactionHash
    || error?.txHash
    || error?.hash,
  );

  if (knownTxHash) return true;

  return text.includes('response timeout')
    || text.includes('timed out')
    || text.includes('already known')
    || text.includes('nonce too low')
    || text.includes('replacement transaction underpriced')
    || text.includes('broadcast')
    || text.includes('submitted');
}

function isPermanentSettlementError(error) {
  const text = extractEconomyErrorText(error);
  return text.includes('invalid signer')
    || text.includes('private key is missing')
    || text.includes('invalid private key')
    || text.includes('valid recipient address is required')
    || text.includes('invalid recipient')
    || text.includes('insufficient funds')
    || text.includes('insufficient_wallet_balance_for_gateway_deposit')
    || text.includes('simulation failed')
    || text.includes('execution reverted')
    || text.includes('contract revert')
    || text.includes('unsupported chain')
    || text.includes('unsupported circle gateway chain mapping')
    || text.includes('invalid configuration')
    || text.includes('permanent validation failure');
}

async function finalizeExecutionEconomyResult(result, { agentId, referenceId, referenceType }, options = {}) {
  const logMeta = {
    agentId,
    feeUsdc: result.feeUsdc,
    rail: result.rail,
    reason: result.reason || null,
    status: result.status,
    referenceId,
    referenceType,
    txHash: result.gatewayMintTxHash || null,
    errorCode: result.errorCode || null,
  };

  if (result.status === 'confirmed') {
    logTaskEconomy('info', 'Execution fee settlement confirmed', logMeta);
  } else if (result.status === 'deferred') {
    logTaskEconomy('info', 'Execution fee settlement deferred', logMeta);
  } else if (result.status === 'failed') {
    logTaskEconomy('warn', 'Execution fee settlement failed', logMeta);
  } else {
    logTaskEconomy('info', 'Execution fee settlement skipped', logMeta);
  }

  if (!options.skipAuditEvent) {
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
  }

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
  idempotencyKey = null,
  replayFingerprint = null,
  retryIntentId = null,
  isRetryAttempt = false,
  skipAuditEvent = false,
}) {
  const summary = getTaskEconomyConfigSummary();
  const normalizedFeeUsdc = Number(feeUsdc);
  const resolvedIdempotencyKey = idempotencyKey || paymentRetryService.buildPaymentIdempotencyKey({
    agentId: agent?.id || null,
    rail,
    referenceType,
    referenceId,
    feeUsdc: normalizedFeeUsdc,
    recipient: summary.sellerAddress,
    sourceChain: fromChain,
    destinationChain: toChain,
  });
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
    idempotencyKey: resolvedIdempotencyKey,
    retryIntentId: retryIntentId || null,
    isRetryAttempt: Boolean(isRetryAttempt),
  };

  if (!Number.isFinite(normalizedFeeUsdc) || normalizedFeeUsdc <= 0) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'execution_fee_disabled',
    }, { agentId: agent?.id || null, referenceId, referenceType }, { skipAuditEvent });
  }

  if (DRY_RUN) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'dry_run',
    }, { agentId: agent?.id || null, referenceId, referenceType }, { skipAuditEvent });
  }

  if (!summary.sellerAddress) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'skipped',
      reason: 'task_economy_pay_address_missing',
    }, { agentId: agent?.id || null, referenceId, referenceType }, { skipAuditEvent });
  }

  if (!agent) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'failed',
      reason: 'agent_missing',
    }, { agentId: null, referenceId, referenceType }, { skipAuditEvent });
  }

  let result;
  try {
    result = await gatewayBuyerService.executeGatewayTransfer({
      agent,
      amountUsdc: normalizedFeeUsdc,
      recipient: summary.sellerAddress,
      fromChain,
      toChain,
      idempotencyKey: resolvedIdempotencyKey,
      replayFingerprint,
      retryIntentId,
      isRetryAttempt,
    });
  } catch (error) {
    const cooldownDeferral = isArcRpcCooldownDeferral(error);
    const transientDeferral = isPreflightTransientRpcDeferral(error);
    const ambiguous = hasPotentialBroadcastAmbiguity(error);
    const permanent = isPermanentSettlementError(error);

    if ((cooldownDeferral || transientDeferral) && !ambiguous && !permanent) {
      let resolvedRetryIntentId = retryIntentId || null;

      if (!isRetryAttempt || !resolvedRetryIntentId) {
        try {
          const retryIntentResult = await paymentRetryService.createOrUpdateRetryIntent({
            idempotencyKey: resolvedIdempotencyKey,
            agentId: agent?.id || null,
            eventType: 'task_execution_fee',
            rail,
            referenceType,
            referenceId,
            feeUsdc: normalizedFeeUsdc,
            token: 'USDC',
            sourceChain: fromChain,
            destinationChain: toChain,
            recipientAddress: summary.sellerAddress,
            status: 'deferred',
            payload: {
              mode,
              retryReason: cooldownDeferral ? 'arc_rpc_cooldown' : 'rpc_unavailable_preflight',
              isRetryAttempt: Boolean(isRetryAttempt),
              retryIntentId: retryIntentId || null,
            },
            lastErrorCode: String(error?.code || (cooldownDeferral ? ARC_RPC_COOLDOWN_CODE : 'rpc_unavailable_preflight')),
            lastError: error?.message || 'Arc RPC is cooling down',
          });

          resolvedRetryIntentId = retryIntentResult?.intent?.id || resolvedRetryIntentId;
        } catch (retryIntentError) {
          logTaskEconomy('warn', 'Failed to persist deferred retry intent', {
            agentId: agent?.id || null,
            referenceType,
            referenceId,
            error: retryIntentError.message,
          });
        }
      }

      return finalizeExecutionEconomyResult({
        ...base,
        status: 'deferred',
        reason: cooldownDeferral ? 'arc_rpc_cooldown' : 'rpc_unavailable_preflight',
        deferred: true,
        retryable: true,
        retryIntentId: resolvedRetryIntentId,
        errorCode: String(error?.code || (cooldownDeferral ? ARC_RPC_COOLDOWN_CODE : 'rpc_unavailable_preflight')),
        error: error?.message || (cooldownDeferral ? 'Arc RPC is cooling down' : 'Arc RPC is temporarily unavailable'),
        retryIntent: {
          id: resolvedRetryIntentId,
          idempotencyKey: resolvedIdempotencyKey,
          mode,
          rail,
          referenceId,
          referenceType,
          feeUsdc: normalizedFeeUsdc,
          fromChain,
          toChain,
          recipient: summary.sellerAddress,
          retryReason: cooldownDeferral ? 'arc_rpc_cooldown' : 'rpc_unavailable_preflight',
        },
      }, { agentId: agent.id, referenceId, referenceType }, { skipAuditEvent });
    }

    throw error;
  }

  const gatewayMintTxHash = result.transferResult?.mintTxHash || null;
  if (!gatewayMintTxHash) {
    return finalizeExecutionEconomyResult({
      ...base,
      status: 'failed',
      reason: 'gateway_transfer_unconfirmed',
      error: 'Gateway transfer confirmation is missing',
      deposited: result.deposited,
      retryIntentId: retryIntentId || null,
      gatewayApprovalTxHash: result.depositResult?.approvalTxHash || null,
      gatewayDepositTxHash: result.depositResult?.depositTxHash || null,
    }, { agentId: agent.id, referenceId, referenceType }, { skipAuditEvent });
  }

  return finalizeExecutionEconomyResult({
    ...base,
    status: 'confirmed',
    deposited: result.deposited,
    gatewayApprovalTxHash: result.depositResult?.approvalTxHash || null,
    gatewayDepositTxHash: result.depositResult?.depositTxHash || null,
    gatewayMintTxHash,
    formattedAmount: result.transferResult?.formattedAmount || String(normalizedFeeUsdc),
    recipient: result.transferResult?.recipient || summary.sellerAddress,
  }, { agentId: agent.id, referenceId, referenceType }, { skipAuditEvent });
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