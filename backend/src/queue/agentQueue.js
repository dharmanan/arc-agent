// @ts-nocheck
'use strict';
/**
 * Agent Queue — Bull (Redis-backed)
 *
 * Job types:
 *  - INCOMING_TRANSFER   → notify agent, optionally run LLM analysis
 *  - MARKET_ANALYSIS     → scheduled or triggered by indexer price events
 *  - AGENT_TX            → autonomous tx execution (smart mode only)
 *  - ORACLE_QUERY        → oracle data fetch + decision (oracle_enabled agents only)
 *
 * Concurrency: 5 workers. Failed jobs retry 3× with exponential backoff.
 */
const Bull        = require('bull');
const Redis       = require('ioredis');
const os          = require('os');
const { ethers }  = require('ethers');
const db          = require('../db');
const llmService  = require('../services/llmService');
const ruleEngine  = require('../services/ruleEngine');
const oracle      = require('../services/oracle');
const protocols   = require('../services/protocols');
const agentWalletService = require('../services/agentWalletService');
const positionsService = require('../services/positionsService');
const { recordReputationEvent, EVENT_TYPES } = require('../services/reputationService');
const taskEconomyService = require('../services/agenticEconomy/taskEconomyService');
const agenticTaskExecutionService = require('../services/agenticEconomy/agenticTaskExecutionService');
const { getDailyLimitBypass, isDailyLimitBypassed } = require('../services/dailyLimitBypass');
const nativeLendingRiskService = require('../services/nativeLendingRiskService');
const { evaluateStableAutomationPolicy } = require('../services/stableAutomationPolicy');
const { evaluateLendingAutomationPolicy } = require('../services/lendingAutomationPolicy');
const { evaluateCarryAutomationPolicy } = require('../services/carryAutomationPolicy');
const { evaluateOracleStrategyPolicy } = require('../services/oracleStrategyPolicy');
const { evaluateCirbtcLpAutomationPolicy } = require('../services/cirbtcLpAutomationPolicy');
const bridgeActivityService = require('../services/bridgeActivityService');
const taskRunService = require('../services/taskRunService');
const { ensureGatewayWarmBalance } = require('../services/agenticEconomy/gatewayBuyer');
const { shouldTrackAutoCarryStartHandoff } = require('../services/autoCarryTaskRunPolicy');

const ARC_RPC_URL = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
const ARC_USDC_ADDRESS = process.env.USDC_ADDRESS_ARC || process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
const ARC_EURC_ADDRESS = process.env.EURC_ADDRESS_ARC || process.env.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];
const PAID_GAS_FANOUT_AMOUNT_ETH = String(process.env.SEPOLIA_GAS_FANOUT_AMOUNT_ETH || '0.01');
const DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_MIN_USDC = 1;
const DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_TARGET_USDC = 3;
const GATEWAY_AUTO_WARM_DEBOUNCE_MS = Math.max(
  Number.parseInt(process.env.GATEWAY_AUTO_WARM_DEBOUNCE_MS || '15000', 10) || 15000,
  5000,
);
const gatewayAutoWarmDebounceByAgent = new Map();

const CIRBTC_GLOBAL_GUARD_WINDOW_MINUTES = Math.max(
  Number.parseInt(process.env.CIRBTC_GLOBAL_GUARD_WINDOW_MINUTES || '30', 10) || 30,
  5,
);
const CIRBTC_GLOBAL_GUARD_COOLDOWN_MINUTES = Math.max(
  Number.parseInt(process.env.CIRBTC_GLOBAL_GUARD_COOLDOWN_MINUTES || '45', 10) || 45,
  5,
);
const CIRBTC_GLOBAL_GUARD_MIN_FAILURES = Math.max(
  Number.parseInt(process.env.CIRBTC_GLOBAL_GUARD_MIN_FAILURES || '2', 10) || 2,
  1,
);
const CIRBTC_GLOBAL_GUARD_MIN_AGENTS = Math.max(
  Number.parseInt(process.env.CIRBTC_GLOBAL_GUARD_MIN_AGENTS || '2', 10) || 2,
  1,
);
const CIRBTC_GLOBAL_GUARD_CACHE_MS = Math.max(
  Number.parseInt(process.env.CIRBTC_GLOBAL_GUARD_CACHE_MS || '45000', 10) || 45000,
  5000,
);
const cirbtcGlobalFailureGuardCache = {
  expiresAt: 0,
  state: null,
};

function buildCirbtcGlobalGuardDefaultState(nowMs = Date.now()) {
  return {
    active: false,
    reason: 'not_triggered',
    failureCount: 0,
    impactedAgentCount: 0,
    windowMinutes: CIRBTC_GLOBAL_GUARD_WINDOW_MINUTES,
    cooldownMinutes: CIRBTC_GLOBAL_GUARD_COOLDOWN_MINUTES,
    minFailures: CIRBTC_GLOBAL_GUARD_MIN_FAILURES,
    minAgents: CIRBTC_GLOBAL_GUARD_MIN_AGENTS,
    lastFailureAt: null,
    cooldownUntil: null,
    retryAfterMs: 0,
    checkedAt: new Date(nowMs).toISOString(),
    summary: null,
  };
}

function buildCirbtcGlobalGuardSummary(state = {}) {
  if (!state?.active) {
    return null;
  }

  const retryAfterMinutes = Math.max(Math.ceil(Number(state.retryAfterMs || 0) / 60000), 1);
  return `cirBTC LP add-liquidity is temporarily paused for all agents because ${state.failureCount} recent direct-pair failures hit ${state.impactedAgentCount} agent(s) inside the last ${state.windowMinutes} minutes. The lane will retry in about ${retryAfterMinutes} minute(s).`;
}

async function readCirbtcGlobalFailureGuardState({ forceRefresh = false } = {}) {
  const nowMs = Date.now();

  if (!forceRefresh && Number(cirbtcGlobalFailureGuardCache.expiresAt || 0) > nowMs && cirbtcGlobalFailureGuardCache.state) {
    return cirbtcGlobalFailureGuardCache.state;
  }

  let nextState = buildCirbtcGlobalGuardDefaultState(nowMs);
  try {
    const executionSource = getCirbtcAutomationExecutionSource();
    const routeFailureLikePatterns = [
      '%circle route is currently unavailable for this cirbtc pair%',
      '%direct arc fallback is disabled%',
      '%transaction execution reverted%',
      '%call_exception%',
      '%seeded before zap-in%',
      '%pair reserves are inconsistent%',
      '%liquidity addition down to zero%',
    ];

    const { rows: [aggregate] } = await db.query(
      `SELECT
         COUNT(*)::int AS failure_count,
         COUNT(DISTINCT agent_id)::int AS impacted_agent_count,
         MAX(created_at) AS last_failure_at
       FROM transactions
       WHERE created_at >= NOW() - ($1 * INTERVAL '1 minute')
         AND status = 'failed'
         AND type = 'direct_lp_add'
         AND COALESCE(meta->>'executionSource', '') = $2
         AND (
           COALESCE(meta->>'reason', '') IN ('swap_error', 'execution_error', 'direct_pair_seed_required')
           OR LOWER(COALESCE(meta->>'summary', '')) LIKE ANY($3::text[])
           OR LOWER(COALESCE(meta->>'error', '')) LIKE ANY($3::text[])
           OR LOWER(COALESCE(meta->>'errorSummary', '')) LIKE ANY($3::text[])
         )`,
      [
        CIRBTC_GLOBAL_GUARD_WINDOW_MINUTES,
        executionSource,
        routeFailureLikePatterns,
      ],
    );

    const failureCount = Number(aggregate?.failure_count || 0);
    const impactedAgentCount = Number(aggregate?.impacted_agent_count || 0);
    const lastFailureAtRaw = aggregate?.last_failure_at || null;
    const lastFailureAtMs = lastFailureAtRaw ? new Date(lastFailureAtRaw).getTime() : null;
    const cooldownUntilMs = Number.isFinite(lastFailureAtMs)
      ? lastFailureAtMs + (CIRBTC_GLOBAL_GUARD_COOLDOWN_MINUTES * 60 * 1000)
      : null;
    const retryAfterMs = Number.isFinite(cooldownUntilMs)
      ? Math.max(cooldownUntilMs - nowMs, 0)
      : 0;
    const active = (
      failureCount >= CIRBTC_GLOBAL_GUARD_MIN_FAILURES
      && impactedAgentCount >= CIRBTC_GLOBAL_GUARD_MIN_AGENTS
      && retryAfterMs > 0
    );

    nextState = {
      active,
      reason: active ? 'global_cirbtc_route_guard' : 'not_triggered',
      failureCount,
      impactedAgentCount,
      windowMinutes: CIRBTC_GLOBAL_GUARD_WINDOW_MINUTES,
      cooldownMinutes: CIRBTC_GLOBAL_GUARD_COOLDOWN_MINUTES,
      minFailures: CIRBTC_GLOBAL_GUARD_MIN_FAILURES,
      minAgents: CIRBTC_GLOBAL_GUARD_MIN_AGENTS,
      lastFailureAt: Number.isFinite(lastFailureAtMs) ? new Date(lastFailureAtMs).toISOString() : null,
      cooldownUntil: Number.isFinite(cooldownUntilMs) ? new Date(cooldownUntilMs).toISOString() : null,
      retryAfterMs,
      checkedAt: new Date(nowMs).toISOString(),
      summary: null,
    };
    nextState.summary = buildCirbtcGlobalGuardSummary(nextState);
  } catch (error) {
    console.warn('[QUEUE] cirBTC global failure guard lookup failed:', error.message);
    nextState = {
      ...nextState,
      reason: 'guard_lookup_failed',
      summary: null,
      guardError: error.message,
    };
  }

  cirbtcGlobalFailureGuardCache.state = nextState;
  cirbtcGlobalFailureGuardCache.expiresAt = nowMs + CIRBTC_GLOBAL_GUARD_CACHE_MS;
  return nextState;
}

function shouldUseDryRun(agent) {
  return GLOBAL_DRY_RUN;
}

function normalizeUsdcAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function normalizeOptionalUsdcAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  return normalizeUsdcAmount(amount);
}

function getAgentGatewayAutoTopupConfig(agent) {
  const minAvailableUsdc = normalizeUsdcAmount(
    agent?.gateway_auto_topup_min_usdc ?? DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_MIN_USDC,
  ) || DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_MIN_USDC;
  const targetAvailableUsdc = normalizeUsdcAmount(
    agent?.gateway_auto_topup_target_usdc ?? DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_TARGET_USDC,
  ) || DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_TARGET_USDC;

  return {
    enabled: agent?.gateway_auto_topup_enabled !== false,
    minAvailableUsdc,
    targetAvailableUsdc: Math.max(targetAvailableUsdc, minAvailableUsdc),
  };
}

function pruneGatewayAutoWarmDebounce(now = Date.now()) {
  for (const [agentId, expiresAt] of gatewayAutoWarmDebounceByAgent.entries()) {
    if (!agentId || !Number.isFinite(expiresAt) || expiresAt <= now) {
      gatewayAutoWarmDebounceByAgent.delete(agentId);
    }
  }
}

function getGatewayAutoWarmDebounceRemainingMs(agentId, now = Date.now()) {
  if (!agentId) return 0;
  pruneGatewayAutoWarmDebounce(now);
  const expiresAt = Number(gatewayAutoWarmDebounceByAgent.get(agentId) || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 0;
  return Math.max(Math.ceil(expiresAt - now), 0);
}

function markGatewayAutoWarmDebounce(agentId, now = Date.now()) {
  if (!agentId) return;
  gatewayAutoWarmDebounceByAgent.set(agentId, now + GATEWAY_AUTO_WARM_DEBOUNCE_MS);
}

function isGatewayAutoWarmExpectedSkipError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'AGENT_TX_BUSY' || code === 'TX_REPLAY_BLOCKED' || code === 'AGENT_TX_RATE_LIMITED') {
    return true;
  }

  const status = Number.parseInt(String(error?.status || error?.statusCode || ''), 10);
  if (status === 409 || status === 429) return true;

  const message = String(error?.message || error?.cause?.message || '').trim();
  return /another transaction is already executing|matching transaction was already submitted|rate limit/i.test(message);
}

async function maybeWarmAgentGatewayBalance(agent, trigger, overrides = {}) {
  const baseConfig = getAgentGatewayAutoTopupConfig(agent);
  const config = {
    ...baseConfig,
    minAvailableUsdc: normalizeUsdcAmount(
      overrides.minAvailableUsdc == null ? baseConfig.minAvailableUsdc : overrides.minAvailableUsdc,
    ) || baseConfig.minAvailableUsdc,
    targetAvailableUsdc: Math.max(
      normalizeUsdcAmount(
        overrides.targetAvailableUsdc == null ? baseConfig.targetAvailableUsdc : overrides.targetAvailableUsdc,
      ) || baseConfig.targetAvailableUsdc,
      normalizeUsdcAmount(
        overrides.minAvailableUsdc == null ? baseConfig.minAvailableUsdc : overrides.minAvailableUsdc,
      ) || baseConfig.minAvailableUsdc,
    ),
  };
  if (!config.enabled || !agent?.private_key_encrypted) {
    return {
      attempted: false,
      deposited: false,
      reason: config.enabled ? 'signer_unavailable' : 'disabled',
    };
  }

  const debounceRemainingMs = getGatewayAutoWarmDebounceRemainingMs(agent?.id);
  if (debounceRemainingMs > 0) {
    return {
      attempted: false,
      deposited: false,
      reason: 'debounced',
      retryAfterMs: debounceRemainingMs,
    };
  }
  markGatewayAutoWarmDebounce(agent?.id);

  try {
    const result = await ensureGatewayWarmBalance(agent, {
      chainName: 'Arc Testnet',
      minAvailableUsdc: config.minAvailableUsdc,
      targetAvailableUsdc: config.targetAvailableUsdc,
    });

    if (result?.deposited) {
      console.log(
        `[GATEWAY] Auto-warmed agent=${agent.id} trigger=${trigger} amount=${result.amountUsdc} available=${result?.balancesAfter?.gateway?.formattedAvailable || '0'}`,
      );
    }

    return result;
  } catch (error) {
    if (isGatewayAutoWarmExpectedSkipError(error)) {
      console.log(`[GATEWAY] Auto-warm deferred agent=${agent?.id || 'unknown'} trigger=${trigger}: ${error.message}`);
    } else {
      console.warn(`[GATEWAY] Auto-warm skipped agent=${agent?.id || 'unknown'} trigger=${trigger}: ${error.message}`);
    }
    return {
      attempted: false,
      deposited: false,
      reason: isGatewayAutoWarmExpectedSkipError(error) ? 'deferred' : 'error',
      error: error.message,
      errorCode: error?.code || null,
    };
  }
}

async function getArcTokenBalance(walletAddress, tokenAddress, decimals = 6) {
  if (!walletAddress || !tokenAddress) return 0;
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  const contract = new ethers.Contract(tokenAddress, ERC20_BALANCE_ABI, provider);
  const rawBalance = await contract.balanceOf(walletAddress);
  return normalizeUsdcAmount(ethers.formatUnits(rawBalance, decimals));
}

async function getArcUsdcBalance(walletAddress) {
  return getArcTokenBalance(walletAddress, ARC_USDC_ADDRESS, 6);
}

async function getArcEurcBalance(walletAddress) {
  return getArcTokenBalance(walletAddress, ARC_EURC_ADDRESS, 6);
}

function getStableAutomationTransactionType(operationType) {
  if (operationType === 'add_liquidity') return 'curve_lp_add';
  if (operationType === 'remove_liquidity') return 'curve_lp_remove';
  return 'curve_lp_add';
}

function getStableAutomationTransactionToken(operationType) {
  return 'USDC';
}

function getStableAutomationExecutionSource() {
  return 'stable_lp_policy_v2';
}

function getOracleStrategyTransactionType(operationType) {
  return operationType === 'rebalance' ? 'rebalance' : 'defi_loop_swap';
}

function getOracleStrategyTransactionToken(operationType) {
  return operationType === 'rebalance' ? 'USDC' : 'EURC';
}

function getOracleStrategyExecutionSource() {
  return 'oracle_strategy_v1';
}

const STABLE_COST_BASIS_TRANSACTION_TYPES = new Set(['swap', 'rebalance', 'defi_loop_swap']);

function normalizeExecutionSource(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function classifyStableCostBasisTransaction(row) {
  const type = String(row?.type || '').trim().toLowerCase();
  if (!STABLE_COST_BASIS_TRANSACTION_TYPES.has(type)) return null;

  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  const fromToken = String(meta.fromToken || '').trim().toUpperCase();
  const toToken = String(meta.toToken || '').trim().toUpperCase();
  const isStableSwap = (
    (fromToken === 'USDC' && toToken === 'EURC')
    || (fromToken === 'EURC' && toToken === 'USDC')
  );

  if (!isStableSwap) return null;

  const executionSource = normalizeExecutionSource(meta.executionSource);
  if (executionSource === getOracleStrategyExecutionSource()) return 'oracle_strategy';
  if (!executionSource) return 'manual_stable_swap';
  return null;
}

function resolveOracleCostBasisSource(trackedSources) {
  const trackedSourceSet = trackedSources instanceof Set
    ? trackedSources
    : new Set(Array.isArray(trackedSources) ? trackedSources : []);
  const hasOracle = trackedSourceSet.has('oracle_strategy');
  const hasManual = trackedSourceSet.has('manual_stable_swap');

  if (hasOracle && hasManual) return 'oracle_and_manual_stable_swaps';
  if (hasOracle) return 'oracle_strategy';
  if (hasManual) return 'manual_stable_swaps';
  return null;
}

function getCirbtcAutomationTransactionType(operationType) {
  return operationType === 'remove_liquidity' ? 'direct_lp_remove' : 'direct_lp_add';
}

function getCirbtcAutomationTransactionToken(actionParams = {}, automationPolicy = null) {
  return actionParams?.stableToken || automationPolicy?.metrics?.selectedStableToken || 'USDC';
}

function getCirbtcAutomationExecutionSource() {
  return 'cirbtc_lp_policy_v1';
}

function getLendingAutomationTransactionType(operationType, actionParams = {}) {
  if (operationType === 'forced_lp_reduce') {
    return String(actionParams?.sourceLane || '').toLowerCase() === 'cirbtc_direct_pair_lp'
      ? 'direct_lp_remove'
      : 'curve_lp_remove';
  }
  if (operationType === 'collateral_top_up') return 'lending_collateral_top_up';
  if (operationType === 'utilization_repay') return 'lending_repay';
  if (operationType === 'deleverage') return 'lending_deleverage';
  return 'lending_automation';
}

function getLendingAutomationTransactionToken(actionParams = {}, automationPolicy = null) {
  if (actionParams?.stableToken) return String(actionParams.stableToken).toUpperCase();
  if (automationPolicy?.verdict?.actionAssetSymbol) return String(automationPolicy.verdict.actionAssetSymbol).toUpperCase();
  return 'USDC';
}

function getLendingAutomationExecutionSource() {
  return 'lending_automation_policy_v1';
}

function getCarryAutomationTransactionType() {
  return 'carry_automation';
}

function getCarryAutomationTransactionToken(actionParams = {}, automationPolicy = null) {
  if (actionParams?.stableToken) return String(actionParams.stableToken).toUpperCase();
  if (actionParams?.asset) return String(actionParams.asset).toUpperCase();
  if (automationPolicy?.verdict?.actionAssetSymbol) return String(automationPolicy.verdict.actionAssetSymbol).toUpperCase();
  return 'USDC';
}

function getCarryAutomationExecutionSource() {
  return 'carry_automation_policy_v1';
}

function getCarryAutomationNotionalAmount(automationPolicy) {
  return normalizeUsdcAmount(automationPolicy?.verdict?.suggestedAmountUsdc);
}

function getLendingAutomationNotionalAmount(automationPolicy) {
  return normalizeUsdcAmount(automationPolicy?.verdict?.suggestedAmountUsdc);
}

function getStableAutomationNotionalAmount(stablePolicy) {
  if (stablePolicy?.verdict?.operationType === 'remove_liquidity') {
    return normalizeUsdcAmount(
      stablePolicy?.metrics?.suggestedLpExitValueUsd
        ?? stablePolicy?.verdict?.suggestedAmountUsdc
        ?? stablePolicy?.metrics?.positionValueUsd,
    );
  }
  return normalizeUsdcAmount(stablePolicy?.verdict?.suggestedAmountUsdc);
}

function getOracleStrategyNotionalAmount(automationPolicy) {
  return normalizeUsdcAmount(automationPolicy?.verdict?.suggestedAmountUsdc);
}

function getCirbtcAutomationNotionalAmount(automationPolicy) {
  if (automationPolicy?.verdict?.operationType === 'remove_liquidity') {
    return normalizeUsdcAmount(
      automationPolicy?.metrics?.suggestedExitValueUsd
        ?? automationPolicy?.verdict?.suggestedAmountUsdc
        ?? automationPolicy?.metrics?.positionValueUsd,
    );
  }

  return normalizeUsdcAmount(automationPolicy?.verdict?.suggestedAmountUsdc);
}

function getCirbtcIdleCapitalBudgets({
  stablePolicy = null,
  availableToTradeUsdc = 0,
  availableEurcBalance = 0,
} = {}) {
  const stableMetrics = stablePolicy?.metrics || {};
  const stableOperationType = String(stablePolicy?.verdict?.operationType || '').trim().toLowerCase();
  const stableActionParams = stablePolicy?.verdict?.actionParams || {};
  const stableAddMode = String(stableActionParams.mode || '').trim().toLowerCase();
  const requestedStableAddUsdc = normalizeUsdcAmount(
    stableAddMode === 'balanced'
      ? (stableActionParams.amountUsdc ?? stableActionParams.amount0)
      : (stableActionParams.amountIn ?? stableMetrics.suggestedLiquidityDeployUsdc),
  );
  const requestedStableAddEurc = normalizeUsdcAmount(
    stableAddMode === 'balanced'
      ? (stableActionParams.amountEurc ?? stableActionParams.amount1)
      : 0,
  );
  const reservedUsdc = normalizeUsdcAmount(
    stableOperationType === 'add_liquidity'
      ? Math.min(Number(requestedStableAddUsdc || 0), Number(availableToTradeUsdc || 0))
      : stableOperationType === 'swap'
        ? Math.min(Number(stablePolicy?.verdict?.suggestedAmountUsdc || 0), Number(availableToTradeUsdc || 0))
        : 0,
  );
  const reservedEurc = normalizeUsdcAmount(
    stableOperationType === 'add_liquidity' && stableAddMode === 'balanced'
      ? Math.min(Number(requestedStableAddEurc || 0), Number(availableEurcBalance || 0))
      : stableOperationType === 'rebalance'
      ? Math.min(
          Number(stableMetrics.suggestedRebalanceAmountEurc || stablePolicy?.verdict?.suggestedAmountUsdc || 0),
          Number(availableEurcBalance || 0),
        )
      : 0,
  );

  return {
    usdc: normalizeUsdcAmount(Math.max(Number(availableToTradeUsdc || 0) - reservedUsdc, 0)),
    eurc: normalizeUsdcAmount(Math.max(Number(availableEurcBalance || 0) - reservedEurc, 0)),
    reservedUsdc,
    reservedEurc,
  };
}

function buildDefiLoopDecisionSnapshot({
  status,
  payload = {},
  stablePolicy = null,
  stableLanePolicy = null,
  executionSource = null,
  availableUsdcBalance = null,
  availableEurcBalance = null,
  availableToTradeUsdc = null,
  walletReserveUsdc = null,
  positionSummary = null,
  includeStableLaneDecision = true,
} = {}) {
  const verdict = stablePolicy?.verdict || {};
  const metrics = stablePolicy?.metrics || {};
  const operationType = verdict.operationType || payload?.operationType || null;
  const derivedExecutionSource = executionSource || (operationType ? getStableAutomationExecutionSource(operationType) : null);
  const actionParams = verdict.actionParams && typeof verdict.actionParams === 'object'
    ? verdict.actionParams
    : null;
  const exitQuote = metrics.exitQuote && typeof metrics.exitQuote === 'object'
    ? {
        profitable: metrics.exitQuote.profitable === true,
        inputEurc: normalizeUsdcAmount(metrics.exitQuote.inputEurc),
        expectedUsdcOut: normalizeUsdcAmount(metrics.exitQuote.expectedUsdcOut),
        expectedProfitUsdc: normalizeUsdcAmount(metrics.exitQuote.expectedProfitUsdc),
        referenceUsdcValue: normalizeUsdcAmount(metrics.exitQuote.referenceUsdcValue),
        parityReferenceUsdcValue: normalizeUsdcAmount(metrics.exitQuote.parityReferenceUsdcValue),
        costBasisReferenceUsdcValue: normalizeUsdcAmount(metrics.exitQuote.costBasisReferenceUsdcValue),
        minimumExpectedUsdcOut: normalizeUsdcAmount(metrics.exitQuote.minimumExpectedUsdcOut),
        averageEntryPriceUsdc: normalizeUsdcAmount(metrics.exitQuote.averageEntryPriceUsdc),
        trackedInventoryEurc: normalizeUsdcAmount(metrics.exitQuote.trackedInventoryEurc),
        trackedInventoryCostUsdc: normalizeUsdcAmount(metrics.exitQuote.trackedInventoryCostUsdc),
        protectedEurcReserve: normalizeUsdcAmount(metrics.exitQuote.protectedEurcReserve),
        profitFloorUsdc: normalizeUsdcAmount(metrics.exitQuote.profitFloorUsdc),
        profitBasis: metrics.exitQuote.profitBasis || null,
        costBasisSource: metrics.exitQuote.costBasisSource || null,
        trackedSources: Array.isArray(metrics.exitQuote.trackedSources)
          ? metrics.exitQuote.trackedSources.filter(Boolean)
          : [],
        exitExecutionRail: metrics.exitQuote.exitExecutionRail || null,
        exitRouteStrategy: metrics.exitQuote.exitRouteStrategy || null,
        exitRouteReason: metrics.exitQuote.exitRouteReason || null,
      }
    : null;
  const sameChainSellBackQuoteSource = payload?.sameChainSellBackQuote && typeof payload.sameChainSellBackQuote === 'object'
    ? payload.sameChainSellBackQuote
    : metrics.sameChainSellBackQuote && typeof metrics.sameChainSellBackQuote === 'object'
      ? metrics.sameChainSellBackQuote
      : null;
  const sameChainSellBackQuote = sameChainSellBackQuoteSource
    ? {
        profitable: sameChainSellBackQuoteSource.profitable === true,
        inputUsdc: normalizeUsdcAmount(sameChainSellBackQuoteSource.inputUsdc),
        expectedEurcOut: normalizeUsdcAmount(sameChainSellBackQuoteSource.expectedEurcOut),
        expectedUsdcOut: normalizeUsdcAmount(sameChainSellBackQuoteSource.expectedUsdcOut),
        expectedProfitUsdc: normalizeUsdcAmount(sameChainSellBackQuoteSource.expectedProfitUsdc),
        minimumExpectedUsdcOut: normalizeUsdcAmount(sameChainSellBackQuoteSource.minimumExpectedUsdcOut),
        profitFloorUsdc: normalizeUsdcAmount(sameChainSellBackQuoteSource.profitFloorUsdc),
        exitExecutionRail: sameChainSellBackQuoteSource.exitExecutionRail || null,
        exitRouteStrategy: sameChainSellBackQuoteSource.exitRouteStrategy || null,
        exitRouteReason: sameChainSellBackQuoteSource.exitRouteReason || null,
      }
    : null;

  return {
    recordedAt: new Date().toISOString(),
    status,
    ok: payload?.ok === true,
    action: payload?.action || (verdict.execute === true ? 'execute' : 'hold'),
    reason: payload?.reason || verdict.reason || null,
    summary: verdict.reason || payload?.summary || payload?.error || payload?.reason || null,
    error: payload?.error || null,
    txHash: payload?.txHash || null,
    policyId: stablePolicy?.policyId || null,
    lane: verdict.lane || null,
    execute: verdict.execute === true,
    operationType,
    blockedBy: verdict.blockedBy || null,
    actionAssetSymbol: verdict.actionAssetSymbol || null,
    suggestedAmountUsdc: normalizeUsdcAmount(verdict.suggestedAmountUsdc),
    actionParams,
    executionSource: derivedExecutionSource,
    poolKey: metrics.selectedPoolKey || actionParams?.poolKey || positionSummary?.poolKey || null,
    selectedStableToken: metrics.selectedStableToken || actionParams?.stableToken || null,
    lpAction: metrics.lpAction || actionParams?.lpAction || null,
    targetLpMinUsd: normalizeUsdcAmount(metrics.targetLpMinUsd),
    targetLpTargetUsd: normalizeUsdcAmount(metrics.targetLpTargetUsd),
    targetLpMaxUsd: normalizeUsdcAmount(metrics.targetLpMaxUsd),
    targetLpMinAllocationPct: normalizeUsdcAmount(metrics.targetLpMinAllocationPct),
    targetLpTargetAllocationPct: normalizeUsdcAmount(metrics.targetLpTargetAllocationPct),
    targetLpMaxAllocationPct: normalizeUsdcAmount(metrics.targetLpMaxAllocationPct),
    targetLpAllocationSource: metrics.targetLpAllocationSource || null,
    marketSignalFresh: metrics.marketSignalFresh ?? null,
    positionPresent: metrics.positionPresent ?? Boolean(positionSummary),
    positionValueUsd: normalizeUsdcAmount(metrics.positionValueUsd ?? positionSummary?.valueUsd),
    positionBelowTargetBand: metrics.positionBelowTargetBand ?? null,
    positionAboveTargetBand: metrics.positionAboveTargetBand ?? null,
    suggestedLpExitAmount: metrics.suggestedLpExitAmount || null,
    suggestedLpExitValueUsd: normalizeUsdcAmount(metrics.suggestedLpExitValueUsd),
    withdrawPct: normalizeUsdcAmount(actionParams?.withdrawPct ?? metrics.withdrawPct),
    availableUsdcBalance: normalizeUsdcAmount(availableUsdcBalance),
    availableEurcBalance: normalizeUsdcAmount(availableEurcBalance),
    availableToTradeUsdc: normalizeUsdcAmount(availableToTradeUsdc),
    walletReserveUsdc: normalizeUsdcAmount(walletReserveUsdc),
    exitQuote,
    sameChainSellBackQuote,
    pairSummaries: Array.isArray(metrics.pairSummaries)
      ? metrics.pairSummaries.map((pairSummary) => ({
          poolKey: pairSummary?.poolKey || null,
          stableToken: pairSummary?.stableToken || null,
          selected: pairSummary?.selected === true,
          status: pairSummary?.status || null,
          blockedBy: pairSummary?.blockedBy || null,
          walletStableBalance: normalizeUsdcAmount(pairSummary?.walletStableBalance),
          minBootstrapAmount: normalizeUsdcAmount(pairSummary?.minBootstrapAmount),
          positionPresent: pairSummary?.positionPresent === true,
          positionValueUsd: normalizeUsdcAmount(pairSummary?.positionValueUsd),
          summary: pairSummary?.summary || null,
        }))
      : [],
    manualCooldownUntil: metrics.manualCooldownUntil || null,
    manualCooldownActive: metrics.manualCooldownActive ?? false,
    stableLaneDecision: includeStableLaneDecision
      && stableLanePolicy?.verdict?.lane
      && stableLanePolicy?.verdict?.lane !== verdict.lane
      ? buildStableLaneDecisionSnapshot({
          stableLanePolicy,
          availableUsdcBalance,
          availableEurcBalance,
          availableToTradeUsdc,
          walletReserveUsdc,
          positionSummary,
        })
      : null,
  };
}

function buildStableLaneDecisionSnapshot({
  stableLanePolicy = null,
  availableUsdcBalance = null,
  availableEurcBalance = null,
  availableToTradeUsdc = null,
  walletReserveUsdc = null,
  positionSummary = null,
} = {}) {
  if (!stableLanePolicy?.verdict?.lane) return null;

  return buildDefiLoopDecisionSnapshot({
    status: stableLanePolicy.verdict.execute === true ? 'executed' : 'policy_hold',
    payload: {
      ok: stableLanePolicy.verdict.execute === true,
      action: stableLanePolicy.verdict.execute === true ? 'execute' : 'hold',
      reason: stableLanePolicy.verdict.reason || null,
      summary: stableLanePolicy.verdict.reason || null,
      operationType: stableLanePolicy.verdict.operationType || null,
    },
    stablePolicy: stableLanePolicy,
    executionSource: getStableAutomationExecutionSource(),
    availableUsdcBalance,
    availableEurcBalance,
    availableToTradeUsdc,
    walletReserveUsdc,
    positionSummary,
    includeStableLaneDecision: false,
  });
}

function buildLendingAutomationDecisionSnapshot({
  status,
  payload = {},
  lendingPolicy = null,
  lendingSurface = null,
} = {}) {
  const verdict = lendingPolicy?.verdict || {};
  const metrics = lendingPolicy?.metrics || {};
  const utilizationCapPct = normalizeOptionalUsdcAmount(metrics.utilizationCapPct);

  return {
    recordedAt: new Date().toISOString(),
    status,
    ok: payload?.ok === true,
    action: payload?.action || (verdict.execute === true ? 'execute' : 'hold'),
    reason: payload?.reason || verdict.reason || null,
    summary: payload?.summary || verdict.reason || payload?.error || null,
    error: payload?.error || null,
    txHash: payload?.txHash || null,
    policyId: lendingPolicy?.policyId || null,
    lane: verdict.lane || 'lending_automation',
    execute: verdict.execute === true,
    operationType: verdict.operationType || null,
    blockedBy: verdict.blockedBy || null,
    actionAssetSymbol: verdict.actionAssetSymbol || null,
    suggestedAmountUsdc: normalizeUsdcAmount(verdict.suggestedAmountUsdc),
    actionParams: verdict.actionParams && typeof verdict.actionParams === 'object'
      ? verdict.actionParams
      : null,
    executionSource: getLendingAutomationExecutionSource(),
    healthFactor: metrics.healthFactor ?? lendingSurface?.risk?.healthFactor ?? null,
    healthFactorTrigger: metrics.healthFactorTrigger ?? null,
    totalBorrowUsd: normalizeUsdcAmount(metrics.totalBorrowUsd ?? lendingSurface?.risk?.totalBorrowUsd),
    totalSuppliedUsd: normalizeUsdcAmount(metrics.totalSuppliedUsd ?? lendingSurface?.risk?.totalSuppliedUsd),
    utilizationCapPct,
    breachedAssets: Array.isArray(metrics.breachedAssets) ? metrics.breachedAssets : [],
    recoveryStatus: metrics.recoveryStatus || null,
    collateralTopUpStatus: metrics.collateralTopUpStatus || null,
    safeExitStatus: metrics.safeExitStatus || null,
    plannedSteps: Array.isArray(metrics.plannedSteps) ? metrics.plannedSteps : [],
    neededUsd: normalizeUsdcAmount(metrics.neededUsd),
    targetDebtAsset: metrics.targetDebtAsset || null,
    forcedLpReduction: metrics.forcedLpReduction || null,
  };
}

function buildCarryAutomationDecisionSnapshot({
  status,
  payload = {},
  carryPolicy = null,
  lendingSurface = null,
} = {}) {
  const verdict = carryPolicy?.verdict || {};
  const metrics = carryPolicy?.metrics || {};

  return {
    recordedAt: new Date().toISOString(),
    status,
    ok: payload?.ok === true,
    action: payload?.action || (verdict.execute === true ? 'execute' : 'hold'),
    reason: payload?.reason || verdict.reason || null,
    summary: payload?.summary || verdict.reason || payload?.error || null,
    error: payload?.error || null,
    txHash: payload?.txHash || null,
    policyId: carryPolicy?.policyId || null,
    lane: verdict.lane || 'carry_stable_lp',
    execute: verdict.execute === true,
    operationType: verdict.operationType || null,
    blockedBy: verdict.blockedBy || null,
    actionAssetSymbol: verdict.actionAssetSymbol || null,
    suggestedAmountUsdc: normalizeUsdcAmount(verdict.suggestedAmountUsdc),
    actionParams: verdict.actionParams && typeof verdict.actionParams === 'object'
      ? verdict.actionParams
      : null,
    executionSource: getCarryAutomationExecutionSource(),
    healthFactor: metrics.healthFactor ?? lendingSurface?.risk?.healthFactor ?? null,
    projectedOpenHealthFactor: metrics.projectedOpenHealthFactor ?? null,
    availableBorrowUsd: normalizeUsdcAmount(metrics.availableBorrowUsd ?? lendingSurface?.risk?.availableBorrowUsd),
    totalBorrowUsd: normalizeUsdcAmount(metrics.selectedAsset?.borrowUsd ?? lendingSurface?.risk?.totalBorrowUsd),
    positionValueUsd: normalizeUsdcAmount(metrics.positionValueUsd),
    carryState: metrics.carryState || null,
    exclusiveMode: metrics.exclusiveMode === true,
    selectedStableToken: metrics.selectedAssetSymbol || verdict.actionAssetSymbol || null,
    lpAprPct: normalizeUsdcAmount(metrics.lpYield?.aprPct),
    lpApyPct: normalizeUsdcAmount(metrics.lpYield?.apyPct),
    borrowAprPct: normalizeUsdcAmount(metrics.selectedAsset?.borrowAprPct),
    borrowApyPct: normalizeUsdcAmount(metrics.selectedAsset?.borrowApyPct),
    netCarryAprPct: normalizeUsdcAmount(metrics.selectedAsset?.netCarryAprPct),
    netCarryApyPct: normalizeUsdcAmount(metrics.selectedAsset?.netCarryApyPct),
    estimatedLpUsdPerYear: normalizeUsdcAmount(metrics.estimatedLpUsdPerYear),
    estimatedBorrowCostUsdPerYear: normalizeUsdcAmount(metrics.estimatedBorrowCostUsdPerYear),
    estimatedNetUsdPerYear: normalizeUsdcAmount(metrics.estimatedNetUsdPerYear),
  };
}

async function getAgentPermissionMap(agentId) {
  if (!agentId) return {};

  const { rows } = await db.query(
    'SELECT permission_key, is_enabled FROM agent_permissions WHERE agent_id = $1',
    [agentId],
  );

  return Object.fromEntries(rows.map(row => [row.permission_key, row.is_enabled]));
}

function getTaskPermissionRequirement(taskName) {
  return TASK_PERMISSION_REQUIREMENTS[String(taskName || '').trim().toUpperCase()] || null;
}

function buildTaskPermissionBlockedMessage(taskName, permission) {
  if (permission === 'defi_scan') {
    return `Task ${taskName} is blocked because DeFi Protocol Scanner is disabled for this agent.`;
  }

  if (permission === 'arbitrage') {
    return `Task ${taskName} is blocked because Arbitrage is disabled for this agent.`;
  }

  return `Task ${taskName} is blocked because the required ${permission} permission is disabled for this agent.`;
}

async function guardTaskPermission(taskName, agentId) {
  const normalizedTaskName = String(taskName || '').trim().toUpperCase();
  const permission = getTaskPermissionRequirement(normalizedTaskName);

  if (!permission || !agentId) {
    return { ok: true };
  }

  const permissions = await getAgentPermissionMap(agentId);
  if (permissions[permission] === false) {
    const detail = buildTaskPermissionBlockedMessage(normalizedTaskName, permission);
    return {
      ok: false,
      error: 'permission_blocked',
      reason: 'permission_blocked',
      permission,
      stageKey: 'permission_blocked',
      stageLabel: 'Permission Blocked',
      stageDetail: detail,
      errorSummary: detail,
    };
  }

  return { ok: true };
}

async function executeLendingAutomationTask({ agent, automationPolicy, dryRunEnabled }) {
  const operationType = String(automationPolicy?.verdict?.operationType || '').trim().toLowerCase();
  const actionParams = automationPolicy?.verdict?.actionParams && typeof automationPolicy.verdict.actionParams === 'object'
    ? automationPolicy.verdict.actionParams
    : {};

  if (operationType === 'deleverage') {
    return agenticTaskExecutionService.executeNativeLendingEmergencyDeleverageTask({
      agent,
      dryRun: dryRunEnabled,
    });
  }

  if (operationType === 'collateral_top_up') {
    return agenticTaskExecutionService.executeNativeLendingCollateralTopUpTask({
      agent,
      dryRun: dryRunEnabled,
    });
  }

  if (operationType === 'forced_lp_reduce') {
    if (String(actionParams?.sourceLane || '').toLowerCase() === 'cirbtc_direct_pair_lp') {
      return executeCirbtcLpAutomationTask({
        agent,
        operationType: 'remove_liquidity',
        actionParams,
        dryRunEnabled,
      });
    }

    return executeStableAutomationTask({
      agent,
      operationType: 'remove_liquidity',
      actionParams,
      dryRunEnabled,
    });
  }

  if (operationType === 'utilization_repay') {
    const steps = Array.isArray(actionParams.steps) ? actionParams.steps : [];
    if (steps.length === 0) {
      return { ok: false, reason: 'lending_utilization_repay_steps_missing' };
    }

    const stepResults = [];
    for (const step of steps) {
      const result = await agenticTaskExecutionService.executeNativeLendingRepayTask({
        agent,
        params: {
          asset: step.asset,
          amount: step.amount,
        },
        dryRun: dryRunEnabled,
      });

      if (!result.ok) {
        if (stepResults.length > 0) {
          return {
            ok: true,
            payload: {
              action: 'utilization_repay',
              executionRail: 'arc_native_lending',
              executionSource: getLendingAutomationExecutionSource(),
              dryRun: dryRunEnabled,
              stepsExecuted: stepResults,
              partialFailure: {
                reason: result.reason,
                error: result.error || null,
              },
              executedAt: new Date().toISOString(),
              summary: dryRunEnabled
                ? 'Would reduce reserve utilization with the visible wallet repay plan, but one repay step is currently blocked.'
                : 'Reserve utilization repay started, but one later repay step is currently blocked.',
            },
          };
        }

        return result;
      }

      stepResults.push({
        ...step,
        txHash: result?.payload?.txHash || null,
      });
    }

    return {
      ok: true,
      payload: {
        action: 'utilization_repay',
        executionRail: 'arc_native_lending',
        executionSource: getLendingAutomationExecutionSource(),
        dryRun: dryRunEnabled,
        stepsExecuted: stepResults,
        executedAt: new Date().toISOString(),
        summary: dryRunEnabled
          ? 'Would reduce reserve utilization with the visible wallet repay plan.'
          : 'Reduced reserve utilization with the visible wallet repay plan.',
      },
    };
  }

  return { ok: false, reason: 'lending_automation_operation_unsupported' };
}

async function executeCarryAutomationTask({ agent, automationPolicy, dryRunEnabled, taskRunId = null, sourceTaskId = null }) {
  const operationType = String(automationPolicy?.verdict?.operationType || '').trim().toLowerCase();
  const actionParams = automationPolicy?.verdict?.actionParams && typeof automationPolicy.verdict.actionParams === 'object'
    ? automationPolicy.verdict.actionParams
    : {};
  const stableToken = String(actionParams?.stableToken || actionParams?.asset || automationPolicy?.verdict?.actionAssetSymbol || 'USDC').trim().toUpperCase();

  if (operationType === 'deploy_wallet_balance') {
    const deployResult = await agenticTaskExecutionService.executeCurveLiquidityAddTask({
      agent,
      params: {
        tokenIn: stableToken,
        amountIn: actionParams.amountIn,
      },
      dryRun: dryRunEnabled,
    });

    if (!deployResult.ok) return deployResult;

    return {
      ok: true,
      payload: {
        ...(deployResult.payload || {}),
        action: 'deploy_wallet_balance',
        executionRail: 'carry_stable_lp',
        executionSource: getCarryAutomationExecutionSource(),
        stableToken,
        summary: dryRunEnabled
          ? `Would deploy idle ${actionParams.amountIn} ${stableToken} into the stable LP carry lane.`
          : `Deployed idle ${actionParams.amountIn} ${stableToken} into the stable LP carry lane.`,
      },
    };
  }

  if (operationType === 'repay_wallet_balance') {
    const repayResult = await agenticTaskExecutionService.executeNativeLendingRepayTask({
      agent,
      params: {
        asset: stableToken,
        amount: actionParams.amount,
      },
      dryRun: dryRunEnabled,
    });

    if (!repayResult.ok) return repayResult;

    return {
      ok: true,
      payload: {
        ...(repayResult.payload || {}),
        action: 'repay_wallet_balance',
        executionRail: 'carry_stable_lp',
        executionSource: getCarryAutomationExecutionSource(),
        stableToken,
        summary: dryRunEnabled
          ? `Would repay idle ${stableToken} debt from the wallet to unwind carry risk.`
          : `Repaid idle ${stableToken} debt from the wallet to unwind carry risk.`,
      },
    };
  }

  if (operationType === 'open_carry') {
    const borrowResult = await agenticTaskExecutionService.executeNativeLendingBorrowTask({
      agent,
      params: {
        asset: stableToken,
        amount: actionParams.borrowAmount,
      },
      dryRun: dryRunEnabled,
    });

    if (!borrowResult.ok) return borrowResult;

    const followup = !dryRunEnabled
      ? await queueDefiLoopForAgent(agent?.id, {
          reason: 'carry-open-followup',
          delayMs: CARRY_AUTOMATION_FOLLOWUP_DELAY_MS,
          taskRunId,
          sourceTaskId,
          carryFollowupPhase: 'followup',
        }).catch((error) => ({
          queued: false,
          jobId: null,
          delayMs: CARRY_AUTOMATION_FOLLOWUP_DELAY_MS,
          error: error.message,
        }))
      : null;

    return {
      ok: true,
      payload: {
        ...(borrowResult.payload || {}),
        action: 'open_carry',
        executionRail: 'carry_stable_lp',
        executionSource: getCarryAutomationExecutionSource(),
        stableToken,
        borrowTxHash: borrowResult?.payload?.txHash || null,
        stagedLpDeployAmount: actionParams.amountIn || actionParams.borrowAmount,
        stepsExecuted: [
          {
            step: 'borrow',
            asset: stableToken,
            amount: actionParams.borrowAmount,
            txHash: borrowResult?.payload?.txHash || null,
          },
        ],
        followupQueued: Boolean(followup?.queued),
        followupJobId: followup?.jobId || null,
        followupDelayMs: followup?.delayMs || null,
        followupQueueError: followup?.error || null,
        summary: dryRunEnabled
          ? `Would borrow ${actionParams.borrowAmount} ${stableToken}. A follow-up carry cycle would then deploy the borrowed balance into the stable LP lane.`
          : followup?.queued
            ? `Borrowed ${actionParams.borrowAmount} ${stableToken}. A follow-up carry cycle is already queued${formatCarryFollowupDelayForSummary(followup.delayMs)} to deploy the borrowed balance into the stable LP lane.`
            : `Borrowed ${actionParams.borrowAmount} ${stableToken}. The next carry cycle will deploy the borrowed balance into the stable LP lane.`,
      },
    };
  }

  if (operationType === 'close_carry') {
    const removeResult = await agenticTaskExecutionService.executeCurveLiquidityRemoveTask({
      agent,
      params: {
        lpAmount: actionParams.lpAmount,
        tokenOut: stableToken,
      },
      dryRun: dryRunEnabled,
    });

    if (!removeResult.ok) return removeResult;

    const debtAmount = normalizeUsdcAmount(Number(actionParams?.debtAmount || 0));
    const partialRepayAmount = normalizeUsdcAmount(Math.min(
      Number(removeResult?.payload?.amountOut || 0),
      Number(actionParams?.debtAmount || 0),
    ));
    let repayAmount = debtAmount > 0 ? debtAmount : partialRepayAmount;

    if (!(repayAmount > 0)) {
      return {
        ok: true,
        payload: {
          ...(removeResult.payload || {}),
          action: 'close_carry',
          executionRail: 'carry_stable_lp',
          executionSource: getCarryAutomationExecutionSource(),
          stableToken,
          summary: dryRunEnabled
            ? `Would remove stable LP liquidity back into ${stableToken}.`
            : `Removed stable LP liquidity back into ${stableToken}.`,
        },
      };
    }

    let repayResult = await agenticTaskExecutionService.executeNativeLendingRepayTask({
      agent,
      params: {
        asset: stableToken,
        amount: String(repayAmount),
      },
      dryRun: dryRunEnabled,
    });

    if (
      !repayResult.ok
      && Number(partialRepayAmount) > 0
      && Number(partialRepayAmount) < Number(repayAmount)
      && repayResult.reason === 'lending_wallet_balance_too_low'
    ) {
      repayAmount = partialRepayAmount;
      repayResult = await agenticTaskExecutionService.executeNativeLendingRepayTask({
        agent,
        params: {
          asset: stableToken,
          amount: String(repayAmount),
        },
        dryRun: dryRunEnabled,
      });
    }

    if (!repayResult.ok) {
      return {
        ok: true,
        payload: {
          ...(removeResult.payload || {}),
          action: 'close_carry_partial',
          executionRail: 'carry_stable_lp',
          executionSource: getCarryAutomationExecutionSource(),
          stableToken,
          removeLiquidityTxHash: removeResult?.payload?.txHash || null,
          partialFailure: {
            reason: repayResult.reason,
            error: repayResult.error || null,
          },
          summary: `Closed the stable LP leg into ${stableToken}, but the immediate repay step is currently blocked. The funds remain in the wallet for a later repay.`,
        },
      };
    }

    return {
      ok: true,
      payload: {
        ...(repayResult.payload || {}),
        action: 'close_carry',
        executionRail: 'carry_stable_lp',
        executionSource: getCarryAutomationExecutionSource(),
        stableToken,
        removeLiquidityTxHash: removeResult?.payload?.txHash || null,
        repayTxHash: repayResult?.payload?.txHash || null,
        stepsExecuted: [
          {
            step: 'remove_liquidity',
            asset: stableToken,
            amount: actionParams.lpAmount,
            txHash: removeResult?.payload?.txHash || null,
          },
          {
            step: 'repay',
            asset: stableToken,
            amount: String(repayAmount),
            txHash: repayResult?.payload?.txHash || null,
          },
        ],
        summary: dryRunEnabled
          ? `Would unwind the ${stableToken} carry leg by removing stable LP and repaying debt.`
          : `Unwound the ${stableToken} carry leg by removing stable LP and repaying debt.`,
      },
    };
  }

  return { ok: false, reason: 'unsupported_carry_operation' };
}

function normalizeDefiLoopReason(reason) {
  return String(reason || 'manual')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'manual';
}

const DEFI_LOOP_PRIORITY_CARRY_TASK = 1;
const DEFI_LOOP_PRIORITY_RECOVERY = 2;
const DEFI_LOOP_PRIORITY_MARKET = 10;
const DEFI_LOOP_PRIORITY_SCHEDULED = 20;
const DEFI_LOOP_MAX_ATTEMPTS = Math.min(
  Math.max(parseInt(process.env.DEFI_LOOP_MAX_ATTEMPTS || '2', 10) || 2, 1),
  2,
);
const DEFI_LOOP_RETRY_BACKOFF_MS = Math.max(
  parseInt(process.env.DEFI_LOOP_RETRY_BACKOFF_MS || '1500', 10) || 1500,
  250,
);
const DEFI_LOOP_JOB_TIMEOUT_MS = Math.max(
  parseInt(process.env.DEFI_LOOP_JOB_TIMEOUT_MS || '240000', 10) || 240000,
  60000,
);

function resolveDefiLoopJobPriority(reason, options = {}) {
  const explicitPriority = Number(options.priority);
  if (Number.isFinite(explicitPriority) && explicitPriority > 0) {
    return Math.floor(explicitPriority);
  }

  const normalizedReason = normalizeDefiLoopReason(reason);
  const sourceTaskId = String(options.sourceTaskId || '').trim().toUpperCase();
  if (sourceTaskId === 'EXEC_AUTO_CARRY_START' || normalizedReason.startsWith('carry-')) {
    return DEFI_LOOP_PRIORITY_CARRY_TASK;
  }
  if (normalizedReason.includes('recovery') || Number(options.orphanRecoveryCount || 0) > 0) {
    return DEFI_LOOP_PRIORITY_RECOVERY;
  }
  if (normalizedReason === 'market-analysis') {
    return DEFI_LOOP_PRIORITY_MARKET;
  }

  return DEFI_LOOP_PRIORITY_SCHEDULED;
}

async function queueDefiLoopForAgent(agentId, options = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return { queued: false, jobId: null, delayMs: 0, timeoutMs: DEFI_LOOP_JOB_TIMEOUT_MS };

  if (!options.skipMalformedCleanup) {
    await cleanupMalformedActiveDefiLoopJobs({ agentId: normalizedAgentId, limit: 50 }).catch(() => {});
  }

  if (!options.allowDuplicate) {
    const liveJob = await findLiveDefiLoopJobForAgent(normalizedAgentId).catch(() => null);
    if (liveJob?.id) {
      return {
        queued: false,
        deduped: true,
        existingJobId: String(liveJob.id),
        jobId: String(liveJob.id),
        delayMs: 0,
        timeoutMs: Number(liveJob.opts?.timeout || DEFI_LOOP_JOB_TIMEOUT_MS),
      };
    }
  }

  const delayMs = Math.max(Number(options.delayMs) || 0, 0);
  const timeoutMs = Math.max(Number(options.timeoutMs) || DEFI_LOOP_JOB_TIMEOUT_MS, 60000);
  const reason = normalizeDefiLoopReason(options.reason);
  const jobId = `defi-${normalizedAgentId}-${reason}-${Date.now()}`;
  const priority = resolveDefiLoopJobPriority(reason, options);
  const jobData = { agentId: normalizedAgentId };

  if (options.trigger) jobData.trigger = options.trigger;
  if (options.taskRunId) jobData.taskRunId = options.taskRunId;
  if (options.sourceTaskId) jobData.sourceTaskId = options.sourceTaskId;
  if (options.carryFollowupPhase) jobData.carryFollowupPhase = options.carryFollowupPhase;
  if (Number.isFinite(Number(options.orphanRecoveryCount)) && Number(options.orphanRecoveryCount) > 0) {
    jobData.orphanRecoveryCount = Number(options.orphanRecoveryCount);
  }

  const jobOptions = {
    jobId,
    priority,
    timeout: timeoutMs,
    attempts: DEFI_LOOP_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: DEFI_LOOP_RETRY_BACKOFF_MS },
  };
  if (delayMs > 0) jobOptions.delay = delayMs;

  const job = await queue.add('DEFI_LOOP', jobData, jobOptions);
  const confirmedJob = await queue.getJob(job?.id || jobId);
  if (!confirmedJob) {
    throw new Error(`DEFI_LOOP job ${jobId} was not persisted after queue.add`);
  }

  return {
    queued: true,
    jobId: job?.id || jobId,
    delayMs,
    priority,
    timeoutMs,
  };
}

async function setCarryAutomationEnabled(agentId, enabled) {
  if (!agentId) return;
  await db.query(
    `UPDATE agents SET carry_automation_enabled = $2 WHERE id = $1`,
    [agentId, Boolean(enabled)],
  );
}

async function buildCarryAutomationTaskContext(agent) {
  try {
    const walletAddress = agent?.wallet_address || agent?.walletAddress || null;
    if (!walletAddress) {
      return { ok: false, reason: 'wallet_not_configured' };
    }

    const walletReserveUsdc = normalizeUsdcAmount(Math.max(Number(agent?.defi_wallet_reserve_usdc || 0), 0));
    const [forexRate, lendingSurface, positionContext, usdcBalance, eurcBalance] = await Promise.all([
      oracle.getForexRate('EURC', 'USDC'),
      nativeLendingRiskService.buildLendingSurfaceForWallet(walletAddress),
      readStableCurvePositionContext(walletAddress),
      getArcUsdcBalance(walletAddress).catch(() => 0),
      getArcEurcBalance(walletAddress).catch(() => 0),
    ]);
    const stablePoolState = await _getOracleStablePoolState(forexRate);
    const stableCurvePosition = positionContext?.ok === true ? positionContext.position || null : null;
    const carryPolicy = evaluateCarryAutomationPolicy({
      lendingSurface,
      stablePoolState,
      stableCurvePosition,
      walletBalances: {
        usdc: usdcBalance,
        eurc: eurcBalance,
      },
      maxTradeUsdc: Number(agent?.max_trade_usdc || 0),
      walletReserveUsdc,
    });

    return {
      ok: true,
      carryPolicy,
      snapshot: carryPolicy?.metrics || {},
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'carry_context_unavailable',
      error: error.message,
    };
  }
}

async function executeAutoCarryStartTask({ agent, dryRun, taskRunId }) {
  await _reportTaskRunStage(taskRunId, {
    stageKey: 'carry_start_review',
    stageLabel: 'Carry Start Review',
    stageDetail: 'Reviewing the live carry lane before Auto Carry is enabled.',
  });

  const context = await buildCarryAutomationTaskContext(agent);
  if (!context.ok) return context;

  const snapshot = context.snapshot || {};
  const selectedAsset = snapshot.selectedAsset || null;
  const stableToken = String(
    context.carryPolicy?.verdict?.actionAssetSymbol
    || snapshot.selectedAssetSymbol
    || selectedAsset?.symbol
    || 'USDC',
  ).trim().toUpperCase();
  const carryState = String(snapshot.carryState || 'inactive');
  const lpAmount = normalizeUsdcAmount(Number(snapshot.lpBalance || 0));
  let conversionResult = null;

  if (carryState === 'manual_lp_conflict') {
    if (!(lpAmount > 0)) {
      return {
        ok: false,
        reason: 'carry_manual_lp_balance_unavailable',
        error: 'The live manual stable LP balance could not be resolved.',
      };
    }

    await _reportTaskRunStage(taskRunId, {
      stageKey: 'carry_start_convert_manual_lp',
      stageLabel: 'Manual LP Conversion',
      stageDetail: 'Removing the blocking manual stable LP before Auto Carry takes over.',
    });

    conversionResult = await agenticTaskExecutionService.executeCurveLiquidityRemoveBalancedTask({
      agent,
      params: {
        lpAmount: snapshot.lpBalance,
      },
      dryRun,
    });

    if (!conversionResult.ok) return conversionResult;
  }

  await _reportTaskRunStage(taskRunId, {
    stageKey: 'carry_start_enable',
    stageLabel: 'Enabling Auto Carry',
    stageDetail: 'Saving Auto Carry mode and queueing the next carry review.',
  });

  if (!dryRun) {
    await setCarryAutomationEnabled(agent.id, true);
    agent.carry_automation_enabled = true;
  }

  const shouldTrackKickoffHandoff = shouldTrackAutoCarryStartHandoff({
    dryRun,
    taskRunId,
    carryState,
    carryVerdictExecute: context.carryPolicy?.verdict?.execute === true,
  });

  const kickoff = dryRun
    ? { queued: false, jobId: null, delayMs: 0 }
    : await queueDefiLoopForAgent(agent.id, {
        reason: 'carry-start-task',
        taskRunId: shouldTrackKickoffHandoff ? taskRunId : null,
        sourceTaskId: shouldTrackKickoffHandoff ? 'EXEC_AUTO_CARRY_START' : null,
        carryFollowupPhase: shouldTrackKickoffHandoff ? 'initial' : null,
      }).catch((error) => ({
        queued: false,
        jobId: null,
        delayMs: 0,
        error: error.message,
      }));

  if (!dryRun && !kickoff.queued) {
    const failureSummary = carryState === 'manual_lp_conflict'
      ? 'Removed the manual stable LP and enabled Auto Carry, but the immediate carry review could not be queued. Refresh once, then retry this start product.'
      : 'Enabled Auto Carry, but the immediate carry review could not be queued. Refresh once, then retry this start product.';

    console.error(
      `[QUEUE] Auto Carry start could not queue the immediate review agent=${agent.id}:`,
      kickoff.error || 'unknown error',
    );

    return {
      ok: false,
      reason: 'carry_handoff_queue_failed',
      error: kickoff.error || 'carry_handoff_queue_failed',
      errorSummary: failureSummary,
      payload: {
        ok: false,
        action: 'auto_carry_start',
        executionRail: 'carry_automation_trigger',
        stableToken,
        carryStateBefore: carryState,
        carryAutomationEnabled: true,
        manualLpConverted: Boolean(conversionResult?.ok),
        manualLpBalance: snapshot.lpBalance || null,
        positionValueUsd: snapshot.positionValueUsd || 0,
        blockedBy: context.carryPolicy?.verdict?.blockedBy || null,
        triggerQueued: false,
        triggerJobId: null,
        triggerQueueError: kickoff.error || null,
        conversionTxHash: conversionResult?.payload?.txHash || null,
        conversionSummary: conversionResult?.payload?.summary || null,
        dryRun: false,
        finalAutomationStatus: 'queue_failed',
        reason: 'carry_handoff_queue_failed',
        errorSummary: failureSummary,
        summary: failureSummary,
        executedAt: new Date().toISOString(),
      },
    };
  }

  let summary;
  if (carryState === 'manual_lp_conflict') {
    summary = dryRun
      ? 'Would remove the manual stable LP, enable Auto Carry, and queue the next carry review.'
      : 'Removed the manual stable LP, enabled Auto Carry, and queued the next carry review.';
  } else if (carryState === 'debt_idle') {
    summary = dryRun
      ? 'Would enable Auto Carry and queue the next carry review so the idle borrowed balance can continue into the LP lane.'
      : 'Enabled Auto Carry and queued the next carry review so the idle borrowed balance can continue into the LP lane.';
  } else if (carryState === 'active') {
    summary = dryRun
      ? `Would keep Auto Carry enabled and queue a fresh review for the current ${stableToken} carry lane.`
      : `Auto Carry is enabled and a fresh review was queued for the current ${stableToken} carry lane.`;
  } else if (context.carryPolicy?.verdict?.execute === false && context.carryPolicy?.verdict?.reason) {
    summary = dryRun
      ? `Would enable Auto Carry, but the live lane is currently waiting: ${context.carryPolicy.verdict.reason}`
      : `Enabled Auto Carry. The live lane is currently waiting: ${context.carryPolicy.verdict.reason}`;
  } else {
    summary = dryRun
      ? 'Would enable Auto Carry and queue the next carry review.'
      : 'Enabled Auto Carry and queued the next carry review.';
  }

  return {
    ok: true,
    deferTaskRunCompletion: Boolean(kickoff.queued && shouldTrackKickoffHandoff),
    taskRunStage: kickoff.queued && shouldTrackKickoffHandoff
      ? {
          stageKey: 'carry_handoff_queued',
          stageLabel: 'Auto Carry Handoff',
          stageDetail: 'The paid trigger is locked while the autonomous carry review and any queued follow-up finish.',
        }
      : null,
    payload: {
      action: 'auto_carry_start',
      executionRail: 'carry_automation_trigger',
      stableToken,
      carryStateBefore: carryState,
      carryAutomationEnabled: true,
      manualLpConverted: Boolean(conversionResult?.ok),
      manualLpBalance: snapshot.lpBalance || null,
      positionValueUsd: snapshot.positionValueUsd || 0,
      blockedBy: context.carryPolicy?.verdict?.blockedBy || null,
      triggerQueued: kickoff.queued,
      triggerJobId: kickoff.jobId || null,
      triggerQueueError: kickoff.error || null,
      conversionTxHash: conversionResult?.payload?.txHash || null,
      conversionSummary: conversionResult?.payload?.summary || null,
      dryRun: Boolean(dryRun),
      summary,
      executedAt: new Date().toISOString(),
    },
  };
}

async function executeAutoCarryStopTask({ agent, dryRun, taskRunId }) {
  await _reportTaskRunStage(taskRunId, {
    stageKey: 'carry_stop_review',
    stageLabel: 'Carry Stop Review',
    stageDetail: 'Reviewing the live carry lane before Auto Carry is turned off.',
  });

  const context = await buildCarryAutomationTaskContext(agent);
  if (!context.ok) return context;

  const snapshot = context.snapshot || {};
  const selectedAsset = snapshot.selectedAsset || null;
  const stableToken = String(
    selectedAsset?.symbol
    || snapshot.selectedAssetSymbol
    || context.carryPolicy?.verdict?.actionAssetSymbol
    || 'USDC',
  ).trim().toUpperCase();
  const carryState = String(snapshot.carryState || 'inactive');
  const debtAmount = normalizeUsdcAmount(Number(selectedAsset?.borrowAmount || 0));
  const walletRepayAmount = normalizeUsdcAmount(
    Number(selectedAsset?.priceUsd || 0) > 0
      ? Math.min(
          Number(selectedAsset?.walletDeployableUsd || 0),
          Number(selectedAsset?.borrowUsd || 0),
        ) / Number(selectedAsset.priceUsd)
      : 0,
  );
  let unwindResult = null;

  await _reportTaskRunStage(taskRunId, {
    stageKey: 'carry_stop_disable',
    stageLabel: 'Turning Off Auto Carry',
    stageDetail: 'Saving the carry mode switch-off before any unwind step runs.',
  });

  if (!dryRun) {
    await setCarryAutomationEnabled(agent.id, false);
    agent.carry_automation_enabled = false;
  }

  if (snapshot.currentCarryModeActive && Number(snapshot.lpBalance || 0) > 0) {
    await _reportTaskRunStage(taskRunId, {
      stageKey: 'carry_stop_unwind_lp',
      stageLabel: 'Unwinding Carry LP',
      stageDetail: 'Removing the stable LP and repaying visible debt for the active carry lane.',
    });

    unwindResult = await executeCarryAutomationTask({
      agent,
      automationPolicy: {
        verdict: {
          operationType: 'close_carry',
          actionAssetSymbol: stableToken,
          actionParams: {
            stableToken,
            lpAmount: snapshot.lpBalance,
            debtAmount,
            tokenOut: stableToken,
          },
        },
      },
      dryRunEnabled: dryRun,
    });

    if (!unwindResult.ok) return unwindResult;
  } else if (snapshot.currentDebtIdle && debtAmount > 0 && walletRepayAmount > 0) {
    await _reportTaskRunStage(taskRunId, {
      stageKey: 'carry_stop_repay_idle_debt',
      stageLabel: 'Repaying Idle Debt',
      stageDetail: 'Repaying the visible carry debt from idle wallet balance before stopping.',
    });

    unwindResult = await executeCarryAutomationTask({
      agent,
      automationPolicy: {
        verdict: {
          operationType: 'repay_wallet_balance',
          actionAssetSymbol: stableToken,
          actionParams: {
            asset: stableToken,
            amount: String(walletRepayAmount),
          },
        },
      },
      dryRunEnabled: dryRun,
    });

    if (!unwindResult.ok) return unwindResult;
  }

  let summary;
  if (unwindResult?.payload?.summary) {
    summary = dryRun
      ? `${unwindResult.payload.summary} Auto Carry would then stay off.`
      : `${unwindResult.payload.summary} Auto Carry is now off.`;
  } else if (carryState === 'manual_lp_conflict') {
    summary = dryRun
      ? 'Would turn Auto Carry off without touching the existing manual stable LP.'
      : 'Turned Auto Carry off without touching the existing manual stable LP.';
  } else if (snapshot.currentDebtIdle && debtAmount > 0 && !(walletRepayAmount > 0)) {
    summary = dryRun
      ? `Would turn Auto Carry off. The visible ${stableToken} debt cannot be repaid immediately because the wallet does not hold enough idle balance yet.`
      : `Turned Auto Carry off. The visible ${stableToken} debt cannot be repaid immediately because the wallet does not hold enough idle balance yet.`;
  } else {
    summary = dryRun
      ? 'Would turn Auto Carry off. No active carry leg needs to unwind right now.'
      : 'Turned Auto Carry off. No active carry leg needed to unwind right now.';
  }

  const payload = {
    ...(unwindResult?.payload || {}),
    action: 'auto_carry_stop',
    executionRail: 'carry_automation_trigger',
    stableToken,
    carryState: 'inactive',
    carryStateBefore: carryState,
    carryAutomationEnabled: false,
    blockedBy: null,
    positionValueUsd: 0,
    debtAmount,
    dryRun: Boolean(dryRun),
    summary,
    executedAt: new Date().toISOString(),
  };

  if (!dryRun) {
    await _setAutomationState(agent.id, 'carryAutomation', 'disabled');
    await _setAutomationDecision(agent.id, 'carryAutomation', payload);
  }

  return { ok: true, payload };
}

function getErrorText(value) {
  return value == null ? '' : String(value).trim();
}

function buildExecutionErrorDetails(err) {
  const rawMessage = getErrorText(err?.message || err);
  const reason = getErrorText(err?.reason);
  const providerMessage = getErrorText(err?.info?.error?.message);
  const shortMessage = getErrorText(err?.shortMessage);
  const code = getErrorText(err?.code);
  const haystack = [rawMessage, reason, providerMessage, shortMessage, code].filter(Boolean).join(' ');

  let summary = reason || providerMessage || shortMessage || rawMessage || 'Transaction failed before confirmation.';
  if (/ERC20:\s*transfer amount exceeds balance/i.test(haystack)) {
    summary = 'Agent wallet balance was too low for this trade.';
  } else if (/nonce too low|nonce has already been used|NONCE_EXPIRED/i.test(haystack)) {
    summary = 'Another transaction already used this wallet nonce before this swap was submitted.';
  } else if (/insufficient funds/i.test(haystack)) {
    summary = 'Agent wallet did not have enough native gas token for this transaction.';
  } else if ((/transaction execution reverted/i.test(rawMessage) || code === 'CALL_EXCEPTION') && !reason) {
    summary = 'The on-chain swap reverted, but the RPC node did not return a decoded contract reason.';
  }

  return {
    error: rawMessage || providerMessage || shortMessage || 'Unknown execution error',
    errorSummary: summary,
    errorCode: code || null,
    errorReason: reason || null,
    errorProviderMessage: providerMessage || null,
    errorShortMessage: shortMessage || null,
    errorTxHash: err?.receipt?.hash || err?.transactionHash || null,
    errorReceiptStatus: err?.receipt?.status ?? null,
  };
}

// Upstash Redis: connect via URL (rediss://...)
// Local Docker: connect via host/port
const redisConnection = process.env.REDIS_URL
  ? process.env.REDIS_URL
  : {
      host:     process.env.REDIS_HOST || 'localhost',
      port:     parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    };

const VERBOSE_QUEUE_LOGS = process.env.NODE_ENV !== 'production'
  || ['1', 'true', 'yes', 'on'].includes(String(process.env.VERBOSE_QUEUE_LOGS || '').trim().toLowerCase());

function logQueueVerbose(message, ...args) {
  if (!VERBOSE_QUEUE_LOGS) return;
  console.log(message, ...args);
}

const bullRedisClients = new Set();

function resolveBullRedisListenerCap(registeredHandlerCount = 0) {
  const normalizedHandlerCount = Math.max(Number(registeredHandlerCount) || 0, 0);
  return Math.max(128, (normalizedHandlerCount + 8) * 3);
}

function syncBullRedisListenerCaps(registeredHandlerCount = 0) {
  const listenerCap = resolveBullRedisListenerCap(registeredHandlerCount);
  for (const client of bullRedisClients) {
    client.setMaxListeners(listenerCap);
  }
  return listenerCap;
}

function createBullRedisClient(type) {
  const connectionName = `arc-agent:${type}:${os.hostname()}:${process.pid}`;
  logQueueVerbose(`[QUEUE:${type}] creating ${connectionName}`);
  const client = typeof redisConnection === 'string'
    ? new Redis(redisConnection, {
        connectionName,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
      })
    : new Redis({
        ...redisConnection,
        connectionName,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
      });

  // Bull shares a small set of ioredis clients across every named processor.
  // The listener count scales with the registered handler set, so keep the
  // cap tied to that footprint instead of a stale fixed threshold.
  bullRedisClients.add(client);
  client.setMaxListeners(resolveBullRedisListenerCap());

  client.on('error', (err) => {
    console.error(`[QUEUE:${type}]`, err.message);
  });

  client.on('ready', () => {
    logQueueVerbose(`[QUEUE:${type}] ready ${connectionName}`);
  });

  return client;
}

const QUEUE_DEFAULT_MAX_ATTEMPTS = Math.min(
  Math.max(parseInt(process.env.QUEUE_DEFAULT_MAX_ATTEMPTS || '2', 10) || 2, 1),
  2,
);
const QUEUE_DEFAULT_BACKOFF_DELAY_MS = Math.max(
  parseInt(process.env.QUEUE_DEFAULT_BACKOFF_DELAY_MS || '1500', 10) || 1500,
  250,
);

const queue = new Bull('agent-jobs', {
  createClient: createBullRedisClient,
  defaultJobOptions: {
    attempts:    QUEUE_DEFAULT_MAX_ATTEMPTS,
    backoff:     { type: 'exponential', delay: QUEUE_DEFAULT_BACKOFF_DELAY_MS },
    removeOnComplete: 50,
    removeOnFail:     20,
  },
  settings: {
    // Default stalledInterval=5s = 864k Redis cmds/month → over Upstash free limit.
    // At 300s: ~17k cmds/month from stall checks alone — safe for 500k/month budget.
    stalledInterval:  300_000, // check stalled jobs every 5 min
    lockDuration:     300_000, // job lock TTL must be >= stalledInterval
    lockRenewTime:    150_000, // renew lock at half lockDuration
    maxStalledCount:  2,
  },
});

let localWorkersPaused = true;
const initialLocalWorkerPause = queue.pause(true, true)
  .then(() => {
    console.log('[QUEUE] Local workers paused at boot');
  })
  .catch((err) => {
    console.error('[QUEUE] Could not pause local workers at boot:', err.message);
  });

async function resumeLocalWorkers() {
  await initialLocalWorkerPause;
  if (!localWorkersPaused) return;

  await queue.resume(true);
  localWorkersPaused = false;
  console.log('[QUEUE] Local workers resumed');
}

async function pauseLocalWorkers(force = true) {
  await initialLocalWorkerPause;
  if (localWorkersPaused) return;

  await queue.pause(true, force);
  localWorkersPaused = true;
  console.log(`[QUEUE] Local workers paused${force ? ' (forced)' : ''}`);
}

const REGISTERED_MANUAL_TASK_PROCESSORS = new Map();
const REGISTERED_PAID_TASK_PROCESSORS = new Set();
const PAID_TASK_ACTIVITY_SUPPORTED_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_MANUAL_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_SINGLE',
  'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_DUAL',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_SINGLE',
  'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_DUAL',
  'EXEC_CIRBTC_USDC_ZAP_IN',
  'EXEC_CIRBTC_EURC_ZAP_IN',
  'EXEC_MANUAL_DIRECT_PAIR_SWAP',
  'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_ADD',
  'EXEC_CIRBTC_USDC_LP_REMOVE',
  'EXEC_CIRBTC_EURC_LP_REMOVE',
  'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_SINGLE',
  'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_DUAL',
  'EXEC_LENDING_SUPPLY',
  'EXEC_LENDING_WITHDRAW',
  'EXEC_LENDING_BORROW',
  'EXEC_LENDING_REPAY',
  'EXEC_LENDING_COLLATERAL_TOP_UP',
  'EXEC_LENDING_SAFE_EXIT',
  'EXEC_LENDING_DELEVERAGE',
  'EXEC_LENDING_LIQUIDATE',
  'EXEC_AUTO_CARRY_START',
  'EXEC_AUTO_CARRY_STOP',
  'EXEC_MANUAL_LENDING_SUPPLY',
  'EXEC_MANUAL_LENDING_WITHDRAW',
  'EXEC_MANUAL_LENDING_BORROW',
  'EXEC_MANUAL_LENDING_REPAY',
  'EXEC_MANUAL_LENDING_COLLATERAL_TOP_UP',
  'EXEC_MANUAL_LENDING_SAFE_EXIT',
  'EXEC_MANUAL_LENDING_DELEVERAGE',
  'EXEC_MANUAL_LENDING_LIQUIDATE',
  'EXEC_CCTP_BRIDGE',
  'EXEC_SEPOLIA_GAS_FANOUT',
  'EXEC_ARB',
  'EXEC_REBALANCE',
]);
const PAID_TASK_RUNTIME_ACTIVITY_IDS = new Set([
  'EXEC_CCTP_BRIDGE',
  'EXEC_SEPOLIA_GAS_FANOUT',
]);
const MANUAL_TASK_READY_TIMEOUT_MS = parseInt(process.env.MANUAL_TASK_READY_TIMEOUT_MS || '1200', 10);
const STABLE_MANUAL_ADD_COOLDOWN_TASK_IDS = new Set([
  'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_SINGLE',
  'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_DUAL',
]);
const STABLE_MANUAL_ADD_COOLDOWN_MINUTES = Math.max(
  Number.parseInt(process.env.STABLE_MANUAL_LP_ADD_COOLDOWN_MINUTES || '45', 10) || 45,
  1,
);
const DEFAULT_STABLE_TARGET_LP_ALLOCATION_PCT = 25;
const DEFAULT_STABLE_TARGET_LP_MIN_ALLOCATION_PCT = 20;
const DEFAULT_STABLE_TARGET_LP_MAX_ALLOCATION_PCT = 30;

function toPositiveFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getStableAllocationSnapshot(decision = {}) {
  const minPct = toPositiveFiniteNumber(decision?.targetLpMinAllocationPct) || DEFAULT_STABLE_TARGET_LP_MIN_ALLOCATION_PCT;
  const maxPct = toPositiveFiniteNumber(decision?.targetLpMaxAllocationPct) || DEFAULT_STABLE_TARGET_LP_MAX_ALLOCATION_PCT;
  const unclampedTargetPct = toPositiveFiniteNumber(decision?.targetLpTargetAllocationPct) || DEFAULT_STABLE_TARGET_LP_ALLOCATION_PCT;
  const targetPct = Math.min(Math.max(unclampedTargetPct, minPct), maxPct);

  return {
    minPct,
    targetPct,
    maxPct,
    source: String(decision?.targetLpAllocationSource || '').trim() || 'policy_default',
  };
}

function getStableBandSnapshot(decision = {}, allocationSnapshot = {}) {
  const availableUsdcBalance = toPositiveFiniteNumber(decision?.availableUsdcBalance) || 0;
  const availableEurcBalance = toPositiveFiniteNumber(decision?.availableEurcBalance) || 0;
  const walletReserveUsdc = toPositiveFiniteNumber(decision?.walletReserveUsdc) || 0;
  const positionValueUsd = toPositiveFiniteNumber(decision?.positionValueUsd) || 0;
  const deployableUsdcBalance = normalizeUsdcAmount(Math.max(availableUsdcBalance - walletReserveUsdc, 0));
  const totalStableCapitalUsd = normalizeUsdcAmount(deployableUsdcBalance + availableEurcBalance + positionValueUsd);

  if (totalStableCapitalUsd > 0) {
    return {
      minUsd: normalizeUsdcAmount(totalStableCapitalUsd * ((allocationSnapshot.minPct || 0) / 100)),
      targetUsd: normalizeUsdcAmount(totalStableCapitalUsd * ((allocationSnapshot.targetPct || 0) / 100)),
      maxUsd: normalizeUsdcAmount(totalStableCapitalUsd * ((allocationSnapshot.maxPct || 0) / 100)),
    };
  }

  return {
    minUsd: normalizeUsdcAmount(decision?.targetLpMinUsd),
    targetUsd: normalizeUsdcAmount(decision?.targetLpTargetUsd),
    maxUsd: normalizeUsdcAmount(decision?.targetLpMaxUsd),
  };
}

async function _setStableManualAddCooldown(agentId) {
  if (!agentId) return;

  await db.query(
    `UPDATE agents
        SET stable_manual_cooldown_until = GREATEST(COALESCE(stable_manual_cooldown_until, NOW()), NOW()) + ($1 * INTERVAL '1 minute')
      WHERE id = $2`,
    [STABLE_MANUAL_ADD_COOLDOWN_MINUTES, agentId],
  ).catch(() => {});
}

async function _refreshStableManualAddAutomationState(agentId, payload = {}) {
  if (!agentId) return;

  const { rows: [agent] } = await db.query(
    `SELECT defi_loop_enabled, stable_manual_cooldown_until, defi_loop_last_decision
       FROM agents
      WHERE id = $1`,
    [agentId],
  ).catch(() => ({ rows: [] }));

  if (!agent?.defi_loop_enabled) return;

  const previousDecision = agent.defi_loop_last_decision
    && typeof agent.defi_loop_last_decision === 'object'
    ? agent.defi_loop_last_decision
    : {};
  const allocationSnapshot = getStableAllocationSnapshot(previousDecision);
  const bandSnapshot = getStableBandSnapshot(previousDecision, allocationSnapshot);
  const manualCooldownUntil = agent.stable_manual_cooldown_until || null;
  const manualCooldownActive = Number.isFinite(Date.parse(manualCooldownUntil || '')) && Date.parse(manualCooldownUntil) > Date.now();
  const manualAddSummary = String(payload?.summary || '').trim();
  const summary = manualAddSummary
    ? `${manualAddSummary} Stable LP automation is holding while the manual add cooldown is active, so soft trims and non-emergency exits stay paused.`
    : (manualCooldownUntil
      ? `A manual stable LP add was recorded. Stable LP automation is holding until ${manualCooldownUntil}, so soft trims and non-emergency exits stay paused.`
      : 'A manual stable LP add was recorded. Stable LP automation is holding while soft trims and non-emergency exits stay paused.');

  await _setAutomationState(agentId, 'defiLoop', 'policy_hold');
  await _setAutomationDecision(agentId, 'defiLoop', {
    ...previousDecision,
    recordedAt: payload?.completedAt || payload?.updatedAt || payload?.createdAt || new Date().toISOString(),
    status: 'policy_hold',
    ok: true,
    action: 'hold',
    reason: 'manual_cooldown_active',
    summary,
    error: null,
    txHash: null,
    policyId: 'stable_usdc_eurc_lp_manager_v2',
    lane: 'stable_curve_lp',
    execute: false,
    suggestedAmountUsdc: 0,
    suggestedLpExitAmount: null,
    suggestedLpExitValueUsd: 0,
    operationType: null,
    blockedBy: 'manualCooldown',
    actionParams: null,
    executionSource: 'stable_lp_policy_v2',
    lpAction: null,
    targetLpMinUsd: bandSnapshot.minUsd,
    targetLpTargetUsd: bandSnapshot.targetUsd,
    targetLpMaxUsd: bandSnapshot.maxUsd,
    targetLpMinAllocationPct: allocationSnapshot.minPct,
    targetLpTargetAllocationPct: allocationSnapshot.targetPct,
    targetLpMaxAllocationPct: allocationSnapshot.maxPct,
    targetLpAllocationSource: allocationSnapshot.source,
    manualCooldownUntil,
    manualCooldownActive,
  });
}

function registerTaskProcessor(name, concurrency, handler) {
  const wrappedHandler = async (job) => {
    const taskRunId = job?.data?.taskRunId || null;
    const agentId = job?.data?.agentId || null;

    const permissionGuard = await guardTaskPermission(name, agentId);
    if (!permissionGuard.ok) {
      if (taskRunId) {
        await taskRunService.failTaskRun(taskRunId, {
          error: permissionGuard.error || permissionGuard.reason || 'permission_blocked',
          stageKey: permissionGuard.stageKey || 'permission_blocked',
          stageLabel: permissionGuard.stageLabel || 'Permission Blocked',
          stageDetail: permissionGuard.stageDetail || permissionGuard.errorSummary || null,
          resultPayload: {
            permission: permissionGuard.permission || null,
            reason: permissionGuard.reason || 'permission_blocked',
          },
        }).catch(() => {});
      }
      return permissionGuard;
    }

    if (taskRunId) {
      await taskRunService.markTaskRunRunning(taskRunId, {
        stageKey: 'starting',
        stageLabel: 'Starting',
        stageDetail: 'Worker accepted the task request and is preparing execution.',
      }).catch(() => {});
    }

    try {
      const result = await handler(job);

      if (taskRunId) {
        if (result && result.ok === false) {
          const failureMessage = result.errorSummary || result.stageDetail || result.error || result.reason || 'task_run_failed';
          await taskRunService.failTaskRun(taskRunId, {
            error: failureMessage,
            stageDetail: result.errorSummary || result.stageDetail || result.error || result.reason || null,
            resultPayload: result.payload || null,
          }).catch(() => {});
        } else if (result?.deferTaskRunCompletion === true) {
          const deferredStage = result.taskRunStage || {};
          await taskRunService.updateTaskRunStage(taskRunId, {
            status: 'running',
            stageKey: deferredStage.stageKey || 'awaiting_followup',
            stageLabel: deferredStage.stageLabel || 'Awaiting Follow-Up',
            stageDetail: deferredStage.stageDetail || result?.payload?.summary || 'Task handed off to a follow-up automation run.',
          }).catch(() => {});
        } else {
          if (agentId && STABLE_MANUAL_ADD_COOLDOWN_TASK_IDS.has(name) && result?.payload?.dryRun !== true) {
            await _setStableManualAddCooldown(agentId);
            await _refreshStableManualAddAutomationState(agentId, result?.payload || {});
          }
          await taskRunService.completeTaskRun(taskRunId, {
            resultPayload: result?.payload || result || {},
            stageDetail: result?.payload?.summary || 'Task completed successfully.',
          }).catch(() => {});
        }
      }

      return result;
    } catch (err) {
      if (taskRunId) {
        const errorDetails = buildExecutionErrorDetails(err);
        await taskRunService.failTaskRun(taskRunId, {
          error: errorDetails.errorSummary || errorDetails.error,
          stageDetail: errorDetails.errorSummary || errorDetails.error,
          resultPayload: errorDetails,
        }).catch(() => {});
      }
      throw err;
    }
  };

  REGISTERED_MANUAL_TASK_PROCESSORS.set(name, wrappedHandler);
  queue.process(name, concurrency, wrappedHandler);
}

function _withTimeout(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(code);
        error.code = code;
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

async function canQueueManualTasks(timeoutMs = MANUAL_TASK_READY_TIMEOUT_MS) {
  try {
    await _withTimeout(queue.isReady(), timeoutMs, 'manual_task_queue_timeout');
    return true;
  } catch (err) {
    console.error('[QUEUE] Manual task queue unavailable:', err.message);
    return false;
  }
}

async function runTaskInline(taskName, data) {
  const handler = REGISTERED_MANUAL_TASK_PROCESSORS.get(taskName);
  if (!handler) {
    throw new Error(`manual_task_processor_missing:${taskName}`);
  }

  return handler({
    id: `inline-${taskName}-${Date.now()}`,
    data,
  });
}

async function queueManualTask(taskName, data) {
  const handler = REGISTERED_MANUAL_TASK_PROCESSORS.get(taskName);
  if (!handler) {
    const error = new Error('manual_task_processor_missing');
    error.code = 'manual_task_processor_missing';
    throw error;
  }

  const manualJob = {
    id: `manual-${taskName}-${data?.agentId || 'unknown'}-${Date.now()}`,
    data,
  };

  setImmediate(() => {
    Promise.resolve(handler(manualJob))
      .then((result) => {
        if (result && result.ok === false) {
          console.warn(`[QUEUE] Job ${manualJob.id} finished with local failure:`, result.reason || result.error || 'task_run_failed');
          return;
        }

        console.log(`[QUEUE] Job ${manualJob.id} completed`);
      })
      .catch((err) => {
        console.error(`[QUEUE] Job ${manualJob.id} failed:`, err.message);
      });
  });

  return {
    id: manualJob.id,
    mode: 'in_process_detached',
  };
}

function _shortTxHash(txHash) {
  if (!txHash || typeof txHash !== 'string' || txHash.length < 12) return null;
  return `${txHash.slice(0, 6)}...${txHash.slice(-4)}`;
}

function _buildBridgeStageMeta(step, params = {}, data = {}) {
  const fromChain = params.fromChain || 'the source chain';
  const toChain = params.toChain || 'the destination chain';
  const burnHash = _shortTxHash(data?.burnTxHash);
  const approveHash = _shortTxHash(data?.approveTxHash);
  const mintHash = _shortTxHash(data?.mintTxHash);
  const attestationLagNote = toChain === 'Arbitrum Sepolia'
    ? 'This attestation leg can take up to 10 minutes before Arbitrum Sepolia is ready to mint.'
    : 'This attestation leg can take a few minutes before the destination mint is ready.';

  switch (step) {
    case 'approving':
      return {
        stageKey: 'bridge_approving',
        stageLabel: 'Approving USDC',
        stageDetail: `Submitting USDC approval on ${fromChain}.`,
      };
    case 'approved':
      return {
        stageKey: 'bridge_approved',
        stageLabel: 'Approval Confirmed',
        stageDetail: approveHash
          ? `Approval confirmed on ${fromChain} (${approveHash}). Preparing the Circle burn.`
          : `Approval confirmed on ${fromChain}. Preparing the Circle burn.`,
      };
    case 'burning':
      return {
        stageKey: 'bridge_burning',
        stageLabel: 'Burning On Source',
        stageDetail: `Submitting the Circle burn transaction on ${fromChain}.`,
      };
    case 'burned':
      return {
        stageKey: 'bridge_burned',
        stageLabel: 'Burn Confirmed',
        stageDetail: burnHash
          ? `Burn confirmed on ${fromChain} (${burnHash}). Waiting for Circle attestation before minting on ${toChain}.`
          : `Burn confirmed on ${fromChain}. Waiting for Circle attestation before minting on ${toChain}.`,
      };
    case 'attesting':
      return {
        stageKey: 'bridge_attesting',
        stageLabel: 'Waiting For Attestation',
        stageDetail: `${attestationLagNote} Keep this task locked until the mint step starts.`,
      };
    case 'attested':
      return {
        stageKey: 'bridge_attested',
        stageLabel: 'Attestation Ready',
        stageDetail: `Circle attestation is ready. Preparing the destination mint on ${toChain}.`,
      };
    case 'minting':
      return {
        stageKey: 'bridge_minting',
        stageLabel: 'Minting On Destination',
        stageDetail: `Submitting receiveMessage on ${toChain}.`,
      };
    case 'complete':
      return {
        stageKey: 'bridge_complete',
        stageLabel: 'Bridge Completed',
        stageDetail: mintHash
          ? `Mint confirmed on ${toChain} (${mintHash}).`
          : `Mint confirmed on ${toChain}.`,
      };
    default:
      return {
        stageKey: 'bridge_running',
        stageLabel: 'Bridge Running',
        stageDetail: `Bridge execution is in progress from ${fromChain} to ${toChain}.`,
      };
  }
}

function _buildGasFanoutStageMeta(step, data = {}) {
  const toChain = data.toChain || 'destination chain';
  const topUpHash = _shortTxHash(data?.topUpTxHash);

  switch (step) {
    case 'preparing':
      return {
        stageKey: 'fanout_preparing',
        stageLabel: 'Preparing Fanout',
        stageDetail: 'Preparing the Sepolia gas fanout to all configured destination testnets.',
      };
    case 'bridging':
      return {
        stageKey: 'fanout_bridging',
        stageLabel: `Bridging To ${toChain}`,
        stageDetail: `Submitting the source-chain bridge leg from Sepolia to ${toChain}.`,
      };
    case 'awaiting_arrival':
      return {
        stageKey: 'fanout_awaiting_arrival',
        stageLabel: `Waiting For ${toChain}`,
        stageDetail: toChain === 'Arbitrum Sepolia'
          ? 'Source tx is confirmed. Arbitrum Sepolia credit can take up to 10 minutes before the destination ETH balance updates.'
          : `Source tx is confirmed. Waiting for the destination ETH balance on ${toChain} to update.`,
      };
    case 'arrived':
      return {
        stageKey: 'fanout_arrived',
        stageLabel: `${toChain} Funded`,
        stageDetail: topUpHash
          ? `Destination ETH balance updated for ${toChain}. Source bridge tx: ${topUpHash}.`
          : `Destination ETH balance updated for ${toChain}.`,
      };
    case 'complete':
      return {
        stageKey: 'fanout_complete',
        stageLabel: 'Gas Fanout Completed',
        stageDetail: 'All destination testnets reported the expected ETH top-up.',
      };
    default:
      return {
        stageKey: 'fanout_running',
        stageLabel: 'Gas Fanout Running',
        stageDetail: 'Sepolia gas fanout is currently in progress.',
      };
  }
}

async function _reportTaskRunStage(taskRunId, stageMeta) {
  if (!taskRunId || !stageMeta) return;

  await taskRunService.updateTaskRunStage(taskRunId, {
    status: 'running',
    stageKey: stageMeta.stageKey,
    stageLabel: stageMeta.stageLabel,
    stageDetail: stageMeta.stageDetail,
  }).catch(() => {});
}

const LLM_AUTH_FAILURE_COOLDOWN_MS = Math.max(
  Number.parseInt(process.env.LLM_AUTH_FAILURE_COOLDOWN_MS || '300000', 10) || 300000,
  60000,
);
const LLM_AUTH_FALLBACK_LOG_COOLDOWN_MS = Math.max(
  Number.parseInt(process.env.LLM_AUTH_FALLBACK_LOG_COOLDOWN_MS || '180000', 10) || 180000,
  15000,
);
const llmAuthFailureCooldownByAgent = new Map();
const llmAuthFallbackLogCooldownByAgent = new Map();

function pruneLlmAuthFailureCooldowns(now = Date.now()) {
  for (const [agentId, expiresAt] of llmAuthFailureCooldownByAgent.entries()) {
    if (!agentId || !Number.isFinite(expiresAt) || expiresAt <= now) {
      llmAuthFailureCooldownByAgent.delete(agentId);
    }
  }
}

function isAgentInLlmAuthFailureCooldown(agentId) {
  if (!agentId) return false;
  pruneLlmAuthFailureCooldowns();
  const expiresAt = Number(llmAuthFailureCooldownByAgent.get(agentId) || 0);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function markAgentLlmAuthFailure(agentId) {
  if (!agentId) return;
  llmAuthFailureCooldownByAgent.set(agentId, Date.now() + LLM_AUTH_FAILURE_COOLDOWN_MS);
}

function clearAgentLlmAuthFailure(agentId) {
  if (!agentId) return;
  llmAuthFailureCooldownByAgent.delete(agentId);
}

function pruneLlmAuthFallbackLogCooldowns(now = Date.now()) {
  for (const [agentId, expiresAt] of llmAuthFallbackLogCooldownByAgent.entries()) {
    if (!agentId || !Number.isFinite(expiresAt) || expiresAt <= now) {
      llmAuthFallbackLogCooldownByAgent.delete(agentId);
    }
  }
}

function shouldLogLlmAuthFallback(agentId, now = Date.now()) {
  if (!agentId) return true;
  pruneLlmAuthFallbackLogCooldowns(now);
  const expiresAt = Number(llmAuthFallbackLogCooldownByAgent.get(agentId) || 0);
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    return false;
  }
  llmAuthFallbackLogCooldownByAgent.set(agentId, now + LLM_AUTH_FALLBACK_LOG_COOLDOWN_MS);
  return true;
}

function logLlmAuthFallback(scope, agentId, error) {
  const message = String(error?.message || error?.cause?.message || error || 'unknown auth error').trim();
  if (!shouldLogLlmAuthFallback(agentId)) {
    return;
  }
  console.warn(`[QUEUE] ${scope} auth fallback agent=${agentId}: ${message}`);
}

// ── Engine selector — use LLM when key is available, fall back to rule engine ──
async function resolveEngine(agent, agentId = null) {
  if (isAgentInLlmAuthFailureCooldown(agentId)) {
    return { engine: ruleEngine, apiKey: null, reason: 'llm_auth_cooldown' };
  }

  if (!agent?.llm_api_key_encrypted) return { engine: ruleEngine, apiKey: null };
  try {
    const { decrypt } = require('../services/cryptoService');
    const apiKey = decrypt(agent.llm_api_key_encrypted);
    return apiKey ? { engine: llmService, apiKey } : { engine: ruleEngine, apiKey: null };
  } catch {
    return { engine: ruleEngine, apiKey: null };
  }
}

function isLlmAuthError(error) {
  const statusCandidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.cause?.status,
  ];

  const hasAuthStatus = statusCandidates
    .map((value) => Number.parseInt(String(value || ''), 10))
    .some((value) => value === 401 || value === 403);
  if (hasAuthStatus) return true;

  const code = String(error?.code || '').trim().toLowerCase();
  if (code === 'unauthorized' || code === 'invalid_api_key' || code === 'authentication_error') {
    return true;
  }

  const message = String(
    error?.message
    || error?.shortMessage
    || error?.cause?.message
    || error?.response?.data?.error?.message
    || '',
  ).trim();

  return /401|403|invalid api key|incorrect api key|authentication|unauthorized|forbidden/i.test(message);
}

function parseStructuredDecision(rawDecision) {
  if (!rawDecision) return null;
  if (typeof rawDecision === 'object') return rawDecision;
  if (typeof rawDecision !== 'string') return null;

  const trimmed = rawDecision.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeMarketSignalConfidence(value, fallback = 'medium') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (normalized === 'high') return 'high';
  if (normalized === 'low') return 'low';
  return 'medium';
}

function clampMarketSignalPercent(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function normalizeMarketAnalysisDecision({ rawDecision, chain, token } = {}) {
  const parsed = parseStructuredDecision(rawDecision) || {};
  const normalizedToken = String(token || '').trim().toUpperCase();
  const normalizedChain = String(chain || '').trim().toLowerCase();
  const stableCurveEligible = normalizedChain.includes('arc') && new Set(['USDC', 'EURC']).has(normalizedToken);
  const normalizedRisk = ['low', 'medium', 'high'].includes(String(parsed.risk || '').toLowerCase())
    ? String(parsed.risk).toLowerCase()
    : (stableCurveEligible ? 'low' : 'medium');
  const rawSignal = parsed.signal && typeof parsed.signal === 'object'
    ? parsed.signal
    : {};
  const normalizedLane = String(rawSignal.lane || '').trim().toLowerCase() === 'stable_curve'
    ? 'stable_curve'
    : stableCurveEligible
      ? 'stable_curve'
      : 'observe';

  if (normalizedLane !== 'stable_curve') {
    return {
      opportunity: typeof parsed.opportunity === 'string' ? parsed.opportunity.trim() : null,
      risk: normalizedRisk,
      action: typeof parsed.action === 'string' ? parsed.action.trim() : null,
      signal: {
        lane: 'observe',
        shouldReviewDefi: false,
        stableLpMinAllocationPct: null,
        stableLpTargetAllocationPct: null,
        stableLpMaxAllocationPct: null,
        confidence: normalizeMarketSignalConfidence(rawSignal.confidence, normalizedRisk === 'high' ? 'low' : 'medium'),
      },
    };
  }

  const minPct = clampMarketSignalPercent(rawSignal.stableLpMinAllocationPct, 20, 5, 80);
  const maxPct = clampMarketSignalPercent(rawSignal.stableLpMaxAllocationPct, 30, minPct, 90);
  const targetPct = clampMarketSignalPercent(rawSignal.stableLpTargetAllocationPct, 25, minPct, maxPct);
  const confidence = normalizeMarketSignalConfidence(rawSignal.confidence, normalizedRisk === 'low' ? 'medium' : 'low');
  const shouldReviewDefi = rawSignal.shouldReviewDefi === true || confidence !== 'low';

  return {
    opportunity: typeof parsed.opportunity === 'string' ? parsed.opportunity.trim() : 'Stable market snapshot recorded.',
    risk: normalizedRisk,
    action: typeof parsed.action === 'string' ? parsed.action.trim() : 'Review the stable LP lane before sending a new transaction.',
    signal: {
      lane: 'stable_curve',
      shouldReviewDefi,
      stableLpMinAllocationPct: minPct,
      stableLpTargetAllocationPct: targetPct,
      stableLpMaxAllocationPct: maxPct,
      confidence,
    },
  };
}

function buildMarketAnalysisDecisionSnapshot({
  status,
  chain,
  token,
  result,
  engineName = 'unknown',
  queuedDefiReview = false,
} = {}) {
  const parsed = normalizeMarketAnalysisDecision({
    rawDecision: result?.decision,
    chain,
    token,
  });

  return {
    recordedAt: new Date().toISOString(),
    status,
    chain: chain || null,
    token: token || null,
    engine: result?.engine || engineName,
    opportunity: typeof parsed?.opportunity === 'string' ? parsed.opportunity : null,
    risk: typeof parsed?.risk === 'string' ? parsed.risk : null,
    action: typeof parsed?.action === 'string' ? parsed.action : null,
    signal: parsed?.signal && typeof parsed.signal === 'object'
      ? parsed.signal
      : null,
    queuedDefiReview,
    rawDecision: result?.decision || null,
  };
}

function shouldTriggerDefiReviewFromMarketAnalysis(snapshot, agent) {
  const signal = snapshot?.signal;
  if (!signal || signal.shouldReviewDefi !== true) return false;
  if (String(signal.lane || '').toLowerCase() !== 'stable_curve') return false;
  if (!agent?.defi_loop_enabled && !agent?.cirbtc_lp_enabled) return false;

  const minIntervalMinutes = Math.max(
    Number.parseInt(process.env.MARKET_ANALYSIS_TRIGGER_MIN_DEFI_INTERVAL_MINUTES || '15', 10) || 15,
    1,
  );
  const latestAutomationRunAt = [agent?.defi_loop_last_run_at, agent?.cirbtc_lp_last_run_at]
    .map(value => new Date(value).getTime())
    .filter(value => Number.isFinite(value))
    .sort((left, right) => right - left)[0];

  if (!Number.isFinite(latestAutomationRunAt)) return true;
  return (Date.now() - latestAutomationRunAt) >= (minIntervalMinutes * 60_000);
}

async function evaluateExecutionGate(agent, signal, agentId) {
  const { engine, apiKey, reason: resolveReason } = await resolveEngine(agent, agentId);
  const opportunity = {
    ...(signal?.opportunity || {}),
    fromChain: signal?.opportunity?.fromChain || 'arc-testnet',
    amountUsdc: signal?.opportunity?.amountUsdc ?? signal?.opportunity?.steps?.[0]?.amountUsdc ?? 0,
  };

  let result;
  let fallbackReason = resolveReason || null;

  try {
    result = await engine.getArbitrageDecision({
      opportunity,
      model: agent?.llm_model,
      apiKey,
      agentId,
    });
    if (engine === llmService) {
      clearAgentLlmAuthFailure(agentId);
    }
  } catch (error) {
    if (engine === llmService && isLlmAuthError(error)) {
      fallbackReason = 'llm_auth_error';
      markAgentLlmAuthFailure(agentId);
      logLlmAuthFallback('ORACLE_QUERY', agentId, error);
      result = await ruleEngine.getArbitrageDecision({
        opportunity,
        agentId,
      });
    } else {
      throw error;
    }
  }

  const parsed = parseStructuredDecision(result?.decision);
  const verdict = parsed && typeof parsed.execute === 'boolean'
    ? parsed
    : {
        execute: false,
        reason: 'Execution gate returned malformed JSON and was treated as HOLD.',
        suggestedAmount: 0,
      };

  return {
    engine: result?.engine || 'rule',
    decision: result?.decision || null,
    verdict,
    opportunity,
    fallbackReason,
  };
}

const AUTOMATION_STATE_COLUMNS = {
  marketAnalysis: {
    lastRunAt: 'market_analysis_last_run_at',
    lastStatus: 'market_analysis_last_status',
    lastDecision: 'market_analysis_last_decision',
  },
  oracle: {
    lastRunAt: 'oracle_last_run_at',
    lastStatus: 'oracle_last_status',
  },
  defiLoop: {
    lastRunAt: 'defi_loop_last_run_at',
    lastStatus: 'defi_loop_last_status',
    lastDecision: 'defi_loop_last_decision',
  },
  lendingAutomation: {
    lastRunAt: 'lending_automation_last_run_at',
    lastStatus: 'lending_automation_last_status',
    lastDecision: 'lending_automation_last_decision',
  },
  carryAutomation: {
    lastRunAt: 'carry_automation_last_run_at',
    lastStatus: 'carry_automation_last_status',
    lastDecision: 'carry_automation_last_decision',
  },
  cirbtcLp: {
    lastRunAt: 'cirbtc_lp_last_run_at',
    lastStatus: 'cirbtc_lp_last_status',
    lastDecision: 'cirbtc_lp_last_decision',
  },
};

async function _setAutomationState(agentId, automationKey, status) {
  const columns = AUTOMATION_STATE_COLUMNS[automationKey];
  if (!columns || !agentId) return;

  await db.query(
    `UPDATE agents
     SET ${columns.lastRunAt} = NOW(), ${columns.lastStatus} = $1
     WHERE id = $2`,
    [status, agentId],
  ).catch(() => {});
}

async function _setAutomationDecision(agentId, automationKey, decision) {
  const columns = AUTOMATION_STATE_COLUMNS[automationKey];
  if (!columns?.lastDecision || !agentId || !decision || typeof decision !== 'object') return;

  await db.query(
    `UPDATE agents
     SET ${columns.lastDecision} = $1::jsonb
     WHERE id = $2`,
    [JSON.stringify(decision), agentId],
  ).catch(() => {});
}

// ── Job processor ─────────────────────────────────────────────────────────────
queue.process('INCOMING_TRANSFER', 5, async (job) => {
  const {
    agentId,
    chain,
    amountUsdc,
    token = 'USDC',
    tokenAmount = null,
    usdPrice = null,
    from,
    isSmartMode,
    eventId,
    skipTransactionRecord,
  } = job.data;
  console.log(`[QUEUE] INCOMING_TRANSFER agent=${agentId} amount=${tokenAmount || amountUsdc} ${token} chain=${chain}`);

  const { rows: [senderAgent] } = await db.query(
    `SELECT id, name
       FROM agents
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [from],
  );
  const senderMeta = senderAgent
    ? { senderAgentId: senderAgent.id, senderAgentName: senderAgent.name }
    : {};

  // Mark event as processed
  if (eventId) {
    await db.query('UPDATE chain_events SET processed = TRUE WHERE id = $1', [eventId]);
  }

  if (!skipTransactionRecord) {
    let txHash = null;
    let toAddress = null;

    if (eventId) {
      const { rows: [event] } = await db.query(
        'SELECT tx_hash, data FROM chain_events WHERE id = $1',
        [eventId],
      );
      txHash = event?.tx_hash || null;
      toAddress = event?.data?.to || null;
    }

    if (txHash) {
      const { rows: existing } = await db.query(
        `SELECT id
           FROM transactions
          WHERE agent_id = $1
            AND type = 'receive'
            AND tx_hash = $2
            AND token = $3
          LIMIT 1`,
        [agentId, txHash, token],
      );
      if (existing.length === 0) {
        await db.query(
          `INSERT INTO transactions (agent_id, type, from_chain, to_chain, token, amount_usdc, from_address, to_address, tx_hash, status, meta)
           VALUES ($1, 'receive', $2, $2, $3, $4, $5, $6, $7, 'confirmed', $8)`,
          [agentId, chain, token, amountUsdc, from, toAddress, txHash, JSON.stringify({
            ...senderMeta,
            tokenAmount,
            usdValue: amountUsdc,
            usdPrice,
          })],
        );
      }
    } else {
      await db.query(
        `INSERT INTO transactions (agent_id, type, from_chain, to_chain, token, amount_usdc, from_address, status, meta)
         VALUES ($1, 'receive', $2, $2, $3, $4, $5, 'confirmed', $6)`,
        [agentId, chain, token, amountUsdc, from, JSON.stringify({
          ...senderMeta,
          tokenAmount,
          usdValue: amountUsdc,
          usdPrice,
        })],
      );
    }
  }

  if (!isSmartMode) {
    // Base mode — transaction is already recorded for the frontend poller
    return { ok: true, action: 'recorded' };
  }

  // Smart mode — run market analysis (LLM if key present, rule engine otherwise)
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted,
            private_key_encrypted,
            gateway_auto_topup_enabled, gateway_auto_topup_min_usdc, gateway_auto_topup_target_usdc
       FROM agents WHERE id = $1`,
    [agentId],
  );

  if (agent && String(token || '').trim().toUpperCase() === 'USDC') {
    await maybeWarmAgentGatewayBalance(agent, 'incoming_transfer', {
      targetAvailableUsdc: agent.gateway_auto_topup_min_usdc ?? DEFAULT_AGENT_GATEWAY_AUTO_TOPUP_MIN_USDC,
    });
  }

  try {
    const { engine, apiKey } = await resolveEngine(agent);
    const { decision, engine: usedEngine } = await engine.analyzeMarket({
      chain, token, model: agent?.llm_model, apiKey, agentId,
    });
    console.log(`[QUEUE] INCOMING_TRANSFER decision (${usedEngine || 'llm'}) for agent ${agentId}:`, decision.slice(0, 100));
    return { ok: true, action: 'analyzed', engine: usedEngine || 'llm', decision };
  } catch (err) {
    console.error('[QUEUE] Analysis error:', err.message);
    return { ok: true, action: 'analysis_failed', error: err.message };
  }
});

queue.process('MARKET_ANALYSIS', 2, async (job) => {
  const { agentId, chain, token } = job.data;
  console.log(`[QUEUE] MARKET_ANALYSIS agent=${agentId}`);
  await _setAutomationState(agentId, 'marketAnalysis', 'running');

  const { rows: [agent] } = await db.query(
    `SELECT llm_model, llm_api_key_encrypted,
            defi_loop_enabled, cirbtc_lp_enabled,
            wallet_address, daily_defi_loop_count, defi_daily_reset_at, daily_limit_reset_at,
            defi_loop_last_run_at, cirbtc_lp_last_run_at
       FROM agents
      WHERE id = $1
        AND is_smart_mode = TRUE`,
    [agentId],
  );
  if (!agent) {
    await _setAutomationState(agentId, 'marketAnalysis', 'disabled');
    return { ok: false, reason: 'agent not in smart mode' };
  }

  const permissions = await getAgentPermissionMap(agentId);
  if (permissions.defi_scan === false) {
    await _setAutomationState(agentId, 'marketAnalysis', 'permission_blocked');
    return {
      ok: true,
      action: 'hold',
      reason: 'permission_blocked',
      permission: 'defi_scan',
    };
  }

  if (shouldSuspendScanJobsWhenDefiCapReached(agent)) {
    const decisionSnapshot = {
      recordedAt: new Date().toISOString(),
      status: 'cap_reached',
      chain,
      token,
      engine: 'system',
      opportunity: "Market analysis paused because this agent's daily DeFi automation cap is already full.",
      risk: 'low',
      action: 'Wait for the next daily cap reset before refreshing another advisory signal.',
      signal: {
        lane: 'stable_curve',
        shouldReviewDefi: false,
        stableLpMinAllocationPct: null,
        stableLpTargetAllocationPct: null,
        stableLpMaxAllocationPct: null,
        confidence: 'low',
      },
      queuedDefiReview: false,
      rawDecision: null,
      pausedBy: 'shared_defi_daily_cap',
    };

    await _setAutomationState(agentId, 'marketAnalysis', 'cap_reached');
    await _setAutomationDecision(agentId, 'marketAnalysis', decisionSnapshot);
    return {
      ok: true,
      action: 'hold',
      reason: 'shared_defi_daily_cap_reached',
    };
  }

  try {
    const { engine, apiKey, reason: resolveReason } = await resolveEngine(agent, agentId);
    let engineName = engine === llmService ? 'llm' : 'rule';
    let result;
    let fallbackReason = resolveReason || null;

    try {
      result = await engine.analyzeMarket({ chain, token, model: agent.llm_model, apiKey, agentId });
      if (engine === llmService) {
        clearAgentLlmAuthFailure(agentId);
      }
    } catch (error) {
      if (engine === llmService && isLlmAuthError(error)) {
        fallbackReason = 'llm_auth_error';
        markAgentLlmAuthFailure(agentId);
        logLlmAuthFallback('MARKET_ANALYSIS', agentId, error);
        result = await ruleEngine.analyzeMarket({ chain, token, agentId });
        engineName = 'rule';
      } else {
        throw error;
      }
    }

    console.log(`[QUEUE] MARKET_ANALYSIS (${result.engine || engineName}) for agent ${agentId}`);

    const decisionSnapshot = buildMarketAnalysisDecisionSnapshot({
      status: 'success',
      chain,
      token,
      result,
      engineName,
    });
    if (fallbackReason) {
      decisionSnapshot.fallbackReason = fallbackReason;
    }
    let queuedDefiReview = false;

    if (shouldTriggerDefiReviewFromMarketAnalysis(decisionSnapshot, agent)) {
      try {
        const enqueueResult = await queueDefiLoopForAgent(agentId, {
          reason: 'market-analysis',
          trigger: 'market_analysis',
          priority: DEFI_LOOP_PRIORITY_MARKET,
        });
        queuedDefiReview = enqueueResult.queued === true;
      } catch (queueErr) {
        console.error(`[QUEUE] MARKET_ANALYSIS enqueue DEFI_LOOP error agent=${agentId}:`, queueErr.message);
      }
    }

    await _setAutomationState(agentId, 'marketAnalysis', 'success');
    await _setAutomationDecision(agentId, 'marketAnalysis', {
      ...decisionSnapshot,
      queuedDefiReview,
    });
    return {
      ...result,
      queuedDefiReview,
    };
  } catch (err) {
    await _setAutomationState(agentId, 'marketAnalysis', 'error');
    throw err;
  }
});

// ── ORACLE_QUERY ───────────────────────────────────────────────────────────────
// Runs for agents with oracle_enabled = TRUE only.
// Fetches forex + pool data, builds an arb signal, then runs it through the
// rule engine (or LLM when key present). Decision is logged to the DB.
// Schedule: external caller (e.g. cron in server.js bootstrap) enqueues this
// every ORACLE_LOOP_INTERVAL_MS (default 30 min) per eligible agent.
const ORACLE_LOOP_INTERVAL_MS = parseInt(process.env.ORACLE_LOOP_INTERVAL_MS || '1800000', 10);
const MARKET_ANALYSIS_LOOP_INTERVAL_MS = parseInt(process.env.MARKET_ANALYSIS_LOOP_INTERVAL_MS || '1800000', 10);
const DEFI_LOOP_WORKER_CONCURRENCY = Math.max(
  parseInt(process.env.DEFI_LOOP_WORKER_CONCURRENCY || '2', 10) || 2,
  1,
);
const ORACLE_RUNNING_REQUEUE_GRACE_MS = Math.max(
  parseInt(process.env.ORACLE_RUNNING_REQUEUE_GRACE_MS || '180000', 10) || 180000,
  30000,
);
const MARKET_ANALYSIS_RUNNING_REQUEUE_GRACE_MS = Math.max(
  parseInt(process.env.MARKET_ANALYSIS_RUNNING_REQUEUE_GRACE_MS || '180000', 10) || 180000,
  30000,
);
const CURVE_USDC_EURC_POOL    = process.env.CURVE_USDC_EURC_POOL || null;
const DEFI_LOOP_INTERVAL_MS   = parseInt(process.env.DEFI_LOOP_INTERVAL_MS   || '3600000',  10); // default 1h
const DEFI_LOOP_STARTUP_DELAY_MS = parseInt(process.env.DEFI_LOOP_STARTUP_DELAY_MS || '60000', 10);
const DEFI_LOOP_ORPHAN_JOB_AGE_MS = parseInt(process.env.DEFI_LOOP_ORPHAN_JOB_AGE_MS || '120000', 10);
const DEFI_LOOP_TRACKED_CARRY_ORPHAN_JOB_AGE_MS = Math.max(
  parseInt(process.env.DEFI_LOOP_TRACKED_CARRY_ORPHAN_JOB_AGE_MS || '45000', 10) || 45000,
  15000,
);
const DEFI_LOOP_ACTIVE_NO_LOCK_GRACE_MS = Math.max(
  parseInt(process.env.DEFI_LOOP_ACTIVE_NO_LOCK_GRACE_MS || '5000', 10) || 5000,
  1000,
);
const DEFI_LOOP_ORPHAN_SWEEP_INTERVAL_MS = Math.max(parseInt(process.env.DEFI_LOOP_ORPHAN_SWEEP_INTERVAL_MS || '60000', 10) || 60000, 30000);
const DEFI_LOOP_ORPHAN_RECOVERY_MAX_REQUEUES = Math.max(
  parseInt(process.env.DEFI_LOOP_ORPHAN_RECOVERY_MAX_REQUEUES || '2', 10) || 2,
  1,
);
const DAILY_DEFI_LOOP_CAP     = Math.max(parseInt(process.env.DAILY_DEFI_LOOP_CAP || '24', 10) || 24, 1);
const DAILY_ORACLE_CAP        = Math.max(parseInt(process.env.DAILY_ORACLE_CAP || '48', 10) || 48, 1);
const SUSPEND_CAP_REACHED_SCAN_JOBS = String(process.env.SUSPEND_CAP_REACHED_SCAN_JOBS || '').trim().toLowerCase() === 'true';
const GLOBAL_DRY_RUN          = process.env.DRY_RUN === 'true';
const DEFAULT_ORACLE_SAME_CHAIN_MIN_PROFIT_USDC = 0.01;

function getDefiLoopOrphanJobAgeMs(job) {
  const sourceTaskId = String(job?.data?.sourceTaskId || '').trim().toUpperCase();
  const taskRunId = String(job?.data?.taskRunId || '').trim();
  return taskRunId && sourceTaskId === 'EXEC_AUTO_CARRY_START'
    ? DEFI_LOOP_TRACKED_CARRY_ORPHAN_JOB_AGE_MS
    : DEFI_LOOP_ORPHAN_JOB_AGE_MS;
}

function buildDefiLoopOrphanRecovery(job) {
  const agentId = String(job?.data?.agentId || '').trim();
  if (!agentId) return null;

  const carryFollowupPhase = String(job?.data?.carryFollowupPhase || '').trim().toLowerCase();
  const sourceTaskId = String(job?.data?.sourceTaskId || '').trim().toUpperCase();
  const taskRunId = String(job?.data?.taskRunId || '').trim() || null;
  const orphanRecoveryCount = Math.max(Number.parseInt(job?.data?.orphanRecoveryCount || '0', 10) || 0, 0);
  const isTrackedCarryStart = Boolean(taskRunId && sourceTaskId === 'EXEC_AUTO_CARRY_START');
  const isCarryFollowup = carryFollowupPhase === 'followup';

  if (!isTrackedCarryStart) {
    return {
      agentId,
      taskRunId: null,
      sourceTaskId: null,
      carryFollowupPhase: carryFollowupPhase || null,
      orphanRecoveryCount,
      shouldRequeue: false,
      reason: 'orphan-recovery',
    };
  }

  return {
    agentId,
    taskRunId: isTrackedCarryStart ? taskRunId : null,
    sourceTaskId: isTrackedCarryStart ? sourceTaskId : null,
    carryFollowupPhase: isCarryFollowup ? 'followup' : 'initial',
    orphanRecoveryCount,
    shouldRequeue: orphanRecoveryCount < DEFI_LOOP_ORPHAN_RECOVERY_MAX_REQUEUES,
    reason: isCarryFollowup ? 'carry-open-followup' : 'carry-start-task',
  };
}

function resolveBullQueueKey(key) {
  return typeof queue?.toKey === 'function' ? queue.toKey(key) : `bull:agent-jobs:${key}`;
}

function resolveBullJobLockKey(job) {
  const jobKey = typeof job?.queue?.toKey === 'function'
    ? job.queue.toKey(job.id)
    : resolveBullQueueKey(job?.id);
  return `${jobKey}:lock`;
}

async function readBullJobLock(job) {
  try {
    const client = job?.queue?.client || queue.client;
    if (!client || !job?.id) return null;
    return client.get(resolveBullJobLockKey(job));
  } catch (_) {
    return null;
  }
}

function getDefiLoopNoLockGraceMs(job) {
  const processedOn = Number(job?.processedOn || 0);
  return processedOn > 0
    ? getDefiLoopOrphanJobAgeMs(job)
    : DEFI_LOOP_ACTIVE_NO_LOCK_GRACE_MS;
}

function getDefiLoopActiveReferenceMs(job) {
  const processedOn = Number(job?.processedOn || 0);
  if (Number.isFinite(processedOn) && processedOn > 0) return processedOn;
  const queuedAt = Number(job?.timestamp || 0);
  return Number.isFinite(queuedAt) && queuedAt > 0 ? queuedAt : 0;
}

async function isLiveDefiLoopJob(job, now = Date.now()) {
  if (!job || job.name !== 'DEFI_LOOP') return false;

  const state = typeof job.getState === 'function'
    ? await job.getState().catch(() => null)
    : null;

  if (state && state !== 'active') {
    return state === 'waiting' || state === 'delayed' || state === 'paused';
  }

  const lock = await readBullJobLock(job);
  if (lock) return true;

  const referenceMs = getDefiLoopActiveReferenceMs(job);
  if (!referenceMs) return false;
  return (now - referenceMs) < getDefiLoopNoLockGraceMs(job);
}

async function removeMalformedDefiLoopJobReferences(job, reason = 'malformed-active') {
  if (!job?.id) return false;

  const id = String(job.id);
  const client = job?.queue?.client || queue.client;
  const jobKey = typeof job?.queue?.toKey === 'function'
    ? job.queue.toKey(id)
    : resolveBullQueueKey(id);

  try {
    await job.remove();
    return true;
  } catch (_) {
    // Active jobs without a Bull lock may fail job.remove(); clean stale refs directly.
  }

  try {
    await Promise.all([
      client.lrem(resolveBullQueueKey('active'), 0, id),
      client.lrem(resolveBullQueueKey('wait'), 0, id),
      client.zrem(resolveBullQueueKey('priority'), id),
      client.zrem(resolveBullQueueKey('delayed'), id),
      client.zrem(resolveBullQueueKey('failed'), id),
      client.zrem(resolveBullQueueKey('completed'), id),
      client.srem(resolveBullQueueKey('stalled'), id),
      client.del(jobKey),
      client.del(`${jobKey}:lock`),
    ]);
    logQueueVerbose(`[DEFI_LOOP] Removed stale job references id=${id} reason=${reason}`);
    return true;
  } catch (err) {
    console.error(`[DEFI_LOOP] Could not remove stale job references ${id}:`, err.message);
    return false;
  }
}

async function cleanupMalformedActiveDefiLoopJobs({ agentId = null, limit = 200 } = {}) {
  const activeJobs = await queue.getJobs(['active'], 0, limit, true);
  const now = Date.now();
  const targetAgentId = agentId ? String(agentId).trim() : null;
  let removedCount = 0;
  let requeuedCount = 0;

  for (const job of activeJobs) {
    if (job?.name !== 'DEFI_LOOP') continue;

    const queuedAgentId = String(job?.data?.agentId || '').trim();
    if (!queuedAgentId) continue;
    if (targetAgentId && queuedAgentId !== targetAgentId) continue;

    const lock = await readBullJobLock(job);
    if (lock) continue;

    const referenceMs = getDefiLoopActiveReferenceMs(job);
    if (!referenceMs) continue;
    if ((now - referenceMs) < getDefiLoopNoLockGraceMs(job)) continue;

    const recovery = buildDefiLoopOrphanRecovery(job);

    const removed = await removeMalformedDefiLoopJobReferences(job, 'active-no-lock');
    if (!removed) continue;
    removedCount += 1;

    if (!recovery?.shouldRequeue) continue;

    const requeueResult = await queueDefiLoopForAgent(recovery.agentId, {
      reason: recovery.reason,
      taskRunId: recovery.taskRunId,
      sourceTaskId: recovery.sourceTaskId,
      carryFollowupPhase: recovery.carryFollowupPhase,
      orphanRecoveryCount: recovery.orphanRecoveryCount + 1,
      skipMalformedCleanup: true,
    }).catch((error) => ({
      queued: false,
      error: error.message,
    }));

    if (!requeueResult.queued) {
      console.error(
        `[DEFI_LOOP] Could not requeue malformed active job ${job.id}:`,
        requeueResult.error || 'unknown error',
      );
      continue;
    }

    requeuedCount += 1;

    if (recovery.taskRunId && recovery.sourceTaskId === 'EXEC_AUTO_CARRY_START') {
      await taskRunService.updateTaskRunStage(recovery.taskRunId, {
        status: 'running',
        stageKey: recovery.carryFollowupPhase === 'followup'
          ? 'carry_waiting_followup'
          : 'carry_handoff_queued',
        stageLabel: recovery.carryFollowupPhase === 'followup'
          ? 'Waiting For Follow-Up'
          : 'Auto Carry Handoff',
        stageDetail: recovery.carryFollowupPhase === 'followup'
          ? 'Recovered the queued follow-up after a worker interruption. The autonomous carry handoff is continuing.'
          : 'Recovered the queued Auto Carry review after a worker interruption. The autonomous carry handoff is continuing.',
      }).catch(() => {});
    }
  }

  if (removedCount > 0) {
    logQueueVerbose(
      `[DEFI_LOOP] Cleaned up ${removedCount} malformed active job(s)`
      + (requeuedCount > 0 ? ` and requeued ${requeuedCount} recovery job(s)` : ''),
    );
  }

  return {
    removedCount,
    requeuedCount,
  };
}

function normalizeCarryAutomationAction(payload = {}) {
  return String(payload?.action || payload?.operationType || '').trim().toLowerCase();
}

async function findLiveDefiLoopJobForTaskRun(taskRunId) {
  const normalizedTaskRunId = String(taskRunId || '').trim();
  if (!normalizedTaskRunId) return null;

  const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'paused'], 0, 500, true);
  const now = Date.now();

  for (const job of jobs) {
    if (job?.name !== 'DEFI_LOOP') continue;
    if (String(job?.data?.taskRunId || '').trim() !== normalizedTaskRunId) continue;

    if (await isLiveDefiLoopJob(job, now)) return job;
    await removeMalformedDefiLoopJobReferences(job, 'task-run-live-check');
  }

  return null;
}

async function findLiveDefiLoopJobForAgent(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return null;

  const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'paused'], 0, 500, true);
  const now = Date.now();

  for (const job of jobs) {
    if (job?.name !== 'DEFI_LOOP') continue;
    if (String(job?.data?.agentId || '').trim() !== normalizedAgentId) continue;

    if (await isLiveDefiLoopJob(job, now)) return job;
    await removeMalformedDefiLoopJobReferences(job, 'agent-live-check');
  }

  return null;
}

async function readLatestCarryAutomationTransactionForRun(run) {
  if (!run?.agent_id || !run?.created_at) return null;

  const { rows: [row] } = await db.query(
    `SELECT tx_hash,
            amount_usdc::text AS amount_usdc,
            token,
            status,
            meta,
            created_at
       FROM transactions
      WHERE agent_id = $1
        AND status = 'confirmed'
        AND meta->>'executionSource' = $2
        AND created_at >= $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [run.agent_id, getCarryAutomationExecutionSource(), run.created_at],
  );

  return row || null;
}

async function loadAgentForAutoCarryHandoffRecovery(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted,
            defi_loop_enabled, lending_automation_enabled, carry_automation_enabled, cirbtc_lp_enabled, oracle_enabled,
            daily_defi_loop_count, defi_daily_reset_at, daily_limit_reset_at,
            daily_limit_usdc, max_trade_usdc, defi_wallet_reserve_usdc,
            oracle_max_eurc_inventory, oracle_min_eurc_reserve, slippage_percent,
            gateway_auto_topup_enabled, gateway_auto_topup_min_usdc, gateway_auto_topup_target_usdc,
            wallet_address, private_key_encrypted,
            market_analysis_last_decision,
            stable_manual_cooldown_until
       FROM agents
      WHERE id = $1`,
    [agentId],
  );

  return agent || null;
}

function resolveRecoveredCarryAmountUsdc({ automationPolicy = null, payload = null, latestTx = null } = {}) {
  const actionParams = automationPolicy?.verdict?.actionParams && typeof automationPolicy.verdict.actionParams === 'object'
    ? automationPolicy.verdict.actionParams
    : {};
  const candidates = [
    payload?.amountUsdc,
    payload?.amountIn,
    actionParams.amountIn,
    actionParams.borrowAmount,
    actionParams.amount,
    latestTx?.amount_usdc,
  ];

  for (const candidate of candidates) {
    const value = normalizeUsdcAmount(Number(candidate));
    if (value > 0) return value;
  }

  return 0;
}

async function persistRecoveredAutoCarryExecution({ run, automationPolicy = null, payload = {}, latestTx = null, carryFollowupPhase = 'initial' }) {
  const action = normalizeCarryAutomationAction(payload);
  const stableToken = String(
    payload?.stableToken
    || getCarryAutomationTransactionToken(automationPolicy?.verdict?.actionParams || {}, automationPolicy)
    || 'USDC',
  ).trim().toUpperCase();
  const amountUsdc = resolveRecoveredCarryAmountUsdc({ automationPolicy, payload, latestTx });
  const resultPayload = {
    ...(payload || {}),
    ok: payload?.ok !== false,
    action: action || payload?.action || payload?.operationType || null,
    amountUsdc,
    stableToken,
    carryTriggerTaskId: 'EXEC_AUTO_CARRY_START',
    carryFollowupPhase,
    finalAutomationStatus: 'executed',
    recoveredFromMissingFollowup: true,
    recoveredInlineFromHandoff: true,
  };

  await _setAutomationState(run.agent_id, 'carryAutomation', 'executed');
  await _setAutomationDecision(run.agent_id, 'carryAutomation', resultPayload);

  if (resultPayload.txHash) {
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, tx_hash, meta)
       VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'confirmed', $5, $6::jsonb)`,
      [
        run.agent_id,
        getCarryAutomationTransactionType(),
        stableToken,
        amountUsdc,
        resultPayload.txHash,
        JSON.stringify({
          automationPolicy,
          ...resultPayload,
          executionState: 'executed',
          executionSource: getCarryAutomationExecutionSource(),
        }),
      ],
    );
  }

  if (AUTO_CARRY_HANDOFF_TERMINAL_ACTIONS.has(action)) {
    await _saveResultOnly(run.agent_id, 'EXEC_AUTO_CARRY_START', resultPayload).catch(() => {});
    await taskRunService.completeTaskRun(run.id, {
      resultPayload,
      stageKey: 'carry_handoff_completed',
      stageLabel: 'Completed',
      stageDetail: resultPayload.summary || 'The Auto Carry handoff completed.',
    });
    return { completed: true, action, payload: resultPayload };
  }

  if (action === 'open_carry') {
    await taskRunService.updateTaskRunStage(run.id, {
      status: 'running',
      stageKey: 'carry_waiting_followup',
      stageLabel: 'Waiting For Follow-Up',
      stageDetail: 'Borrow opened. The recovered follow-up will deploy the borrowed balance into the stable LP lane.',
    }).catch(() => {});
    return { completed: false, action, payload: resultPayload };
  }

  return { completed: false, action, payload: resultPayload };
}

async function executeRecoveredAutoCarryInitialRun(run) {
  const agent = await loadAgentForAutoCarryHandoffRecovery(run.agent_id);
  if (!agent) throw new Error('agent_not_found');

  await taskRunService.updateTaskRunStage(run.id, {
    status: 'running',
    stageKey: 'carry_initial_review',
    stageLabel: 'Carry Review',
    stageDetail: 'Recovering the missing Auto Carry review without waiting for another queue handoff.',
  }).catch(() => {});

  const context = await buildCarryAutomationTaskContext(agent);
  if (!context.ok) throw new Error(context.error || context.reason || 'carry_context_unavailable');

  if (context.carryPolicy?.verdict?.execute !== true) {
    const resultPayload = {
      ok: true,
      action: 'hold',
      reason: context.carryPolicy?.verdict?.reason || 'carry_policy_hold',
      summary: context.carryPolicy?.verdict?.reason || 'Auto Carry is enabled, but the live carry lane is waiting.',
      carryTriggerTaskId: 'EXEC_AUTO_CARRY_START',
      carryFollowupPhase: 'initial',
      finalAutomationStatus: 'policy_hold',
      recoveredInlineFromHandoff: true,
    };

    await _setAutomationState(run.agent_id, 'carryAutomation', 'policy_hold');
    await _setAutomationDecision(run.agent_id, 'carryAutomation', resultPayload);
    await _saveResultOnly(run.agent_id, 'EXEC_AUTO_CARRY_START', resultPayload).catch(() => {});
    await taskRunService.completeTaskRun(run.id, {
      resultPayload,
      stageKey: 'carry_handoff_completed',
      stageLabel: 'Completed',
      stageDetail: resultPayload.summary,
    });

    return { completed: true, action: 'hold', payload: resultPayload };
  }

  const execution = await executeCarryAutomationTask({
    agent,
    automationPolicy: context.carryPolicy,
    dryRunEnabled: false,
    taskRunId: run.id,
    sourceTaskId: 'EXEC_AUTO_CARRY_START',
  });

  if (!execution.ok) throw new Error(execution.error || execution.reason || 'carry_execution_failed');

  return persistRecoveredAutoCarryExecution({
    run,
    automationPolicy: context.carryPolicy,
    payload: execution.payload || {},
    carryFollowupPhase: 'initial',
  });
}

async function executeRecoveredAutoCarryFollowupRun(run, latestTx) {
  const agent = await loadAgentForAutoCarryHandoffRecovery(run.agent_id);
  if (!agent) throw new Error('agent_not_found');

  await taskRunService.updateTaskRunStage(run.id, {
    status: 'running',
    stageKey: 'carry_followup_running',
    stageLabel: 'Carry Follow-Up',
    stageDetail: 'Recovering the stuck follow-up and deploying the borrowed balance into the stable LP lane.',
  }).catch(() => {});

  const walletUsdc = await getArcUsdcBalance(agent.wallet_address).catch(() => 0);
  const latestAmount = normalizeUsdcAmount(Number(latestTx?.amount_usdc || 0));
  const amountIn = normalizeUsdcAmount(Math.min(latestAmount, walletUsdc));
  if (!(amountIn > 0.01)) throw new Error('carry_followup_wallet_balance_unavailable');

  const automationPolicy = {
    policyId: getCarryAutomationExecutionSource(),
    verdict: {
      execute: true,
      operationType: 'deploy_wallet_balance',
      actionAssetSymbol: 'USDC',
      actionParams: {
        stableToken: 'USDC',
        amountIn,
      },
    },
  };

  const execution = await executeCarryAutomationTask({
    agent,
    automationPolicy,
    dryRunEnabled: false,
    taskRunId: run.id,
    sourceTaskId: 'EXEC_AUTO_CARRY_START',
  });

  if (!execution.ok) throw new Error(execution.error || execution.reason || 'carry_followup_execution_failed');

  return persistRecoveredAutoCarryExecution({
    run,
    automationPolicy,
    payload: execution.payload || {},
    latestTx,
    carryFollowupPhase: 'followup',
  });
}

async function executeRecoveredAutoCarryHandoffRun(run, latestTx, plan) {
  if (plan?.carryFollowupPhase === 'followup') {
    return executeRecoveredAutoCarryFollowupRun(run, latestTx);
  }

  return executeRecoveredAutoCarryInitialRun(run);
}

async function completeAutoCarryStartRunFromCarryTransaction(run, txRow) {
  const meta = txRow?.meta && typeof txRow.meta === 'object' ? txRow.meta : {};
  const action = normalizeCarryAutomationAction(meta);
  if (!AUTO_CARRY_HANDOFF_TERMINAL_ACTIONS.has(action)) return false;

  const resultPayload = {
    ...meta,
    ok: meta.ok !== false,
    action: action || meta.action || meta.operationType || null,
    txHash: txRow?.tx_hash || meta.txHash || null,
    amountUsdc: txRow?.amount_usdc || meta.amountUsdc || null,
    token: txRow?.token || meta.stableToken || meta.token || 'USDC',
    carryTriggerTaskId: 'EXEC_AUTO_CARRY_START',
    carryFollowupPhase: 'followup',
    finalAutomationStatus: 'executed',
    recoveredFromMissingFollowup: true,
  };

  await _saveResultOnly(run.agent_id, 'EXEC_AUTO_CARRY_START', resultPayload).catch(() => {});
  await taskRunService.completeTaskRun(run.id, {
    resultPayload,
    stageKey: 'carry_handoff_completed',
    stageLabel: 'Completed',
    stageDetail: meta.summary || 'The Auto Carry handoff completed.',
  });

  return true;
}

function resolveAutoCarryHandoffRecoveryPlan(run, latestTx) {
  const stageKey = String(run?.stage_key || '').trim().toLowerCase();
  const meta = latestTx?.meta && typeof latestTx.meta === 'object' ? latestTx.meta : {};
  const latestAction = normalizeCarryAutomationAction(meta);

  if (AUTO_CARRY_HANDOFF_TERMINAL_ACTIONS.has(latestAction)) {
    return { completeFromTransaction: true };
  }

  if (stageKey === 'carry_handoff_queued' && latestAction !== 'open_carry') {
    return {
      reason: 'carry-start-task-recovery',
      carryFollowupPhase: 'initial',
      stageKey: 'carry_handoff_queued',
      stageLabel: 'Auto Carry Handoff',
      stageDetail: 'Recovered a missing queued Auto Carry review. The autonomous carry handoff is continuing.',
    };
  }

  return {
    reason: 'carry-open-followup-recovery',
    carryFollowupPhase: 'followup',
    stageKey: 'carry_waiting_followup',
    stageLabel: 'Waiting For Follow-Up',
    stageDetail: 'Recovered a missing queued follow-up. The autonomous carry handoff is continuing.',
  };
}

async function recoverMissingAutoCarryHandoffRuns({ agentId = null, limit = CARRY_AUTOMATION_HANDOFF_RECOVERY_BATCH_SIZE } = {}) {
  const targetAgentId = agentId ? String(agentId).trim() : null;
  const staleBefore = new Date(Date.now() - CARRY_AUTOMATION_HANDOFF_RECOVERY_AGE_MS).toISOString();
  const params = [
    taskRunService.ACTIVE_TASK_RUN_STATUSES,
    AUTO_CARRY_HANDOFF_RECOVERY_STAGE_KEYS,
    staleBefore,
    Math.max(Math.min(Number.parseInt(limit, 10) || CARRY_AUTOMATION_HANDOFF_RECOVERY_BATCH_SIZE, 100), 1),
  ];
  let agentFilter = '';
  if (targetAgentId) {
    params.push(targetAgentId);
    agentFilter = `AND r.agent_id = $${params.length}`;
  }

  const { rows } = await db.query(
    `SELECT r.id,
            r.agent_id,
            r.task_id,
            r.status,
            r.stage_key,
            r.stage_label,
            r.stage_detail,
            r.created_at,
            r.updated_at
       FROM agent_task_runs r
      WHERE r.task_id = 'EXEC_AUTO_CARRY_START'
        AND r.status = ANY($1::text[])
        AND r.stage_key = ANY($2::text[])
        AND r.updated_at <= $3
        ${agentFilter}
      ORDER BY r.updated_at ASC
      LIMIT $4`,
    params,
  );

  let completedCount = 0;
  let requeuedCount = 0;
  let inlineCount = 0;
  let skippedCount = 0;

  for (const run of rows) {
    const liveJob = await findLiveDefiLoopJobForTaskRun(run.id).catch(() => null);
    if (liveJob) {
      skippedCount += 1;
      continue;
    }

    const latestTx = await readLatestCarryAutomationTransactionForRun(run).catch(() => null);
    const plan = resolveAutoCarryHandoffRecoveryPlan(run, latestTx);

    if (plan.completeFromTransaction) {
      const completed = await completeAutoCarryStartRunFromCarryTransaction(run, latestTx).catch((error) => {
        console.error(`[DEFI_LOOP] Could not complete recovered Auto Carry run ${run.id}:`, error.message);
        return false;
      });
      if (completed) completedCount += 1;
      continue;
    }

    const inlineRecovery = await executeRecoveredAutoCarryHandoffRun(run, latestTx, plan).catch((error) => ({
      completed: false,
      action: null,
      error: error.message,
    }));

    if (inlineRecovery.error) {
      console.error(`[DEFI_LOOP] Could not recover Auto Carry handoff inline for run ${run.id}:`, inlineRecovery.error);
      continue;
    }

    inlineCount += 1;
    if (inlineRecovery.completed) completedCount += 1;
  }

  if (completedCount > 0 || requeuedCount > 0 || inlineCount > 0) {
    console.log(
      `[DEFI_LOOP] Auto Carry handoff recovery completed=${completedCount} inline=${inlineCount} requeued=${requeuedCount}`
      + (skippedCount > 0 ? ` skipped=${skippedCount}` : ''),
    );
  }

  return {
    completedCount,
    requeuedCount,
    inlineCount,
    skippedCount,
  };
}

function hasDailyResetWindowElapsed(resetAtValue, nowMs = Date.now()) {
  const resetAtMs = resetAtValue
    ? new Date(resetAtValue).getTime()
    : Number.NaN;

  if (!Number.isFinite(resetAtMs)) return false;
  const nowUtcDay = new Date(nowMs).toISOString().slice(0, 10);
  const resetUtcDay = new Date(resetAtMs).toISOString().slice(0, 10);
  return resetUtcDay < nowUtcDay;
}

function hasReachedSharedDefiDailyCap(agent, nowMs = Date.now()) {
  if (!agent) return false;
  if (isDailyLimitBypassed(agent)) return false;
  if (hasDailyResetWindowElapsed(agent.defi_daily_reset_at || agent.daily_limit_reset_at, nowMs)) return false;
  return Number(agent.daily_defi_loop_count || 0) >= DAILY_DEFI_LOOP_CAP;
}

function shouldSuspendScanJobsWhenDefiCapReached(agent, nowMs = Date.now()) {
  return SUSPEND_CAP_REACHED_SCAN_JOBS && hasReachedSharedDefiDailyCap(agent, nowMs);
}
const DEFAULT_ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES = 60;

function readPositiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function _getUsdcEurcCurvePool() {
  return oracle.resolveCurvePool('USDC-EURC');
}

function _getEurcUsdcCurvePool() {
  return oracle.resolveCurvePool('EURC-USDC');
}

function _getCirbtcDirectPairPool(stableToken = 'USDC') {
  return oracle.resolveDirectSwapFallbackPool(`${String(stableToken || 'USDC').trim().toUpperCase()}-CIRBTC`);
}

async function _getOracleStablePoolState(forexRate) {
  const pool = _getEurcUsdcCurvePool();

  if (!pool?.address) {
    return oracle.getMockPoolState('EURC-USDC', forexRate.rate);
  }

  return oracle.getCurvePoolState(pool);
}

async function _buildOracleSameChainSellBackPlan({ amountInUsdc, swapPool }) {
  const normalizedInputUsdc = normalizeUsdcAmount(amountInUsdc);
  if (!(normalizedInputUsdc > 0)) {
    return null;
  }

  const poolAddress = swapPool?.address || CURVE_USDC_EURC_POOL;
  if (!poolAddress) {
    return null;
  }

  try {
    const buyQuote = await protocols.getCurveQuote(
      poolAddress,
      swapPool?.baseToken.index ?? 0,
      swapPool?.quoteToken.index ?? 1,
      String(normalizedInputUsdc),
      swapPool?.baseToken.decimals || 6,
      swapPool?.quoteToken.decimals || 6,
    );

    const expectedEurcOut = normalizeUsdcAmount(buyQuote.amountOut);
    if (!(expectedEurcOut > 0)) {
      return null;
    }

    const sellBackQuote = await agentWalletService.getSwapQuoteResult({
      fromToken: 'EURC',
      toToken: 'USDC',
      amountIn: expectedEurcOut,
    });
    const expectedUsdcOut = normalizeUsdcAmount(sellBackQuote?.amountOut);
    const expectedProfitUsdc = normalizeUsdcAmount(expectedUsdcOut - normalizedInputUsdc);
    const minProfitUsdc = readPositiveNumberEnv(
      'ORACLE_SAME_CHAIN_MIN_PROFIT_USDC',
      DEFAULT_ORACLE_SAME_CHAIN_MIN_PROFIT_USDC,
    );
    const minimumExpectedUsdcOut = normalizeUsdcAmount(normalizedInputUsdc + minProfitUsdc);

    return {
      profitable: expectedUsdcOut >= minimumExpectedUsdcOut,
      inputUsdc: normalizedInputUsdc,
      expectedEurcOut,
      expectedUsdcOut,
      expectedProfitUsdc,
      minimumExpectedUsdcOut,
      profitFloorUsdc: minProfitUsdc,
      exitExecutionRail: sellBackQuote?.executionRail || null,
      exitRouteStrategy: sellBackQuote?.routeStrategy || null,
      exitRouteReason: sellBackQuote?.routeReason || null,
    };
  } catch (error) {
    console.warn('[QUEUE] ORACLE same-chain sell-back quote unavailable:', error.message);
    return null;
  }
}

async function _readOracleInventoryCostBasis(agentId) {
  if (!agentId) {
    return {
      trackedInventoryEurc: 0,
      trackedInventoryCostUsdc: 0,
      averageEntryPriceUsdc: 0,
      costBasisSource: null,
      trackedSources: [],
    };
  }

  const { rows } = await db.query(
    `SELECT id::text AS id,
            type,
            amount_usdc::text AS amount_usdc,
            meta,
            created_at::text AS created_at
       FROM transactions
      WHERE agent_id = $1
        AND status = 'confirmed'
        AND type IN ('swap', 'rebalance', 'defi_loop_swap')
        AND (
          (COALESCE(meta->>'fromToken', '') = 'USDC' AND COALESCE(meta->>'toToken', '') = 'EURC')
          OR
          (COALESCE(meta->>'fromToken', '') = 'EURC' AND COALESCE(meta->>'toToken', '') = 'USDC')
        )
      ORDER BY created_at ASC, id ASC`,
    [agentId],
  );

  let trackedInventoryEurc = 0;
  let trackedInventoryCostUsdc = 0;
  const trackedSources = new Set();

  for (const row of rows) {
    const trackedSource = classifyStableCostBasisTransaction(row);
    if (!trackedSource) continue;

    trackedSources.add(trackedSource);
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const fromToken = String(meta.fromToken || '').toUpperCase();
    const toToken = String(meta.toToken || '').toUpperCase();

    if (fromToken === 'USDC' && toToken === 'EURC') {
      const spentUsdc = normalizeUsdcAmount(meta.requestedAmountIn || meta.amountIn || row.amount_usdc || 0);
      const receivedEurc = normalizeUsdcAmount(meta.amountOut || meta.entryAmountOutEurc || 0);
      if (spentUsdc > 0 && receivedEurc > 0) {
        trackedInventoryEurc = normalizeUsdcAmount(trackedInventoryEurc + receivedEurc);
        trackedInventoryCostUsdc = normalizeUsdcAmount(trackedInventoryCostUsdc + spentUsdc);
      }
      continue;
    }

    if (fromToken === 'EURC' && toToken === 'USDC' && trackedInventoryEurc > 0 && trackedInventoryCostUsdc > 0) {
      const soldEurc = normalizeUsdcAmount(meta.amountIn || 0);
      if (!(soldEurc > 0)) continue;

      const matchedEurc = Math.min(soldEurc, trackedInventoryEurc);
      const averageTrackedEntryPrice = trackedInventoryCostUsdc / trackedInventoryEurc;
      trackedInventoryCostUsdc = normalizeUsdcAmount(
        Math.max(trackedInventoryCostUsdc - (matchedEurc * averageTrackedEntryPrice), 0),
      );
      trackedInventoryEurc = normalizeUsdcAmount(Math.max(trackedInventoryEurc - matchedEurc, 0));

      if (!(trackedInventoryEurc > 0) || !(trackedInventoryCostUsdc > 0)) {
        trackedInventoryEurc = 0;
        trackedInventoryCostUsdc = 0;
      }
    }
  }

  const averageEntryPriceUsdc = trackedInventoryEurc > 0 && trackedInventoryCostUsdc > 0
    ? normalizeUsdcAmount(trackedInventoryCostUsdc / trackedInventoryEurc)
    : 0;

  return {
    trackedInventoryEurc,
    trackedInventoryCostUsdc,
    averageEntryPriceUsdc,
    costBasisSource: resolveOracleCostBasisSource(trackedSources),
    trackedSources: Array.from(trackedSources).sort(),
  };
}

function _resolveOracleMinEurcReserve(agent, walletReserveUsdc = 0) {
  const agentReserve = Number(agent?.oracle_min_eurc_reserve);
  if (Number.isFinite(agentReserve) && agentReserve >= 0) {
    return normalizeUsdcAmount(agentReserve);
  }
  return normalizeUsdcAmount(Math.max(Number(walletReserveUsdc || 0), 0));
}

async function _buildOracleInventoryExitPlan({ agent, availableEurcBalance, walletReserveUsdc, forexRate }) {
  const protectedEurcReserve = _resolveOracleMinEurcReserve(agent, walletReserveUsdc);
  const sellableEurc = normalizeUsdcAmount(Math.max(Number(availableEurcBalance || 0) - protectedEurcReserve, 0));
  if (!(sellableEurc > 0)) {
    return {
      profitable: false,
      inputEurc: 0,
      expectedUsdcOut: 0,
      expectedProfitUsdc: 0,
      protectedEurcReserve,
      routeReason: 'no_sellable_eurc',
    };
  }

  try {
    const inventoryCostBasis = await _readOracleInventoryCostBasis(agent?.id || agent?.agent_id);
    const sellQuote = await agentWalletService.getSwapQuoteResult({
      fromToken: 'EURC',
      toToken: 'USDC',
      amountIn: sellableEurc,
    });
    const expectedUsdcOut = normalizeUsdcAmount(sellQuote?.amountOut);
    const forexRateNumeric = Number(forexRate?.rate);
    const liveForexReferenceUsdcValue = Number.isFinite(forexRateNumeric) && forexRateNumeric > 0
      ? normalizeUsdcAmount(sellableEurc * forexRateNumeric)
      : 0;
    const minProfitUsdc = readPositiveNumberEnv(
      'ORACLE_SAME_CHAIN_MIN_PROFIT_USDC',
      DEFAULT_ORACLE_SAME_CHAIN_MIN_PROFIT_USDC,
    );
    const parityReferenceUsdcValue = normalizeUsdcAmount(sellableEurc);
    const trackedInventoryEurc = normalizeUsdcAmount(inventoryCostBasis.trackedInventoryEurc || 0);
    const trackedInventoryCostUsdc = normalizeUsdcAmount(inventoryCostBasis.trackedInventoryCostUsdc || 0);
    const averageEntryPriceUsdc = normalizeUsdcAmount(inventoryCostBasis.averageEntryPriceUsdc || 0);
    const costBasisSource = inventoryCostBasis.costBasisSource || null;
    const trackedSources = Array.isArray(inventoryCostBasis.trackedSources)
      ? inventoryCostBasis.trackedSources.filter(Boolean)
      : [];
    const costBasisReferenceUsdcValue = averageEntryPriceUsdc > 0
      ? normalizeUsdcAmount(sellableEurc * averageEntryPriceUsdc)
      : 0;
    const effectiveReferenceUsdcValue = normalizeUsdcAmount(Math.max(parityReferenceUsdcValue, costBasisReferenceUsdcValue));
    const minimumExpectedUsdcOut = normalizeUsdcAmount(effectiveReferenceUsdcValue + minProfitUsdc);
    const expectedProfitUsdc = normalizeUsdcAmount(expectedUsdcOut - effectiveReferenceUsdcValue);
    const profitBasis = costBasisReferenceUsdcValue > parityReferenceUsdcValue
      ? 'oracle_inventory_cost_basis'
      : 'swap_exit_parity_floor';

    return {
      profitable: expectedUsdcOut >= minimumExpectedUsdcOut,
      inputEurc: sellableEurc,
      expectedUsdcOut,
      expectedProfitUsdc,
      referenceRate: 1,
      referenceUsdcValue: effectiveReferenceUsdcValue,
      parityReferenceUsdcValue,
      costBasisReferenceUsdcValue,
      minimumExpectedUsdcOut,
      profitFloorUsdc: minProfitUsdc,
      liveForexRate: Number.isFinite(forexRateNumeric) && forexRateNumeric > 0 ? forexRateNumeric : null,
      liveForexReferenceUsdcValue,
      profitBasis,
      costBasisSource,
      trackedSources,
      trackedInventoryEurc,
      trackedInventoryCostUsdc,
      averageEntryPriceUsdc,
      protectedEurcReserve,
      exitExecutionRail: sellQuote?.executionRail || null,
      exitRouteStrategy: sellQuote?.routeStrategy || null,
      exitRouteReason: sellQuote?.routeReason || null,
    };
  } catch (error) {
    console.warn('[QUEUE] ORACLE inventory exit quote unavailable:', error.message);
    return {
      profitable: false,
      inputEurc: sellableEurc,
      expectedUsdcOut: 0,
      expectedProfitUsdc: 0,
      referenceRate: 0,
      referenceUsdcValue: 0,
      minimumExpectedUsdcOut: 0,
      profitFloorUsdc: 0,
      profitBasis: 'quote_unavailable',
      protectedEurcReserve,
      routeReason: error.message,
    };
  }
}

function _getOraclePostExitReentryCooldownMinutes() {
  return Math.max(
    Number.parseInt(
      process.env.ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES || String(DEFAULT_ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES),
      10,
    ) || DEFAULT_ORACLE_POST_EXIT_REENTRY_COOLDOWN_MINUTES,
    0,
  );
}

async function _readLatestConfirmedOracleInventoryExit(agentId) {
  if (!agentId) return null;

  const { rows: [row] } = await db.query(
    `SELECT created_at::text AS created_at,
            tx_hash,
            amount_usdc::text AS amount_usdc
       FROM transactions
      WHERE agent_id = $1
        AND type = 'rebalance'
        AND status = 'confirmed'
        AND meta->>'executionSource' = 'oracle_strategy_v1'
        AND COALESCE(meta->>'fromToken', '') = 'EURC'
        AND COALESCE(meta->>'toToken', '') = 'USDC'
      ORDER BY created_at DESC
      LIMIT 1`,
    [agentId],
  );

  return row || null;
}

function _buildOracleEntryCooldown(latestExit) {
  const cooldownMinutes = _getOraclePostExitReentryCooldownMinutes();
  const lastExitAtMs = Date.parse(latestExit?.created_at || '');

  if (!(cooldownMinutes > 0) || !Number.isFinite(lastExitAtMs)) {
    return {
      active: false,
      minutes: cooldownMinutes,
      lastExitAt: latestExit?.created_at || null,
      until: null,
      txHash: latestExit?.tx_hash || null,
    };
  }

  const untilMs = lastExitAtMs + (cooldownMinutes * 60_000);
  return {
    active: untilMs > Date.now(),
    minutes: cooldownMinutes,
    lastExitAt: latestExit.created_at,
    until: new Date(untilMs).toISOString(),
    txHash: latestExit?.tx_hash || null,
  };
}

async function readStableCurvePositionContext(walletAddress) {
  const stablePool = _getUsdcEurcCurvePool();
  const snapshot = await positionsService.getWalletPositions(walletAddress, {
    poolKeys: [stablePool?.key].filter(Boolean),
  });

  const warning = (snapshot.warnings || []).find(
    item => !stablePool?.key || item.poolKey === stablePool.key || item.poolKey === 'wallet',
  );
  if (warning) {
    return {
      ok: false,
      reason: 'position_guard_unavailable',
      error: warning.message,
    };
  }

  const position = (snapshot.positions || []).find(
    item => String(item.poolAddress || '').toLowerCase() === String(stablePool?.address || '').toLowerCase(),
  ) || null;

  return {
    ok: true,
    snapshot,
    position,
  };
}

async function readCirbtcDirectPairPositionContext(walletAddress) {
  const poolKeys = ['USDC-CIRBTC', 'EURC-CIRBTC'];
  const snapshot = await positionsService.getWalletPositions(walletAddress, { poolKeys });
  const positions = Array.isArray(snapshot.positions)
    ? snapshot.positions.filter(position => poolKeys.includes(String(position.poolKey || '').toUpperCase()))
    : [];
  const warnings = Array.isArray(snapshot.warnings)
    ? snapshot.warnings.filter(warning => poolKeys.includes(String(warning.poolKey || '').toUpperCase()))
    : [];

  return {
    ok: true,
    snapshot,
    positionsByKey: Object.fromEntries(
      positions.map(position => [String(position.poolKey || '').toUpperCase(), position]),
    ),
    warningsByKey: Object.fromEntries(
      warnings.map(warning => [String(warning.poolKey || '').toUpperCase(), warning.message || 'position_read_failed']),
    ),
  };
}

async function readCirbtcGrowthAddHistory(agentId, stableToken = null) {
  if (!agentId) {
    return {
      totalAddsToday: 0,
      lastAddAt: null,
    };
  }

  const now = new Date();
  const dayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const normalizedStableToken = stableToken ? String(stableToken).trim().toUpperCase() : null;
  const queryParams = [agentId, dayStartUtc.toISOString()];
  const stableTokenFilter = normalizedStableToken
    ? `
        AND UPPER(COALESCE(token, meta->>'stableToken', '')) = $3`
    : '';

  if (normalizedStableToken) {
    queryParams.push(normalizedStableToken);
  }

  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS adds_today,
            MAX(created_at) AS last_add_at
       FROM transactions
      WHERE agent_id = $1
        AND type = 'direct_lp_add'
        AND status = 'confirmed'
        AND created_at >= $2
        AND COALESCE(meta->>'executionSource', '') = 'cirbtc_lp_policy_v1'${stableTokenFilter}`,
    queryParams,
  );

  return {
    totalAddsToday: Number(rows?.[0]?.adds_today || 0),
    lastAddAt: rows?.[0]?.last_add_at || null,
  };
}

async function loadCirbtcDirectPairPoolContexts() {
  const stableTokens = ['USDC', 'EURC'];
  const settled = await Promise.allSettled(
    stableTokens.map(async (stableToken) => {
      const pool = _getCirbtcDirectPairPool(stableToken);
      if (!pool?.address) {
        return {
          stableToken,
          pool: null,
          poolState: null,
          error: 'direct_pair_not_configured',
        };
      }

      const poolState = await oracle.getConstantProductPoolState(pool);
      return {
        stableToken,
        pool,
        poolState,
        error: null,
      };
    }),
  );

  return stableTokens.map((stableToken, index) => {
    const result = settled[index];
    if (result?.status === 'fulfilled') {
      return result.value;
    }

    return {
      stableToken,
      pool: _getCirbtcDirectPairPool(stableToken),
      poolState: null,
      error: result?.reason?.message || 'pool_state_unavailable',
    };
  });
}

async function executeStableAutomationTask({ agent, operationType, actionParams, dryRunEnabled }) {
  if (operationType === 'add_liquidity') {
    if (String(actionParams?.mode || '').toLowerCase() === 'balanced') {
      return agenticTaskExecutionService.executeCurveLiquidityAddBalancedTask({
        agent,
        params: actionParams,
        dryRun: dryRunEnabled,
      });
    }

    return agenticTaskExecutionService.executeCurveLiquidityAddTask({
      agent,
      params: actionParams,
      dryRun: dryRunEnabled,
    });
  }

  if (operationType === 'remove_liquidity') {
    if (String(actionParams?.mode || '').toLowerCase() === 'balanced') {
      return agenticTaskExecutionService.executeCurveLiquidityRemoveBalancedTask({
        agent,
        params: { lpAmount: actionParams.lpAmount },
        dryRun: dryRunEnabled,
      });
    }

    return agenticTaskExecutionService.executeCurveLiquidityRemoveTask({
      agent,
      params: {
        lpAmount: actionParams.lpAmount,
        tokenOut: actionParams.tokenOut || 'USDC',
      },
      dryRun: dryRunEnabled,
    });
  }

  if (operationType === 'rebalance') {
    return agenticTaskExecutionService.executeRebalanceTask({
      agent,
      params: {
        ...actionParams,
        slippage: parseFloat(agent.slippage_percent) || 0.5,
      },
      dryRun: dryRunEnabled,
    });
  }

  return { ok: false, reason: 'unsupported_stable_operation' };
}

async function executeCirbtcLpAutomationTask({ agent, operationType, actionParams, dryRunEnabled }) {
  const stableToken = String(actionParams?.stableToken || 'USDC').trim().toUpperCase();

  if (operationType === 'add_liquidity') {
    return agenticTaskExecutionService.executeDirectPairZapInTask({
      agent,
      params: {
        amountIn: actionParams?.amountIn,
      },
      dryRun: dryRunEnabled,
      stableToken,
    });
  }

  if (operationType === 'remove_liquidity') {
    return agenticTaskExecutionService.executeDirectPairRemoveLiquidityTask({
      agent,
      params: {
        withdrawPct: actionParams?.withdrawPct,
      },
      dryRun: dryRunEnabled,
      stableToken,
    });
  }

  return { ok: false, reason: 'cirbtc_automation_operation_unsupported' };
}

queue.process('ORACLE_QUERY', 2, async (job) => {
  const { agentId } = job.data;
  console.log(`[QUEUE] ORACLE_QUERY agent=${agentId}`);
  await _setAutomationState(agentId, 'oracle', 'running');
  const finishOracle = async (status, payload) => {
    await _setAutomationState(agentId, 'oracle', status);
    return payload;
  };

  // Reload agent — double-check flag (may have been toggled off since job was queued)
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted, oracle_enabled,
            daily_market_analysis_count, oracle_daily_reset_at, daily_limit_reset_at,
            daily_tasks_enabled, defi_loop_enabled, daily_defi_loop_count, wallet_address,
            private_key_encrypted,
            gateway_auto_topup_enabled, gateway_auto_topup_min_usdc, gateway_auto_topup_target_usdc
     FROM agents WHERE id = $1`,
    [agentId],
  );

  if (!agent)                return finishOracle('missing_agent', { ok: false, reason: 'agent_not_found' });
  if (!agent.oracle_enabled) return finishOracle('disabled', { ok: false, reason: 'oracle_disabled' });

  // Reset daily counter if it's a new day
  const resetAt   = new Date(agent.oracle_daily_reset_at || agent.daily_limit_reset_at);
  const nowUtc    = new Date();
  const newDay    = resetAt.toISOString().slice(0, 10) < nowUtc.toISOString().slice(0, 10);
  if (newDay) {
    await db.query(
      `UPDATE agents
       SET daily_market_analysis_count = 0,
           oracle_daily_reset_at       = NOW()
       WHERE id = $1`,
      [agentId],
    );
    agent.daily_market_analysis_count = 0;
  }

  // Daily cap: max 48 oracle queries per agent by default (every 30 min x 24h)
  if (!isDailyLimitBypassed(agent) && agent.daily_market_analysis_count >= DAILY_ORACLE_CAP) {
    console.log(`[QUEUE] ORACLE_QUERY agent=${agentId} daily cap reached`);
    return finishOracle('cap_reached', { ok: false, reason: 'daily_cap_reached', count: agent.daily_market_analysis_count });
  }

  if (shouldSuspendScanJobsWhenDefiCapReached(agent)) {
    console.log(`[QUEUE] ORACLE_QUERY agent=${agentId} paused because this agent's daily DeFi cap is full`);
    return finishOracle('cap_reached', {
      ok: false,
      reason: 'shared_defi_daily_cap_reached',
      count: agent.daily_defi_loop_count,
      summary: "Oracle snapshots are paused because this agent's daily DeFi automation cap is already full.",
    });
  }

  await maybeWarmAgentGatewayBalance(agent, 'oracle_query');

  // ── Fetch oracle data ──────────────────────────────────────────────────────
  let forexRate, poolState;
  try {
    forexRate = await oracle.getForexRate('EURC', 'USDC');
    poolState  = await _getOracleStablePoolState(forexRate);
  } catch (err) {
    console.error(`[QUEUE] ORACLE_QUERY fetch error agent=${agentId}:`, err.message);
    return finishOracle('fetch_error', { ok: false, reason: 'oracle_fetch_error', error: err.message });
  }

  const signal = oracle.buildArbSignal({
    strategy:      'stablecoin_fx',
    forexRate:     forexRate.rate,
    poolRate:      poolState.impliedRate,
    poolFee:       poolState.fee,
    poolLiquidity: (poolState.reserves?.token0 ?? 0) + (poolState.reserves?.token1 ?? 0),
    priceImpacts:  poolState.priceImpact,
    baseToken:     'EURC',
    quoteToken:    'USDC',
  });

  // ── Run through engine ─────────────────────────────────────────────────────
  let executionGate = null;
  let decisionError = false;
  const permissions = await getAgentPermissionMap(agentId);
  const arbitragePermissionGranted = permissions.arbitrage !== false;
  try {
    executionGate = await evaluateExecutionGate(agent, signal, agentId);
    console.log(`[QUEUE] ORACLE_QUERY gate (${executionGate.engine}) agent=${agentId}:`, String(executionGate.decision).slice(0, 120));
  } catch (err) {
    console.error(`[QUEUE] ORACLE_QUERY engine error agent=${agentId}:`, err.message);
    decisionError = true;
  }

  // ── Increment counter + log ────────────────────────────────────────────────
  await db.query(
    'UPDATE agents SET daily_market_analysis_count = daily_market_analysis_count + 1 WHERE id = $1',
    [agentId],
  );

  // Log the signal + decision to transactions table as an 'oracle_signal' record
  if (signal.opportunity.found) {
    const dailyLimitBypass = getDailyLimitBypass(agent);
    const defiLoopCapReached = !dailyLimitBypass.enabled
      && Number(agent.daily_defi_loop_count || 0) >= DAILY_DEFI_LOOP_CAP;
    const executionPermissionGranted = Boolean(agent.defi_loop_enabled && arbitragePermissionGranted);
    const gateAllowsExecution = executionPermissionGranted
      && executionGate?.verdict?.execute === true
      && !defiLoopCapReached;
    const signalMeta = {
      signal,
      decision: executionGate?.decision || null,
      executionGate,
      permissions: {
        arbitrage: arbitragePermissionGranted,
      },
      dailyLimitBypass,
      dailyCap: DAILY_DEFI_LOOP_CAP,
      dailyCapCount: agent.daily_defi_loop_count ?? 0,
      executionPermissionGranted,
      executionState: !executionPermissionGranted
        ? 'signal_only'
        : defiLoopCapReached
          ? 'daily_cap_reached'
        : gateAllowsExecution
          ? 'eligible_for_defi_loop'
          : 'gate_blocked',
      signalOnlyReason: !arbitragePermissionGranted
        ? 'Signal only — the Arbitrage strategy preference is disabled for this agent, so autonomous oracle strategy execution is blocked.'
        : !agent.defi_loop_enabled
        ? 'Signal only — autonomous DeFi execution is disabled for this agent, so no on-chain trade was submitted.'
        : defiLoopCapReached
        ? `Autonomous DeFi execution is enabled, but no on-chain trade was submitted because this agent already used ${agent.daily_defi_loop_count || 0}/${DAILY_DEFI_LOOP_CAP} daily DeFi loop runs.`
        : executionPermissionGranted
        ? (gateAllowsExecution
          ? 'Autonomous DeFi execution is enabled for this agent and the execution gate currently approves this opportunity.'
          : `Autonomous DeFi execution is enabled, but the execution gate returned HOLD${executionGate?.verdict?.reason ? `: ${executionGate.verdict.reason}` : '.'}`)
        : 'Signal only — autonomous DeFi execution is disabled for this agent, so no on-chain trade was submitted.',
    };

    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'oracle_signal', 'arc-testnet', 'arc-testnet', 'USDC', $2, 'pending', $3::jsonb)`,
      [
        agentId,
        signal.opportunity.expectedProfitUsdc,
        JSON.stringify(signalMeta),
      ],
    );
  }

  // Reputation hook — fire-and-forget, never blocks
  recordReputationEvent(agentId, EVENT_TYPES.ORACLE_QUERY).catch(() => {});

  return finishOracle(
    decisionError ? 'decision_error' : signal.opportunity.found ? 'success' : 'no_signal',
    { ok: true, found: signal.opportunity.found, confidence: signal.opportunity.confidence, executionGate },
  );
});

// ── Schedule oracle queries for all eligible agents ──────────────────────────
// Called from server.js bootstrap once DB is ready.
async function scheduleOracleLoop() {
  if (!ORACLE_LOOP_INTERVAL_MS || ORACLE_LOOP_INTERVAL_MS < 60_000) return;

  setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT id, wallet_address, daily_defi_loop_count, defi_daily_reset_at, daily_limit_reset_at,
                oracle_last_run_at, oracle_last_status
           FROM agents
         WHERE oracle_enabled = TRUE
           AND status NOT IN ('locked', 'inactive')`,
      );
      let queuedCount = 0;
      let suspendedCount = 0;
      let runningSkipCount = 0;
      for (const agent of rows) {
        if (shouldSuspendScanJobsWhenDefiCapReached(agent)) {
          suspendedCount += 1;
          continue;
        }

        if (String(agent.oracle_last_status || '').toLowerCase() === 'running') {
          const lastRunAtMs = Date.parse(agent.oracle_last_run_at || '');
          if (Number.isFinite(lastRunAtMs) && (Date.now() - lastRunAtMs) < ORACLE_RUNNING_REQUEUE_GRACE_MS) {
            runningSkipCount += 1;
            continue;
          }
        }

        const { id } = agent;
        await queue.add('ORACLE_QUERY', { agentId: id }, { jobId: `oracle-${id}-${Date.now()}` });
        queuedCount += 1;
      }
      if (queuedCount > 0) {
        console.log(`[ORACLE_LOOP] Queued ${queuedCount} oracle job(s)`);
      }
      if (suspendedCount > 0) {
        console.log(`[ORACLE_LOOP] Skipped ${suspendedCount} oracle job(s) because the shared daily DeFi cap is already full`);
      }
      if (runningSkipCount > 0) {
        console.log(`[ORACLE_LOOP] Skipped ${runningSkipCount} oracle job(s) because a recent run is still marked running`);
      }
    } catch (err) {
      console.error('[ORACLE_LOOP] Schedule error:', err.message);
    }
  }, ORACLE_LOOP_INTERVAL_MS);

  console.log(`[ORACLE_LOOP] Started — interval ${ORACLE_LOOP_INTERVAL_MS / 60000} min`);
}

async function scheduleMarketAnalysisLoop() {
  if (!MARKET_ANALYSIS_LOOP_INTERVAL_MS || MARKET_ANALYSIS_LOOP_INTERVAL_MS < 60_000) return;

  setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT id, wallet_address, daily_defi_loop_count, defi_daily_reset_at, daily_limit_reset_at,
                market_analysis_last_run_at, market_analysis_last_status
           FROM agents
         WHERE market_analysis_enabled = TRUE
           AND is_smart_mode = TRUE
           AND status NOT IN ('locked', 'inactive')`,
      );
      let queuedCount = 0;
      let suspendedCount = 0;
      let runningSkipCount = 0;
      for (const agent of rows) {
        if (shouldSuspendScanJobsWhenDefiCapReached(agent)) {
          suspendedCount += 1;
          continue;
        }

        if (String(agent.market_analysis_last_status || '').toLowerCase() === 'running') {
          const lastRunAtMs = Date.parse(agent.market_analysis_last_run_at || '');
          if (Number.isFinite(lastRunAtMs) && (Date.now() - lastRunAtMs) < MARKET_ANALYSIS_RUNNING_REQUEUE_GRACE_MS) {
            runningSkipCount += 1;
            continue;
          }
        }

        const { id } = agent;
        await queue.add(
          'MARKET_ANALYSIS',
          { agentId: id, chain: 'arc-testnet', token: 'USDC' },
          { jobId: `market-analysis-${id}-${Date.now()}` },
        );
        queuedCount += 1;
      }
      if (queuedCount > 0) {
        console.log(`[MARKET_ANALYSIS_LOOP] Queued ${queuedCount} market analysis job(s)`);
      }
      if (suspendedCount > 0) {
        console.log(`[MARKET_ANALYSIS_LOOP] Skipped ${suspendedCount} market analysis job(s) because the shared daily DeFi cap is already full`);
      }
      if (runningSkipCount > 0) {
        console.log(`[MARKET_ANALYSIS_LOOP] Skipped ${runningSkipCount} market analysis job(s) because a recent run is still marked running`);
      }
    } catch (err) {
      console.error('[MARKET_ANALYSIS_LOOP] Schedule error:', err.message);
    }
  }, MARKET_ANALYSIS_LOOP_INTERVAL_MS);

  console.log(`[MARKET_ANALYSIS_LOOP] Started — interval ${MARKET_ANALYSIS_LOOP_INTERVAL_MS / 60000} min`);
}

// ── DEFI_LOOP ─────────────────────────────────────────────────────────────────
// Runs for agents with at least one enabled DeFi automation lane.
// Flow: oracle fetch → arb signal → engine decision → protocol tx (unless dry-run stays enabled for this agent).
// Hard cap: 10 runs per agent per day (daily_defi_loop_count).

queue.process('DEFI_LOOP', DEFI_LOOP_WORKER_CONCURRENCY, async (job) => {
  const { agentId } = job.data;
  const carryTaskRunId = job?.data?.taskRunId || null;
  const carrySourceTaskId = String(job?.data?.sourceTaskId || '').trim().toUpperCase();
  const carryFollowupPhase = String(job?.data?.carryFollowupPhase || 'initial').trim().toLowerCase();
  const shouldTrackAutoCarryTaskRun = Boolean(carryTaskRunId && carrySourceTaskId === 'EXEC_AUTO_CARRY_START');
  let recoveredPendingAutoCarryTaskRun = null;
  let pendingAutoCarryTaskRunResolved = false;

  let latestStablePolicy = null;
  let latestStableLanePolicy = null;
  let latestLendingPolicy = null;
  let latestCarryPolicy = null;
  let latestLendingSurface = null;
  let latestExecutionSource = null;
  let latestAvailableUsdcBalance = null;
  let latestAvailableEurcBalance = null;
  let latestAvailableToTradeUsdc = null;
  let latestWalletReserveUsdc = null;
  let latestPositionSummary = null;
  let activeAutomationKey = 'defiLoop';
  let stableStatePersisted = false;
  let allowCirbtcReviewDespiteStablePriority = false;

  const persistAutomationSnapshot = async (automationKey, status, payload) => {
    await _setAutomationState(agentId, automationKey, status);
    const decision = automationKey === 'lendingAutomation'
      ? buildLendingAutomationDecisionSnapshot({
          status,
          payload,
          lendingPolicy: latestLendingPolicy,
          lendingSurface: latestLendingSurface,
        })
      : automationKey === 'carryAutomation'
        ? buildCarryAutomationDecisionSnapshot({
            status,
            payload,
            carryPolicy: latestCarryPolicy,
            lendingSurface: latestLendingSurface,
          })
      : buildDefiLoopDecisionSnapshot({
          status,
          payload,
          stablePolicy: latestStablePolicy,
          stableLanePolicy: latestStableLanePolicy,
          executionSource: latestExecutionSource,
          availableUsdcBalance: latestAvailableUsdcBalance,
          availableEurcBalance: latestAvailableEurcBalance,
          availableToTradeUsdc: latestAvailableToTradeUsdc,
          walletReserveUsdc: latestWalletReserveUsdc,
          positionSummary: latestPositionSummary,
        });
    await _setAutomationDecision(agentId, automationKey, decision);

    if (automationKey === 'oracle') {
      await _setAutomationState(agentId, 'defiLoop', status);
      await _setAutomationDecision(agentId, 'defiLoop', decision);
    }
  };

  const resolveTrackedOrRecoveredAutoCarryTaskRun = async (status, payload) => {
    if (shouldTrackAutoCarryTaskRun) {
      return {
        taskRunId: carryTaskRunId,
        sourceTaskId: carrySourceTaskId,
        carryFollowupPhase,
        adopted: false,
      };
    }

    if (activeAutomationKey !== 'carryAutomation') return null;
    if (payload?.ok === false) return null;

    const carryAction = String(payload?.action || '').trim().toLowerCase();
    const carryState = String(latestCarryPolicy?.metrics?.carryState || '').trim().toLowerCase();
    const canRecoverFromGenericCarryAction = (
      carryAction === 'open_carry'
      || carryAction === 'deploy_wallet_balance'
      || carryAction === 'close_carry'
      || carryAction === 'repay_wallet_balance'
    );
    const canRecoverFromCarryHold = status === 'policy_hold' && carryState === 'active';

    if (!canRecoverFromGenericCarryAction && !canRecoverFromCarryHold) return null;
    if (pendingAutoCarryTaskRunResolved) return recoveredPendingAutoCarryTaskRun;

    pendingAutoCarryTaskRunResolved = true;
    const pendingRun = await taskRunService.findActiveTaskRun(agentId, 'EXEC_AUTO_CARRY_START').catch(() => null);
    if (!pendingRun) {
      recoveredPendingAutoCarryTaskRun = null;
      return null;
    }

    const pendingStageKey = String(pendingRun.stage_key || '').trim().toLowerCase();
    const inferredFollowupPhase = (
      carryAction === 'deploy_wallet_balance'
      || carryAction === 'repay_wallet_balance'
      || carryAction === 'close_carry'
      || carryState === 'active'
      || pendingStageKey === 'carry_waiting_followup'
      || pendingStageKey === 'carry_followup_running'
    )
      ? 'followup'
      : 'initial';

    recoveredPendingAutoCarryTaskRun = {
      taskRunId: pendingRun.id,
      sourceTaskId: 'EXEC_AUTO_CARRY_START',
      carryFollowupPhase: inferredFollowupPhase,
      adopted: true,
    };

    return recoveredPendingAutoCarryTaskRun;
  };

  const finishDefi = async (status, payload) => {
    await persistAutomationSnapshot(activeAutomationKey, status, payload);

    const trackedAutoCarryTaskRun = await resolveTrackedOrRecoveredAutoCarryTaskRun(status, payload);

    if (trackedAutoCarryTaskRun) {
      const trackedTaskRunId = trackedAutoCarryTaskRun.taskRunId;
      const trackedSourceTaskId = trackedAutoCarryTaskRun.sourceTaskId;
      const trackedCarryFollowupPhase = trackedAutoCarryTaskRun.carryFollowupPhase;
      const resultPayload = {
        ...(payload || {}),
        ok: payload?.ok !== false,
        carryTriggerTaskId: trackedSourceTaskId,
        carryFollowupPhase: trackedCarryFollowupPhase,
        finalAutomationStatus: status,
        recoveredFromGenericDefiLoop: trackedAutoCarryTaskRun.adopted === true,
      };

      if (payload?.ok === false) {
        await _saveResultOnly(agentId, trackedSourceTaskId, {
          ...resultPayload,
          ok: false,
          skipped: false,
          summary: payload?.summary || payload?.error || payload?.reason || 'Auto Carry handoff failed.',
        }).catch(() => {});
        await taskRunService.failTaskRun(trackedTaskRunId, {
          error: payload?.error || payload?.summary || payload?.reason || 'auto_carry_handoff_failed',
          stageKey: 'carry_handoff_failed',
          stageLabel: 'Auto Carry Failed',
          stageDetail: payload?.summary || payload?.error || payload?.reason || 'Auto Carry handoff failed.',
          resultPayload,
        }).catch(() => {});
      } else if (payload?.action === 'open_carry' && payload?.followupQueued) {
        const delaySeconds = Math.round(Number(payload.followupDelayMs || CARRY_AUTOMATION_FOLLOWUP_DELAY_MS) / 1000);
        await taskRunService.updateTaskRunStage(trackedTaskRunId, {
          status: 'running',
          stageKey: 'carry_waiting_followup',
          stageLabel: 'Waiting For Follow-Up',
          stageDetail: delaySeconds > 0
            ? `Borrow opened. The queued ${delaySeconds}-second follow-up is still finishing the autonomous carry handoff.`
            : 'Borrow opened. The queued follow-up is finishing the autonomous carry handoff.',
        }).catch(() => {});
      } else {
        await _saveResultOnly(agentId, trackedSourceTaskId, resultPayload).catch(() => {});
        await taskRunService.completeTaskRun(trackedTaskRunId, {
          resultPayload,
          stageKey: 'carry_handoff_completed',
          stageLabel: 'Completed',
          stageDetail: payload?.summary || (trackedCarryFollowupPhase === 'followup'
            ? 'The follow-up carry cycle completed.'
            : 'The Auto Carry handoff completed.'),
        }).catch(() => {});
      }
    }

    return payload;
  };

  if (shouldTrackAutoCarryTaskRun) {
    await _reportTaskRunStage(carryTaskRunId, {
      stageKey: carryFollowupPhase === 'followup' ? 'carry_followup_running' : 'carry_initial_review',
      stageLabel: carryFollowupPhase === 'followup' ? 'Carry Follow-Up' : 'Carry Review',
      stageDetail: carryFollowupPhase === 'followup'
        ? 'The queued follow-up carry cycle is finishing the autonomous handoff.'
        : 'Auto Carry is running the first live review after the paid trigger.',
    });
  }

  // Reload agent — verify flag still on + fetch encrypted key
  const { rows: [agent] } = await db.query(
    `SELECT id, llm_model, llm_api_key_encrypted,
            defi_loop_enabled, lending_automation_enabled, carry_automation_enabled, cirbtc_lp_enabled, oracle_enabled,
            daily_defi_loop_count, defi_daily_reset_at, daily_limit_reset_at,
          daily_limit_usdc, max_trade_usdc, defi_wallet_reserve_usdc,
          oracle_max_eurc_inventory, oracle_min_eurc_reserve, slippage_percent,
            gateway_auto_topup_enabled, gateway_auto_topup_min_usdc, gateway_auto_topup_target_usdc,
            wallet_address, private_key_encrypted,
            market_analysis_last_decision,
            stable_manual_cooldown_until
     FROM agents WHERE id = $1`,
    [agentId],
  );

  if (!agent) return finishDefi('missing_agent', { ok: false, reason: 'agent_not_found' });

  const permissions = await getAgentPermissionMap(agentId);
  const arbitragePermissionGranted = permissions.arbitrage !== false;
  const stableLoopConfigured = Boolean(agent.defi_loop_enabled);
  const lendingAutomationEnabled = Boolean(agent.lending_automation_enabled);
  const carryAutomationEnabled = Boolean(agent.carry_automation_enabled);
  const cirbtcLpConfigured = Boolean(agent.cirbtc_lp_enabled);
  const stableLoopEnabled = Boolean(stableLoopConfigured && arbitragePermissionGranted);
  const cirbtcLpEnabled = Boolean(cirbtcLpConfigured && arbitragePermissionGranted);
  activeAutomationKey = lendingAutomationEnabled
    ? 'lendingAutomation'
    : carryAutomationEnabled
      ? 'carryAutomation'
    : stableLoopConfigured
      ? 'defiLoop'
      : 'cirbtcLp';

  if (stableLoopEnabled && !carryAutomationEnabled) {
    await _setAutomationState(agentId, 'defiLoop', 'running');
  }
  if (lendingAutomationEnabled) {
    await _setAutomationState(agentId, 'lendingAutomation', 'running');
  }
  if (carryAutomationEnabled) {
    await _setAutomationState(agentId, 'carryAutomation', 'running');
  }
  if (cirbtcLpEnabled && !carryAutomationEnabled) {
    await _setAutomationState(agentId, 'cirbtcLp', 'running');
  }

  const shouldSkipDefiCycle = !stableLoopEnabled
    && !lendingAutomationEnabled
    && !carryAutomationEnabled
    && !cirbtcLpEnabled;

  const marketAnalysisDecision = agent.market_analysis_last_decision
    && typeof agent.market_analysis_last_decision === 'object'
    && Object.keys(agent.market_analysis_last_decision).length > 0
    ? agent.market_analysis_last_decision
    : null;

  // Reset daily counters if new day
  const resetAt = new Date(agent.defi_daily_reset_at || agent.daily_limit_reset_at);
  const nowUtc  = new Date();
  if (resetAt.toISOString().slice(0, 10) < nowUtc.toISOString().slice(0, 10)) {
    await db.query(
      `UPDATE agents
       SET daily_defi_loop_count       = 0,
           daily_auto_tx_count         = 0,
           defi_daily_reset_at         = NOW()
       WHERE id = $1`,
      [agentId],
    );
    agent.daily_defi_loop_count = 0;
  }

  const dryRunEnabled = shouldUseDryRun(agent);
  console.log(`[QUEUE] DEFI_LOOP agent=${agentId} dry=${dryRunEnabled}`);

  // Daily cap check
  if (!isDailyLimitBypassed(agent) && agent.daily_defi_loop_count >= DAILY_DEFI_LOOP_CAP) {
    console.log(`[QUEUE] DEFI_LOOP agent=${agentId} daily cap reached (${DAILY_DEFI_LOOP_CAP})`);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, 'defi_loop_dry', 'arc-testnet', 'arc-testnet', 'USDC', 0, 'skipped', $2::jsonb)`,
      [agentId, JSON.stringify({
        executionState: 'daily_cap_reached',
        executionSource: 'oracle_strategy',
        reason: 'daily_cap_reached',
        summary: 'Skipped before the next EURC/USDC oracle strategy review could start because the daily DeFi loop cap was already reached.',
        dailyCap: DAILY_DEFI_LOOP_CAP,
        dailyCapCount: agent.daily_defi_loop_count,
        signal: {
          strategy: 'stablecoin_fx',
        },
        fromToken: 'USDC',
        toToken: 'EURC',
      })],
    );
    return finishDefi('cap_reached', { ok: false, reason: 'daily_cap_reached', count: agent.daily_defi_loop_count });
  }

  // Count each started cycle once the shared daily cap gate is cleared.
  await db.query(
    'UPDATE agents SET daily_defi_loop_count = daily_defi_loop_count + 1 WHERE id = $1',
    [agentId],
  );

  if (shouldSkipDefiCycle) {
    if (!arbitragePermissionGranted && (stableLoopConfigured || cirbtcLpConfigured)) {
      await db.query(
        `INSERT INTO transactions
           (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
         VALUES ($1, 'defi_loop_dry', 'arc-testnet', 'arc-testnet', 'USDC', 0, 'dry_run', $2::jsonb)`,
        [agentId, JSON.stringify({
          executionState: 'permission_blocked',
          executionSource: 'oracle_strategy',
          reason: 'Arbitrage strategy preference is disabled for this agent.',
          permission: 'arbitrage',
        })],
      );

      return finishDefi('permission_blocked', {
        ok: true,
        action: 'hold',
        reason: 'permission_blocked',
        permission: 'arbitrage',
      });
    }

    return finishDefi('disabled', { ok: false, reason: 'defi_loop_disabled' });
  }

  await maybeWarmAgentGatewayBalance(agent, 'defi_loop');

  let forexRate = null;
  let poolState = null;
  let signal = {
    strategy: 'stablecoin_fx',
    opportunity: {
      found: false,
      confidence: 'LOW',
      netProfitUsdc: 0,
      amountUsdc: 0,
      steps: [],
    },
  };
  let executionGate = null;
  let requestedPolicyAmountUsdc = 0;
  let pricingPool = null;
  let swapPool = null;
  let positionContext = { ok: true, snapshot: null, position: null };
  let lendingCirbtcPositionsByKey = {};

  if (stableLoopEnabled || carryAutomationEnabled) {
    try {
      forexRate = await oracle.getForexRate('EURC', 'USDC');
      poolState = await _getOracleStablePoolState(forexRate);
    } catch (err) {
      console.error(`[QUEUE] DEFI_LOOP oracle error agent=${agentId}:`, err.message);
      activeAutomationKey = carryAutomationEnabled && !stableLoopEnabled ? 'carryAutomation' : activeAutomationKey;
      return finishDefi('fetch_error', {
        ok: false,
        reason: stableLoopEnabled ? 'oracle_fetch_error' : 'stable_pool_state_unavailable',
        error: err.message,
      });
    }
  }

  if (stableLoopEnabled) {
    signal = oracle.buildArbSignal({
      strategy:      'stablecoin_fx',
      forexRate:     forexRate.rate,
      poolRate:      poolState.impliedRate,
      poolFee:       poolState.fee,
      poolLiquidity: (poolState.reserves?.token0 ?? 0) + (poolState.reserves?.token1 ?? 0),
      priceImpacts:  poolState.priceImpact,
      baseToken:     'EURC',
      quoteToken:    'USDC',
    });

    try {
      executionGate = await evaluateExecutionGate(agent, signal, agentId);
    } catch (err) {
      console.error(`[QUEUE] DEFI_LOOP engine error agent=${agentId}:`, err.message);
    }

    const signalSuggestedAmountUsdc = normalizeUsdcAmount(
      signal.opportunity.steps?.[0]?.amountUsdc || signal.opportunity.amountUsdc || 0,
    );
    const advisorySuggestedAmountUsdc = executionGate?.verdict?.execute === true
      ? normalizeUsdcAmount(executionGate?.verdict?.suggestedAmount)
      : 0;
    requestedPolicyAmountUsdc = normalizeUsdcAmount(
      advisorySuggestedAmountUsdc > 0
        ? Math.min(signalSuggestedAmountUsdc || advisorySuggestedAmountUsdc, advisorySuggestedAmountUsdc)
        : signalSuggestedAmountUsdc,
    );
    pricingPool = _getEurcUsdcCurvePool();
    swapPool = _getUsdcEurcCurvePool();

    try {
      positionContext = await readStableCurvePositionContext(agent.wallet_address);
    } catch (err) {
      console.error(`[QUEUE] DEFI_LOOP position guard error agent=${agentId}:`, err.message);
      return finishDefi('position_guard_unavailable', {
        ok: false,
        reason: 'position_guard_unavailable',
        error: err.message,
      });
    }

    if (!positionContext.ok) {
      return finishDefi('position_guard_unavailable', {
        ok: false,
        reason: positionContext.reason,
        error: positionContext.error,
      });
    }
  } else if (lendingAutomationEnabled || carryAutomationEnabled) {
    try {
      const lendingStablePositionContext = await readStableCurvePositionContext(agent.wallet_address);
      if (lendingStablePositionContext.ok) {
        positionContext = lendingStablePositionContext;
      }
    } catch (err) {
      console.warn(`[QUEUE] DEFI_LOOP lending stable-position snapshot unavailable agent=${agentId}:`, err.message);
    }
  }

  const walletReserveUsdc = normalizeUsdcAmount(Math.max(Number(agent.defi_wallet_reserve_usdc || 0), 0));
  let availableUsdcBalance = 0;
  let availableEurcBalance = 0;
  let balancesAvailable = true;
  try {
    [availableUsdcBalance, availableEurcBalance] = await Promise.all([
      getArcUsdcBalance(agent.wallet_address),
      getArcEurcBalance(agent.wallet_address),
    ]);
  } catch (err) {
    balancesAvailable = false;
    console.error(`[QUEUE] DEFI_LOOP stable balance check error agent=${agentId}:`, err.message);
  }
  const availableToTradeUsdc = balancesAvailable
    ? normalizeUsdcAmount(Math.max(availableUsdcBalance - walletReserveUsdc, 0))
    : 0;
  latestAvailableUsdcBalance = availableUsdcBalance;
  latestAvailableEurcBalance = availableEurcBalance;
  latestAvailableToTradeUsdc = availableToTradeUsdc;
  latestWalletReserveUsdc = walletReserveUsdc;
  const stablePolicy = stableLoopEnabled
    ? evaluateStableAutomationPolicy({
        agent,
        forexRate,
        poolState,
        signal,
        pricingPool,
        swapPool,
        requestedAmountUsdc: requestedPolicyAmountUsdc,
        walletBalances: {
          usdc: availableUsdcBalance,
          eurc: availableEurcBalance,
        },
        walletReserveUsdc,
        position: positionContext.position,
        marketAnalysis: marketAnalysisDecision,
        manualCooldownUntil: agent.stable_manual_cooldown_until,
      })
    : {
        policyId: 'stable_usdc_eurc_curve_v1',
        verdict: {
          execute: false,
          lane: 'stable_curve',
          operationType: null,
          reason: 'Stable DeFi automation is disabled for this agent.',
          suggestedAmountUsdc: 0,
          actionAssetSymbol: 'USDC',
          actionParams: null,
          blockedBy: 'disabled',
        },
        metrics: {
          positionPresent: false,
        },
        checks: {},
      };
  latestStablePolicy = stablePolicy;
  latestStableLanePolicy = stablePolicy;
  const cirbtcIdleCapitalBudgets = getCirbtcIdleCapitalBudgets({
    stablePolicy,
    availableToTradeUsdc,
    availableEurcBalance,
  });

  let lendingPolicy = null;
  if (lendingAutomationEnabled || carryAutomationEnabled) {
    try {
      const lendingCirbtcPositionContext = lendingAutomationEnabled
        ? await readCirbtcDirectPairPositionContext(agent.wallet_address).catch((error) => {
            console.warn(`[QUEUE] DEFI_LOOP lending cirBTC position snapshot unavailable agent=${agentId}:`, error.message);
            return {
              ok: true,
              positionsByKey: {},
              warningsByKey: {},
            };
          })
        : {
            ok: true,
            positionsByKey: {},
            warningsByKey: {},
          };
      lendingCirbtcPositionsByKey = lendingCirbtcPositionContext?.positionsByKey || {};
      latestLendingSurface = await nativeLendingRiskService.buildLendingSurfaceForWallet(agent.wallet_address);
      if (lendingAutomationEnabled) {
        lendingPolicy = evaluateLendingAutomationPolicy({
          lendingSurface: latestLendingSurface,
          stableCurvePosition: positionContext.position || null,
          cirbtcPositionsByKey: lendingCirbtcPositionsByKey,
        });
        latestLendingPolicy = lendingPolicy;
      }
      if (carryAutomationEnabled) {
        latestCarryPolicy = evaluateCarryAutomationPolicy({
          lendingSurface: latestLendingSurface,
          stablePoolState: poolState,
          stableCurvePosition: positionContext.position || null,
          walletBalances: {
            usdc: availableUsdcBalance,
            eurc: availableEurcBalance,
          },
          maxTradeUsdc: Number(agent.max_trade_usdc || 0),
          walletReserveUsdc,
        });
      }
    } catch (err) {
      latestLendingSurface = null;
      latestLendingPolicy = null;
      latestCarryPolicy = null;

      if (lendingAutomationEnabled) {
        activeAutomationKey = 'lendingAutomation';

        if (!stableLoopEnabled && !cirbtcLpEnabled && !carryAutomationEnabled) {
          return finishDefi('fetch_error', {
            ok: false,
            reason: 'lending_surface_unavailable',
            error: err.message,
          });
        }

        await persistAutomationSnapshot('lendingAutomation', 'fetch_error', {
          ok: false,
          reason: 'lending_surface_unavailable',
          error: err.message,
        });
      }

      if (carryAutomationEnabled) {
        if (!cirbtcLpEnabled) {
          activeAutomationKey = 'carryAutomation';
          return finishDefi('fetch_error', {
            ok: false,
            reason: 'lending_surface_unavailable',
            error: err.message,
          });
        }

        if (stableLoopEnabled && !stableStatePersisted) {
          latestStablePolicy = stablePolicy;
          latestExecutionSource = getStableAutomationExecutionSource();
          latestPositionSummary = positionContext.position
            ? {
                poolKey: positionContext.position.poolKey,
                lpBalance: positionContext.position.lpToken?.balance || '0',
                sharePct: positionContext.position.sharePct || 0,
                valueUsd: positionContext.position.valuation?.totalUsd || null,
              }
            : null;
          await persistAutomationSnapshot('defiLoop', 'policy_hold', {
            ok: true,
            action: 'hold',
            reason: 'carry_mode_exclusive',
            summary: 'Stable DeFi Loop is paused because Auto Carry owns the stable LP lane while it is enabled.',
            stablePolicy,
            executionGate,
          });
          stableStatePersisted = true;
        }

        allowCirbtcReviewDespiteStablePriority = true;
        await persistAutomationSnapshot('carryAutomation', 'fetch_error', {
          ok: false,
          reason: 'lending_surface_unavailable',
          error: err.message,
        });
      }
    }
  }

  const summarizePosition = (position) => (position
    ? {
        poolKey: position.poolKey,
        lpBalance: position.lpToken?.balance || '0',
        sharePct: position.sharePct || 0,
        valueUsd: position.valuation?.totalUsd || null,
      }
    : null);

  let automationPolicy = stablePolicy;
  let automationType = 'stable';
  let positionSummary = summarizePosition(positionContext.position);

  if (lendingPolicy?.verdict?.execute === true) {
    if (stableLoopEnabled && !stableStatePersisted) {
      latestStablePolicy = stablePolicy;
      latestExecutionSource = getStableAutomationExecutionSource();
      latestPositionSummary = positionSummary;
      await persistAutomationSnapshot('defiLoop', 'policy_hold', {
        ok: true,
        action: 'hold',
        reason: 'lending_guard_priority',
        summary: 'Stable lane is holding because the lending guard took priority for this cycle.',
        stablePolicy,
        executionGate,
      });
      stableStatePersisted = true;
    }
    if (carryAutomationEnabled) {
      await persistAutomationSnapshot('carryAutomation', 'policy_hold', {
        ok: true,
        action: 'hold',
        reason: 'lending_guard_priority',
        summary: 'Carry lane is holding because the lending guard took priority for this cycle.',
      });
    }

    automationPolicy = lendingPolicy;
    automationType = 'lending';
    activeAutomationKey = 'lendingAutomation';
    latestExecutionSource = getLendingAutomationExecutionSource();
    const forcedLpPoolKey = String(lendingPolicy?.metrics?.forcedLpReduction?.poolKey || '').toUpperCase();
    const forcedLpPosition = forcedLpPoolKey === String(positionContext.position?.poolKey || '').toUpperCase()
      ? positionContext.position
      : lendingCirbtcPositionsByKey[forcedLpPoolKey] || null;
    positionSummary = summarizePosition(forcedLpPosition) || positionSummary;
  } else if (lendingAutomationEnabled && !stableLoopEnabled && !cirbtcLpEnabled) {
    automationPolicy = lendingPolicy || {
      policyId: 'lending_autonomous_guard_v1',
      verdict: {
        execute: false,
        lane: 'lending_automation',
        operationType: null,
        reason: 'Lending automation is waiting for the first lending review.',
        suggestedAmountUsdc: 0,
        actionParams: null,
      },
      metrics: {},
      checks: {},
    };
    automationType = 'lending';
    activeAutomationKey = 'lendingAutomation';
    latestExecutionSource = getLendingAutomationExecutionSource();
  } else if (lendingPolicy) {
    await persistAutomationSnapshot('lendingAutomation', 'policy_hold', {
      ok: true,
      action: 'hold',
      reason: 'lending_policy_hold',
      summary: lendingPolicy.verdict.reason,
    });
  }

  if (carryAutomationEnabled && latestCarryPolicy && automationType !== 'lending') {
    if (stableLoopEnabled && !stableStatePersisted) {
      latestStablePolicy = stablePolicy;
      latestExecutionSource = getStableAutomationExecutionSource();
      latestPositionSummary = positionSummary;
      await persistAutomationSnapshot('defiLoop', 'policy_hold', {
        ok: true,
        action: 'hold',
        reason: 'carry_mode_exclusive',
        summary: 'Stable DeFi Loop is paused because Auto Carry owns the stable LP lane while it is enabled.',
        stablePolicy,
        executionGate,
      });
      stableStatePersisted = true;
    }

    if (latestCarryPolicy.verdict.execute === true) {
      automationPolicy = latestCarryPolicy;
      automationType = 'carry';
      activeAutomationKey = 'carryAutomation';
      latestExecutionSource = getCarryAutomationExecutionSource();
    } else {
      const carryHoldPayload = {
        ok: true,
        action: 'hold',
        reason: 'carry_policy_hold',
        summary: latestCarryPolicy.verdict.reason,
      };

      if (!cirbtcLpEnabled) {
        automationPolicy = latestCarryPolicy;
        automationType = 'carry';
        activeAutomationKey = 'carryAutomation';
        latestExecutionSource = getCarryAutomationExecutionSource();
        latestPositionSummary = positionSummary;
        return finishDefi('policy_hold', carryHoldPayload);
      }

      allowCirbtcReviewDespiteStablePriority = true;
      await persistAutomationSnapshot('carryAutomation', 'policy_hold', carryHoldPayload);
    }
  }

  if (cirbtcLpEnabled && (
    (automationType === 'stable' && automationPolicy.verdict.execute !== true)
    || allowCirbtcReviewDespiteStablePriority
  )) {
    latestExecutionSource = getStableAutomationExecutionSource();

    let cirbtcHoldPayload = null;

    if (stableLoopEnabled && !stableStatePersisted) {
      latestStablePolicy = stablePolicy;
      latestPositionSummary = positionSummary;
    }

    activeAutomationKey = 'cirbtcLp';
    await _setAutomationState(agentId, 'cirbtcLp', 'running');

    let cirbtcPositionContext;
    try {
      cirbtcPositionContext = await readCirbtcDirectPairPositionContext(agent.wallet_address);
    } catch (err) {
      console.error(`[QUEUE] DEFI_LOOP cirBTC position guard error agent=${agentId}:`, err.message);
      return finishDefi('position_guard_unavailable', {
        ok: false,
        reason: 'cirbtc_position_guard_unavailable',
        error: err.message,
        stablePolicy,
      });
    }

    let cirbtcPoolContexts;
    try {
      cirbtcPoolContexts = await loadCirbtcDirectPairPoolContexts();
    } catch (err) {
      console.error(`[QUEUE] DEFI_LOOP cirBTC pool-state error agent=${agentId}:`, err.message);
      return finishDefi('fetch_error', {
        ok: false,
        reason: 'cirbtc_pool_state_unavailable',
        error: err.message,
        stablePolicy,
      });
    }

    let cirbtcGrowthHistoryByToken;
    try {
      const [usdcGrowthHistory, eurcGrowthHistory] = await Promise.all([
        readCirbtcGrowthAddHistory(agentId, 'USDC'),
        readCirbtcGrowthAddHistory(agentId, 'EURC'),
      ]);
      cirbtcGrowthHistoryByToken = {
        USDC: usdcGrowthHistory,
        EURC: eurcGrowthHistory,
      };
    } catch (err) {
      console.error(`[QUEUE] DEFI_LOOP cirBTC growth-history error agent=${agentId}:`, err.message);
      cirbtcGrowthHistoryByToken = {
        USDC: {
          totalAddsToday: 0,
          lastAddAt: null,
        },
        EURC: {
          totalAddsToday: 0,
          lastAddAt: null,
        },
      };
    }

    let cirbtcPolicy = evaluateCirbtcLpAutomationPolicy({
      pairContexts: cirbtcPoolContexts.map((context) => {
        const poolKey = String(context.pool?.key || `${context.stableToken}-CIRBTC`).toUpperCase();
        return {
          stableToken: context.stableToken,
          pool: context.pool,
          poolState: context.poolState,
          walletStableBalance: context.stableToken === 'EURC'
            ? cirbtcIdleCapitalBudgets.eurc
            : cirbtcIdleCapitalBudgets.usdc,
          position: cirbtcPositionContext.positionsByKey?.[poolKey] || null,
          growthHistory: cirbtcGrowthHistoryByToken?.[context.stableToken] || {
            totalAddsToday: 0,
            lastAddAt: null,
          },
          warning: cirbtcPositionContext.warningsByKey?.[poolKey] || null,
          error: context.error,
        };
      }),
    });

    if (cirbtcPolicy?.verdict?.execute === true && cirbtcPolicy?.verdict?.operationType === 'add_liquidity') {
      const cirbtcGlobalFailureGuard = await readCirbtcGlobalFailureGuardState();
      if (cirbtcGlobalFailureGuard.active) {
        const holdSummary = cirbtcGlobalFailureGuard.summary
          || 'cirBTC LP add-liquidity is temporarily paused due to recent shared route failures across agents.';
        cirbtcPolicy = {
          ...cirbtcPolicy,
          verdict: {
            ...(cirbtcPolicy.verdict || {}),
            execute: false,
            blockedBy: 'global_route_cooldown',
            reason: holdSummary,
            actionParams: null,
            suggestedAmountUsdc: 0,
          },
          metrics: {
            ...(cirbtcPolicy.metrics || {}),
            globalFailureGuard: {
              ...cirbtcGlobalFailureGuard,
            },
          },
          checks: {
            ...(cirbtcPolicy.checks || {}),
            globalRouteCooldown: {
              passed: false,
              detail: holdSummary,
            },
          },
        };
      }
    }

    const cirbtcPositionSummary = summarizePosition(
      cirbtcPositionContext.positionsByKey?.[String(cirbtcPolicy.metrics?.selectedPoolKey || '').toUpperCase()] || null,
    ) || positionSummary;

    if (cirbtcPolicy.verdict.execute === true) {
      if (stableLoopEnabled && !stableStatePersisted) {
        latestStablePolicy = stablePolicy;
        latestExecutionSource = getStableAutomationExecutionSource();
        latestPositionSummary = positionSummary;
        await persistAutomationSnapshot('defiLoop', 'policy_hold', {
          ok: true,
          action: 'hold',
          reason: 'stable_policy_hold',
          stablePolicy,
          executionGate,
        });
        stableStatePersisted = true;
      }

      automationPolicy = cirbtcPolicy;
      automationType = 'cirbtc';
      latestStablePolicy = cirbtcPolicy;
      latestExecutionSource = getCirbtcAutomationExecutionSource();
      positionSummary = cirbtcPositionSummary;
    } else {
      latestStablePolicy = cirbtcPolicy;
      latestExecutionSource = getCirbtcAutomationExecutionSource();
      latestPositionSummary = cirbtcPositionSummary;
      cirbtcHoldPayload = {
        ok: true,
        action: 'hold',
        reason: 'cirbtc_policy_hold',
        stablePolicy: cirbtcPolicy,
        executionGate,
        fallbackPolicy: stablePolicy,
      };
      await persistAutomationSnapshot('cirbtcLp', 'policy_hold', cirbtcHoldPayload);

      latestStablePolicy = stablePolicy;
      latestExecutionSource = getStableAutomationExecutionSource();
      latestPositionSummary = positionSummary;
      activeAutomationKey = 'defiLoop';
    }

    const [oracleExitQuote, latestOracleInventoryExit] = automationType === 'stable' && stableLoopEnabled
      ? await Promise.all([
          _buildOracleInventoryExitPlan({
            agent,
            availableEurcBalance,
            walletReserveUsdc: 0,
            forexRate,
          }),
          _readLatestConfirmedOracleInventoryExit(agentId),
        ])
      : [null, null];
    const oracleEntryCooldown = latestOracleInventoryExit
      ? _buildOracleEntryCooldown(latestOracleInventoryExit)
      : null;

    const oracleStrategyPolicy = automationType === 'stable' && stableLoopEnabled
      ? evaluateOracleStrategyPolicy({
          agent,
          forexRate,
          poolState,
          signal,
          executionGate,
          pricingPool,
          swapPool,
          requestedAmountUsdc: requestedPolicyAmountUsdc,
          walletBalances: {
            usdc: availableToTradeUsdc,
            eurc: availableEurcBalance,
          },
          walletReserveUsdc: 0,
          exitQuote: oracleExitQuote,
          entryCooldown: oracleEntryCooldown,
        })
      : null;

    if (oracleStrategyPolicy?.verdict?.execute === true) {
      if (stableLoopEnabled && !stableStatePersisted) {
        latestStablePolicy = stablePolicy;
        latestExecutionSource = getStableAutomationExecutionSource();
        latestPositionSummary = positionSummary;
        await persistAutomationSnapshot('defiLoop', 'policy_hold', {
          ok: true,
          action: 'hold',
          reason: 'stable_policy_hold',
          stablePolicy,
          executionGate,
        });
        stableStatePersisted = true;
      }

      automationPolicy = oracleStrategyPolicy;
      automationType = 'oracle';
      latestStablePolicy = oracleStrategyPolicy;
      activeAutomationKey = 'oracle';
      latestExecutionSource = getOracleStrategyExecutionSource();
      await _setAutomationState(agentId, 'oracle', 'running');
    }

    if (automationType === 'stable' && cirbtcHoldPayload && (!stableLoopEnabled || stablePolicy.metrics?.positionPresent !== true)) {
      return cirbtcHoldPayload;
    }
  }

  if (automationPolicy.verdict.execute !== true) {
    latestPositionSummary = positionSummary;
    const holdReason = automationType === 'lending'
      ? 'lending_policy_hold'
      : automationType === 'cirbtc'
        ? 'cirbtc_policy_hold'
        : 'stable_policy_hold';
    return finishDefi('policy_hold', {
      ok: true,
      action: 'hold',
      reason: holdReason,
      stablePolicy: automationType === 'lending' ? undefined : automationPolicy,
      lendingPolicy: automationType === 'lending' ? automationPolicy : undefined,
      executionGate,
    });
  }

  const operationType = automationPolicy.verdict.operationType || 'swap';
  const actionParams = { ...(automationPolicy.verdict.actionParams || {}) };
  const transactionType = automationType === 'lending'
    ? getLendingAutomationTransactionType(operationType, actionParams)
    : automationType === 'carry'
    ? getCarryAutomationTransactionType(operationType, actionParams)
    : automationType === 'cirbtc'
    ? getCirbtcAutomationTransactionType(operationType)
    : automationType === 'oracle'
      ? getOracleStrategyTransactionType(operationType)
      : getStableAutomationTransactionType(operationType);
  const transactionToken = automationType === 'lending'
    ? getLendingAutomationTransactionToken(actionParams, automationPolicy)
    : automationType === 'carry'
    ? getCarryAutomationTransactionToken(actionParams, automationPolicy)
    : automationType === 'cirbtc'
    ? getCirbtcAutomationTransactionToken(actionParams, automationPolicy)
    : automationType === 'oracle'
      ? getOracleStrategyTransactionToken(operationType)
      : getStableAutomationTransactionToken(operationType);
  const executionSource = automationType === 'lending'
    ? getLendingAutomationExecutionSource()
    : automationType === 'carry'
    ? getCarryAutomationExecutionSource()
    : automationType === 'cirbtc'
    ? getCirbtcAutomationExecutionSource()
    : automationType === 'oracle'
      ? getOracleStrategyExecutionSource()
      : getStableAutomationExecutionSource();
  const nominalActionAmountUsdc = automationType === 'lending'
    ? getLendingAutomationNotionalAmount(automationPolicy)
    : automationType === 'carry'
    ? getCarryAutomationNotionalAmount(automationPolicy)
    : automationType === 'cirbtc'
    ? getCirbtcAutomationNotionalAmount(automationPolicy)
    : automationType === 'oracle'
      ? getOracleStrategyNotionalAmount(automationPolicy)
      : getStableAutomationNotionalAmount(automationPolicy);
  latestPositionSummary = positionSummary;
  latestExecutionSource = executionSource;
  const defaultFromToken = automationType === 'lending'
    ? (actionParams.tokenOut || actionParams.stableToken || automationPolicy?.verdict?.actionAssetSymbol || 'USDC')
    : automationType === 'carry'
    ? (actionParams.asset || actionParams.stableToken || automationPolicy?.verdict?.actionAssetSymbol || 'USDC')
    : actionParams.fromToken || actionParams.stableToken || 'USDC';
  const defaultToToken = automationType === 'lending'
    ? (operationType === 'forced_lp_reduce'
      ? 'wallet'
      : operationType === 'collateral_top_up'
        ? 'lending collateral'
        : operationType === 'utilization_repay' || operationType === 'deleverage'
          ? 'lending debt'
          : 'lending account')
    : automationType === 'carry'
    ? (operationType === 'close_carry' || operationType === 'repay_wallet_balance'
      ? 'lending debt'
      : 'Curve LP')
    : automationType === 'cirbtc'
    ? (operationType === 'remove_liquidity' ? 'both pair tokens' : 'direct LP')
    : operationType === 'remove_liquidity'
      ? actionParams.tokenOut || 'both pool tokens'
      : actionParams.toToken || (operationType === 'add_liquidity' ? 'Curve LP' : 'EURC');
  const selectedStableToken = String(actionParams.stableToken || 'USDC').toUpperCase();

  let requestedExecutionAmount = normalizeUsdcAmount(actionParams.amountIn);
  let executionAmount = requestedExecutionAmount;
  const automationLabel = automationType === 'cirbtc'
    ? 'cirBTC LP automation'
    : automationType === 'oracle'
      ? 'Oracle strategy'
      : automationType === 'carry'
        ? 'Auto Carry'
      : automationType === 'lending'
        ? 'Lending automation'
        : 'Stable automation';

  if (automationType === 'cirbtc' && operationType === 'add_liquidity') {
    if (!balancesAvailable) {
      return finishDefi('balance_check_failed', {
        ok: false,
        reason: 'wallet_balance_unavailable',
        stablePolicy: automationPolicy,
      });
    }
    const automationBudgetStableBalance = normalizeUsdcAmount(automationPolicy?.metrics?.walletStableBalance);
    const availableStableBalance = selectedStableToken === 'EURC'
      ? normalizeUsdcAmount(Math.min(availableEurcBalance, automationBudgetStableBalance || availableEurcBalance))
      : normalizeUsdcAmount(Math.min(availableToTradeUsdc, automationBudgetStableBalance || availableToTradeUsdc));
    executionAmount = normalizeUsdcAmount(Math.min(requestedExecutionAmount, availableStableBalance));
    actionParams.amountIn = String(executionAmount);
  } else if (
    automationType === 'stable'
    && operationType === 'add_liquidity'
    && String(actionParams?.mode || '').toLowerCase() === 'balanced'
  ) {
    if (!balancesAvailable) {
      return finishDefi('balance_check_failed', {
        ok: false,
        reason: 'wallet_balance_unavailable',
        stablePolicy: automationPolicy,
      });
    }

    const requestedUsdcSide = normalizeUsdcAmount(actionParams.amountUsdc ?? actionParams.amount0);
    const requestedEurcSide = normalizeUsdcAmount(actionParams.amountEurc ?? actionParams.amount1);
    const executionAmountUsdc = normalizeUsdcAmount(Math.min(requestedUsdcSide, availableToTradeUsdc));
    const executionAmountEurc = normalizeUsdcAmount(Math.min(requestedEurcSide, availableEurcBalance));

    requestedExecutionAmount = normalizeUsdcAmount(requestedUsdcSide + requestedEurcSide);
    executionAmount = normalizeUsdcAmount(executionAmountUsdc + executionAmountEurc);
    actionParams.amountUsdc = String(executionAmountUsdc);
    actionParams.amountEurc = String(executionAmountEurc);
    actionParams.amount0 = String(executionAmountUsdc);
    actionParams.amount1 = String(executionAmountEurc);
    actionParams.amountIn = String(executionAmount);
  } else if (operationType === 'swap' || operationType === 'add_liquidity') {
    if (!balancesAvailable) {
      return finishDefi('balance_check_failed', {
        ok: false,
        reason: 'wallet_balance_unavailable',
        stablePolicy: automationPolicy,
      });
    }
    executionAmount = normalizeUsdcAmount(Math.min(requestedExecutionAmount, availableToTradeUsdc));
    actionParams.amountIn = String(executionAmount);
  } else if (operationType === 'rebalance') {
    if (!balancesAvailable) {
      return finishDefi('balance_check_failed', {
        ok: false,
        reason: 'wallet_balance_unavailable',
        stablePolicy: automationPolicy,
      });
    }
    executionAmount = normalizeUsdcAmount(Math.min(requestedExecutionAmount, availableEurcBalance));
    actionParams.amountIn = String(executionAmount);
  } else {
    requestedExecutionAmount = nominalActionAmountUsdc;
    executionAmount = nominalActionAmountUsdc;
  }

  if (['swap', 'add_liquidity', 'rebalance'].includes(operationType) && executionAmount < 0.01) {
    const skippedType = operationType === 'swap' ? 'defi_loop_dry' : transactionType;
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'skipped', $5::jsonb)`,
      [agentId, skippedType, transactionToken, requestedExecutionAmount, JSON.stringify({
        signal,
        executionGate,
        automationPolicy,
        stablePolicy: automationType === 'stable' ? automationPolicy : undefined,
        policyId: automationPolicy?.policyId || null,
        policyLane: automationPolicy?.verdict?.lane || null,
        dryRun: false,
        executionState: 'insufficient_balance',
        executionSource,
        operationType,
        fromToken: defaultFromToken,
        toToken: defaultToToken,
        requestedAmountIn: requestedExecutionAmount,
        amountIn: 0,
        availableBalanceUsdc: availableUsdcBalance,
        availableBalanceEurc: availableEurcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
        positionBefore: positionSummary,
        summary: `${automationLabel} selected ${operationType.replace(/_/g, ' ')}, but the wallet did not have enough immediately available balance to execute it.`,
      })],
    );

    return finishDefi('insufficient_balance', {
      ok: true,
      action: 'hold',
      reason: 'insufficient_balance',
      operationType,
      requestedAmountUsdc: requestedExecutionAmount,
      availableBalanceUsdc: availableUsdcBalance,
      availableBalanceEurc: availableEurcBalance,
      walletReserveUsdc,
      availableToTradeUsdc,
    });
  }

  if (dryRunEnabled) {
    let dryRunPayload = {};
    if (automationType === 'lending') {
      const dryRunResult = await executeLendingAutomationTask({
        agent,
        automationPolicy,
        dryRunEnabled: true,
      });
      if (!dryRunResult.ok) {
        return finishDefi('dry_run_failed', {
          ok: false,
          reason: dryRunResult.reason,
          error: dryRunResult.error,
          operationType,
          stablePolicy: automationPolicy,
        });
      }
      dryRunPayload = dryRunResult.payload || {};
    } else if (automationType === 'carry') {
      const dryRunResult = await executeCarryAutomationTask({
        agent,
        automationPolicy,
        dryRunEnabled: true,
        taskRunId: shouldTrackAutoCarryTaskRun ? carryTaskRunId : null,
        sourceTaskId: shouldTrackAutoCarryTaskRun ? carrySourceTaskId : null,
      });
      if (!dryRunResult.ok) {
        return finishDefi('dry_run_failed', {
          ok: false,
          reason: dryRunResult.reason,
          error: dryRunResult.error,
          operationType,
          stablePolicy: automationPolicy,
        });
      }
      dryRunPayload = dryRunResult.payload || {};
    } else if (automationType === 'cirbtc') {
      const dryRunResult = await executeCirbtcLpAutomationTask({
        agent,
        operationType,
        actionParams,
        dryRunEnabled: true,
      });
      if (!dryRunResult.ok) {
        return finishDefi('dry_run_failed', {
          ok: false,
          reason: dryRunResult.reason,
          error: dryRunResult.error,
          operationType,
          stablePolicy: automationPolicy,
        });
      }
      dryRunPayload = dryRunResult.payload || {};
    } else if (operationType !== 'swap') {
      const dryRunResult = await executeStableAutomationTask({
        agent,
        operationType,
        actionParams,
        dryRunEnabled: true,
      });
      if (!dryRunResult.ok) {
        return finishDefi('dry_run_failed', {
          ok: false,
          reason: dryRunResult.reason,
          error: dryRunResult.error,
          operationType,
          stablePolicy: automationPolicy,
        });
      }
      dryRunPayload = dryRunResult.payload || {};
    }

    const dryRunType = operationType === 'swap' ? 'defi_loop_dry' : transactionType;
    console.log(`[QUEUE] DEFI_LOOP DRY_RUN agent=${agentId} — ${operationType} ${executionAmount}`);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
       VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'dry_run', $5::jsonb)`,
      [agentId, dryRunType, transactionToken, nominalActionAmountUsdc || executionAmount, JSON.stringify({
        signal,
        executionGate,
        automationPolicy,
        stablePolicy: automationType === 'stable' ? automationPolicy : undefined,
        policyId: automationPolicy?.policyId || null,
        policyLane: automationPolicy?.verdict?.lane || null,
        ...dryRunPayload,
        dryRun: true,
        executionState: 'dry_run',
        executionSource,
        operationType,
        fromToken: defaultFromToken,
        toToken: defaultToToken,
        amountIn: actionParams.amountIn || executionAmount,
        requestedAmountIn: requestedExecutionAmount,
        availableBalanceUsdc: availableUsdcBalance,
        availableBalanceEurc: availableEurcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
        positionBefore: positionSummary,
        summary: dryRunPayload.summary || automationPolicy.verdict.reason,
      })],
    );
    return finishDefi('dry_run', {
      ok: true,
      action: 'dry_run',
      operationType,
      amountUsdc: nominalActionAmountUsdc || executionAmount,
    });
  }

  // Real execution — requires decrypted private key
  if (!agent.private_key_encrypted) {
    return finishDefi('no_private_key', { ok: false, reason: 'no_private_key' });
  }

  let txResult;
  let executionPayload = {};
  try {
    const { decrypt } = require('../services/cryptoService');
    const privateKey  = decrypt(agent.private_key_encrypted);
    if (automationType !== 'cirbtc' && operationType === 'swap') {
      const poolAddress = swapPool?.address || CURVE_USDC_EURC_POOL;
      const sameChainSellBackPlan = automationType === 'oracle'
        ? await _buildOracleSameChainSellBackPlan({
            amountInUsdc: executionAmount,
            swapPool,
          })
        : null;

      if (automationType === 'oracle' && sameChainSellBackPlan?.profitable !== true) {
        const guardReason = sameChainSellBackPlan?.expectedUsdcOut > 0
          ? `Oracle strategy held the EURC entry because buying ${sameChainSellBackPlan.inputUsdc} USDC on Curve would only quote ${sameChainSellBackPlan.expectedUsdcOut} USDC on the live same-chain exit, below the required ${sameChainSellBackPlan.minimumExpectedUsdcOut} USDC floor.`
          : 'Oracle strategy held the EURC entry because the live same-chain EURC -> USDC exit quote was unavailable or not profitable enough to protect the buy leg.';

        latestStablePolicy = {
          ...automationPolicy,
          verdict: {
            ...(automationPolicy?.verdict || {}),
            execute: false,
            blockedBy: 'same_chain_exit_unprofitable',
            reason: guardReason,
          },
          metrics: {
            ...(automationPolicy?.metrics || {}),
            sameChainSellBackQuote: sameChainSellBackPlan || null,
          },
        };

        return finishDefi('policy_hold', {
          ok: true,
          action: 'hold',
          reason: 'same_chain_exit_unprofitable',
          summary: guardReason,
          operationType,
          sameChainSellBackQuote: sameChainSellBackPlan || null,
        });
      }

      if (!poolAddress) {
        return finishDefi('pool_unconfigured', { ok: false, reason: 'pool_address_not_configured' });
      }

      txResult = await protocols.executeCurveSwap({
        poolAddress,
        tokenInAddress: swapPool?.baseToken?.address || process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
        indexIn: swapPool?.baseToken.index ?? 0,
        indexOut: swapPool?.quoteToken.index ?? 1,
        amountIn: String(executionAmount),
        slippagePct: parseFloat(agent.slippage_percent) || 0.5,
        agentPrivateKey: privateKey,
        decimalsIn: swapPool?.baseToken?.decimals || 6,
        decimalsOut: swapPool?.quoteToken?.decimals || 6,
      });

      executionPayload = {
        txHash: txResult.txHash,
        amountOut: txResult.amountOut,
        amountIn: String(executionAmount),
        requestedAmountIn: requestedExecutionAmount,
        entryTxHash: txResult.txHash,
        entryAmountOutEurc: txResult.amountOut,
        sameChainSellBackPlanned: sameChainSellBackPlan?.profitable === true,
        sameChainSellBackQuote: sameChainSellBackPlan || null,
        summary: automationPolicy.verdict.reason,
      };

      if (sameChainSellBackPlan?.profitable) {
        try {
          const sellBackResult = await agentWalletService.agentSwap({
            agent,
            fromToken: 'EURC',
            toToken: 'USDC',
            amountIn: Number(txResult.amountOut),
            slippagePct: parseFloat(agent.slippage_percent) || 0.5,
          });

          txResult = {
            txHash: sellBackResult.hash || txResult.txHash,
            amountOut: sellBackResult.amountOut,
          };

          executionPayload = {
            ...executionPayload,
            txHash: txResult.txHash,
            amountOut: executionPayload.entryAmountOutEurc,
            finalAmountOutUsdc: sellBackResult.amountOut,
            sellBackTxHash: sellBackResult.hash || null,
            sellBackExecutionRail: sellBackResult.executionRail || null,
            sellBackRouteStrategy: sellBackResult.routeStrategy || null,
            sellBackRouteReason: sellBackResult.routeReason || null,
            roundTripCompleted: true,
            summary: `Bought ${executionPayload.entryAmountOutEurc} EURC on Curve for ${executionAmount} USDC, then sold it back on the live Arc route for ${sellBackResult.amountOut} USDC.`,
          };
        } catch (sellBackError) {
          executionPayload = {
            ...executionPayload,
            roundTripCompleted: false,
            sellBackError: sellBackError.userMessage || sellBackError.message,
            summary: `Bought ${executionPayload.entryAmountOutEurc} EURC on Curve for ${executionAmount} USDC, but the immediate sell-back route was not available. The agent kept the EURC for a later rebalance.`,
          };
        }
      }
    } else if (automationType === 'lending') {
      const executionResult = await executeLendingAutomationTask({
        agent,
        automationPolicy,
        dryRunEnabled: false,
      });
      if (!executionResult.ok) {
        await db.query(
          `INSERT INTO transactions
             (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
           VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'failed', $5::jsonb)`,
          [agentId, transactionType, transactionToken, nominalActionAmountUsdc || executionAmount, JSON.stringify({
            signal,
            executionGate,
            automationPolicy,
            stablePolicy: automationType === 'stable' ? automationPolicy : undefined,
            policyId: automationPolicy?.policyId || null,
            policyLane: automationPolicy?.verdict?.lane || null,
            executionState: 'failed',
            executionSource,
            operationType,
            fromToken: defaultFromToken,
            toToken: defaultToToken,
            amountIn: actionParams.amountIn || executionAmount,
            requestedAmountIn: requestedExecutionAmount,
            withdrawPct: actionParams.withdrawPct || null,
            availableBalanceUsdc: availableUsdcBalance,
            availableBalanceEurc: availableEurcBalance,
            walletReserveUsdc,
            availableToTradeUsdc,
            positionBefore: positionSummary,
            summary: `Lending automation could not execute ${operationType.replace(/_/g, ' ')}: ${executionResult.error || executionResult.reason}`,
            reason: executionResult.reason,
            error: executionResult.error || null,
          })],
        );

        return finishDefi('execution_blocked', {
          ok: false,
          reason: executionResult.reason,
          error: executionResult.error,
          operationType,
        });
      }

      executionPayload = executionResult.payload || {};
      txResult = {
        txHash: executionPayload.txHash || executionPayload.hash || executionPayload.stepsExecuted?.[0]?.txHash || null,
        amountOut: executionPayload.amountOut || null,
      };
    } else if (automationType === 'carry') {
      const executionResult = await executeCarryAutomationTask({
        agent,
        automationPolicy,
        dryRunEnabled: false,
        taskRunId: shouldTrackAutoCarryTaskRun ? carryTaskRunId : null,
        sourceTaskId: shouldTrackAutoCarryTaskRun ? carrySourceTaskId : null,
      });
      if (!executionResult.ok) {
        await db.query(
          `INSERT INTO transactions
             (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
           VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'failed', $5::jsonb)`,
          [agentId, transactionType, transactionToken, nominalActionAmountUsdc || executionAmount, JSON.stringify({
            signal,
            executionGate,
            automationPolicy,
            policyId: automationPolicy?.policyId || null,
            policyLane: automationPolicy?.verdict?.lane || null,
            executionState: 'failed',
            executionSource,
            operationType,
            fromToken: defaultFromToken,
            toToken: defaultToToken,
            amountIn: actionParams.amountIn || executionAmount,
            requestedAmountIn: requestedExecutionAmount,
            availableBalanceUsdc: availableUsdcBalance,
            availableBalanceEurc: availableEurcBalance,
            walletReserveUsdc,
            availableToTradeUsdc,
            positionBefore: positionSummary,
            summary: `Auto Carry could not execute ${operationType.replace(/_/g, ' ')}: ${executionResult.error || executionResult.reason}`,
            reason: executionResult.reason,
            error: executionResult.error || null,
          })],
        );

        return finishDefi('execution_blocked', {
          ok: false,
          reason: executionResult.reason,
          error: executionResult.error,
          operationType,
        });
      }

      executionPayload = executionResult.payload || {};
      txResult = {
        txHash: executionPayload.txHash
          || executionPayload.hash
          || executionPayload.repayTxHash
          || executionPayload.addLiquidityTxHash
          || executionPayload.removeLiquidityTxHash
          || executionPayload.borrowTxHash
          || executionPayload.stepsExecuted?.[0]?.txHash
          || null,
        amountOut: executionPayload.amountOut || null,
      };

      try {
        const [refreshedLendingSurface, refreshedPositionContext] = await Promise.all([
          nativeLendingRiskService.buildLendingSurfaceForWallet(agent.wallet_address),
          readStableCurvePositionContext(agent.wallet_address),
        ]);
        const refreshedUsdcWalletBalance = Number(
          refreshedLendingSurface?.assets?.find((assetEntry) => assetEntry.symbol === 'USDC')?.wallet?.amount || 0,
        );
        const refreshedEurcWalletBalance = Number(
          refreshedLendingSurface?.assets?.find((assetEntry) => assetEntry.symbol === 'EURC')?.wallet?.amount || 0,
        );
        const refreshedStablePosition = refreshedPositionContext?.ok === true
          ? refreshedPositionContext.position || null
          : positionContext.position || null;

        latestLendingSurface = refreshedLendingSurface;
        latestCarryPolicy = evaluateCarryAutomationPolicy({
          lendingSurface: refreshedLendingSurface,
          stablePoolState: poolState,
          stableCurvePosition: refreshedStablePosition,
          walletBalances: {
            usdc: refreshedUsdcWalletBalance,
            eurc: refreshedEurcWalletBalance,
          },
          maxTradeUsdc: Number(agent.max_trade_usdc || 0),
          walletReserveUsdc,
        });
        positionContext = refreshedPositionContext?.ok === true
          ? refreshedPositionContext
          : positionContext;
        positionSummary = summarizePosition(refreshedStablePosition) || positionSummary;
        latestPositionSummary = positionSummary;
      } catch (refreshError) {
        console.warn(`[QUEUE] DEFI_LOOP carry post-execution refresh failed agent=${agentId}:`, refreshError.message);
      }
    } else if (automationType === 'cirbtc') {
      const executionResult = await executeCirbtcLpAutomationTask({
        agent,
        operationType,
        actionParams,
        dryRunEnabled: false,
      });
      if (!executionResult.ok) {
        await db.query(
          `INSERT INTO transactions
             (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
           VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'failed', $5::jsonb)`,
          [agentId, transactionType, transactionToken, nominalActionAmountUsdc || executionAmount, JSON.stringify({
            signal,
            executionGate,
            automationPolicy,
            stablePolicy: automationType === 'stable' ? automationPolicy : undefined,
            policyId: automationPolicy?.policyId || null,
            policyLane: automationPolicy?.verdict?.lane || null,
            executionState: 'failed',
            executionSource,
            operationType,
            fromToken: defaultFromToken,
            toToken: defaultToToken,
            amountIn: actionParams.amountIn || executionAmount,
            requestedAmountIn: requestedExecutionAmount,
            withdrawPct: actionParams.withdrawPct || null,
            availableBalanceUsdc: availableUsdcBalance,
            availableBalanceEurc: availableEurcBalance,
            walletReserveUsdc,
            availableToTradeUsdc,
            positionBefore: positionSummary,
            summary: `cirBTC LP automation could not execute ${operationType.replace(/_/g, ' ')}: ${executionResult.error || executionResult.reason}`,
            reason: executionResult.reason,
            error: executionResult.error || null,
          })],
        );

        return finishDefi('execution_blocked', {
          ok: false,
          reason: executionResult.reason,
          error: executionResult.error,
          operationType,
        });
      }

      executionPayload = executionResult.payload || {};
      txResult = {
        txHash: executionPayload.txHash || executionPayload.hash || executionPayload.mintTxHash || executionPayload.burnTxHash || null,
        amountOut: executionPayload.amountOut || null,
      };
    } else {
      const executionResult = await executeStableAutomationTask({
        agent,
        operationType,
        actionParams,
        dryRunEnabled: false,
      });
      if (!executionResult.ok) {
        await db.query(
          `INSERT INTO transactions
             (agent_id, type, from_chain, to_chain, token, amount_usdc, status, meta)
           VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'failed', $5::jsonb)`,
          [agentId, transactionType, transactionToken, nominalActionAmountUsdc || executionAmount, JSON.stringify({
            signal,
            executionGate,
            automationPolicy,
            stablePolicy: automationType === 'stable' ? automationPolicy : undefined,
            policyId: automationPolicy?.policyId || null,
            policyLane: automationPolicy?.verdict?.lane || null,
            executionState: 'failed',
            executionSource,
            operationType,
            fromToken: defaultFromToken,
            toToken: defaultToToken,
            amountIn: actionParams.amountIn || executionAmount,
            requestedAmountIn: requestedExecutionAmount,
            availableBalanceUsdc: availableUsdcBalance,
            availableBalanceEurc: availableEurcBalance,
            walletReserveUsdc,
            availableToTradeUsdc,
            positionBefore: positionSummary,
            summary: `${automationType === 'cirbtc' ? 'cirBTC LP automation' : 'Stable automation'} could not execute ${operationType.replace(/_/g, ' ')}: ${executionResult.error || executionResult.reason}`,
            reason: executionResult.reason,
            error: executionResult.error || null,
          })],
        );

        return finishDefi('execution_blocked', {
          ok: false,
          reason: executionResult.reason,
          error: executionResult.error,
          operationType,
        });
      }

      executionPayload = executionResult.payload || {};
      txResult = {
        txHash: executionPayload.txHash || executionPayload.hash || null,
        amountOut: executionPayload.amountOut || null,
      };
    }

    let economy = null;
    try {
      economy = await taskEconomyService.settleExecutionFee({
        agent,
        referenceId: txResult.txHash || `defi-loop-${agentId}-${Date.now()}`,
        referenceType: 'automation',
        feeUsdc: AUTOMATION_EXECUTION_FEE_USDC,
        fromChain: 'Arc Testnet',
        toChain: 'Arc Testnet',
        mode: 'circle_gateway_automation_fee',
        rail: 'agentic_automation_economy',
      });
    } catch (err) {
      economy = {
        mode: 'circle_gateway_automation_fee',
        rail: 'agentic_automation_economy',
        referenceType: 'automation',
        referenceId: txResult.txHash || null,
        feeUsdc: AUTOMATION_EXECUTION_FEE_USDC,
        sourceChain: 'Arc Testnet',
        destinationChain: 'Arc Testnet',
        status: 'failed',
        error: err.message,
      };
      console.warn('[AUTOMATION_ECONOMY] DEFI_LOOP fee settlement failed:', err.message);
    }

    // Increment auto-tx counter
    await db.query(
      'UPDATE agents SET daily_auto_tx_count = daily_auto_tx_count + 1 WHERE id = $1',
      [agentId],
    );

    // Log transaction
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, tx_hash, meta)
       VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'confirmed', $5, $6::jsonb)`,
      [agentId, transactionType, transactionToken, nominalActionAmountUsdc || executionAmount, txResult.txHash, JSON.stringify({
        signal,
        executionGate,
        automationPolicy,
        stablePolicy: automationType === 'stable' ? automationPolicy : undefined,
        policyId: automationPolicy?.policyId || null,
        policyLane: automationPolicy?.verdict?.lane || null,
        ...executionPayload,
        executionState: 'executed',
        executionSource,
        operationType,
        fromToken: defaultFromToken,
        toToken: defaultToToken,
        tokenOut: operationType === 'remove_liquidity' ? defaultToToken : undefined,
        amountIn: actionParams.amountIn || executionAmount,
        requestedAmountIn: requestedExecutionAmount,
        withdrawPct: actionParams.withdrawPct || null,
        availableBalanceUsdc: availableUsdcBalance,
        availableBalanceEurc: availableEurcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
        positionBefore: positionSummary,
        economy,
      })],
    );

    console.log(`[QUEUE] DEFI_LOOP ${operationType} OK agent=${agentId} tx=${txResult.txHash}`);
    recordReputationEvent(agentId, EVENT_TYPES.DEFI_LOOP).catch(() => {});
    return finishDefi('executed', {
      ok: true,
      action: operationType,
      ...executionPayload,
      txHash: txResult.txHash,
      amountOut: txResult.amountOut,
      summary: executionPayload.summary || automationPolicy?.verdict?.reason || null,
      entryTxHash: executionPayload.entryTxHash || null,
      sellBackTxHash: executionPayload.sellBackTxHash || null,
      finalAmountOutUsdc: executionPayload.finalAmountOutUsdc || null,
      sellBackError: executionPayload.sellBackError || null,
      economy,
    });

  } catch (err) {
    const errorDetails = buildExecutionErrorDetails(err);
    console.error(`[QUEUE] DEFI_LOOP ${operationType} error agent=${agentId}:`, errorDetails.error);
    await db.query(
      `INSERT INTO transactions
         (agent_id, type, from_chain, to_chain, token, amount_usdc, status, tx_hash, meta)
       VALUES ($1, $2, 'arc-testnet', 'arc-testnet', $3, $4, 'failed', $5, $6::jsonb)`,
      [agentId, transactionType, transactionToken, nominalActionAmountUsdc || executionAmount, errorDetails.errorTxHash, JSON.stringify({
        ...errorDetails,
        signal,
        executionGate,
        automationPolicy,
        stablePolicy: automationType === 'stable' ? automationPolicy : undefined,
        policyId: automationPolicy?.policyId || null,
        policyLane: automationPolicy?.verdict?.lane || null,
        executionState: 'failed',
        executionSource,
        operationType,
        fromToken: defaultFromToken,
        toToken: defaultToToken,
        amountIn: actionParams.amountIn || executionAmount,
        requestedAmountIn: requestedExecutionAmount,
        withdrawPct: actionParams.withdrawPct || null,
        availableBalanceUsdc: availableUsdcBalance,
        availableBalanceEurc: availableEurcBalance,
        walletReserveUsdc,
        availableToTradeUsdc,
        positionBefore: positionSummary,
      })],
    );
    return finishDefi('execution_error', {
      ok: false,
      reason: 'execution_error',
      error: errorDetails.error,
      errorSummary: errorDetails.errorSummary,
    });
  }
});

// ── Schedule DeFi loop for all eligible agents ────────────────────────────────
async function scheduleDefiLoop() {
  if (!DEFI_LOOP_INTERVAL_MS || DEFI_LOOP_INTERVAL_MS < 60_000) return;

  const getQueuedOrActiveDefiLoopAgentIds = async () => {
    const jobs = await queue.getJobs(['waiting', 'active', 'delayed'], 0, 500, true);
    return new Set(
      jobs
        .filter((job) => job?.name === 'DEFI_LOOP' && job?.data?.agentId)
        .map((job) => String(job.data.agentId)),
    );
  };

  const queueEligibleDefiLoops = async () => {
    try {
      await cleanupMalformedActiveDefiLoopJobs();

      const { rows } = await db.query(
        `SELECT id, wallet_address, daily_defi_loop_count, defi_daily_reset_at, daily_limit_reset_at FROM agents
         WHERE (defi_loop_enabled = TRUE OR lending_automation_enabled = TRUE OR carry_automation_enabled = TRUE OR cirbtc_lp_enabled = TRUE)
           AND status NOT IN ('locked', 'inactive')`,
      );

      const queuedOrActiveAgentIds = await getQueuedOrActiveDefiLoopAgentIds();
      let queuedCount = 0;
      let cappedCount = 0;
      let queueErrorCount = 0;
      const nowUtc = Date.now();

      for (const agent of rows) {
        const { id } = agent;
        if (queuedOrActiveAgentIds.has(String(id))) continue;

        const dailyCapReached = hasReachedSharedDefiDailyCap(agent, nowUtc);

        if (dailyCapReached) {
          cappedCount += 1;
          continue;
        }

        try {
          const enqueueResult = await queueDefiLoopForAgent(id, {
            reason: 'scheduled',
            priority: DEFI_LOOP_PRIORITY_SCHEDULED,
          });
          if (enqueueResult.queued) queuedCount += 1;
        } catch (enqueueError) {
          queueErrorCount += 1;
          console.error(`[DEFI_LOOP] Could not queue scheduled job for agent ${id}:`, enqueueError.message);
        }
      }
      if (queuedCount > 0) {
        console.log(`[DEFI_LOOP] Queued ${queuedCount} defi loop job(s)`);
      }
      if (cappedCount > 0) {
        console.log(`[DEFI_LOOP] Skipped ${cappedCount} agent(s) because their daily DeFi loop cap is already full`);
      }
      if (queueErrorCount > 0) {
        console.error(`[DEFI_LOOP] Queue errors for ${queueErrorCount} agent(s) during this schedule pass`);
      }
    } catch (err) {
      console.error('[DEFI_LOOP] Schedule error:', err.message);
    }
  };

  await cleanupMalformedActiveDefiLoopJobs();
  await recoverMissingAutoCarryHandoffRuns();
  setTimeout(() => {
    queueEligibleDefiLoops().catch((err) => {
      console.error('[DEFI_LOOP] Startup schedule error:', err.message);
    });
  }, Math.max(DEFI_LOOP_STARTUP_DELAY_MS, 0));
  setInterval(() => {
    cleanupMalformedActiveDefiLoopJobs().catch((err) => {
      console.error('[DEFI_LOOP] Orphan cleanup error:', err.message);
    });
  }, DEFI_LOOP_ORPHAN_SWEEP_INTERVAL_MS);
  setInterval(() => {
    recoverMissingAutoCarryHandoffRuns().catch((err) => {
      console.error('[DEFI_LOOP] Auto Carry handoff recovery error:', err.message);
    });
  }, CARRY_AUTOMATION_HANDOFF_RECOVERY_INTERVAL_MS);
  setInterval(queueEligibleDefiLoops, DEFI_LOOP_INTERVAL_MS);

  console.log(`[DEFI_LOOP] Started — interval ${DEFI_LOOP_INTERVAL_MS / 60000} min, startup delay ${Math.max(DEFI_LOOP_STARTUP_DELAY_MS, 0) / 1000}s, orphan sweep ${DEFI_LOOP_ORPHAN_SWEEP_INTERVAL_MS / 1000}s, carry handoff recovery ${CARRY_AUTOMATION_HANDOFF_RECOVERY_INTERVAL_MS / 1000}s, worker concurrency ${DEFI_LOOP_WORKER_CONCURRENCY}, max attempts ${DEFI_LOOP_MAX_ATTEMPTS}, GLOBAL_DRY_RUN=${GLOBAL_DRY_RUN}`);
}

// ── DAILY FREE TASKS (Tier 1) ──────────────────────────────────────────────────
// Built-in deterministic tasks only.
// Users see 5 featured tasks per UTC day and explicitly run the ones they want.
// No LLM key required — pure HTTP + onchain reads / DB summaries.

const DAILY_FREE_TASK_CAP = parseInt(process.env.DAILY_FREE_TASK_CAP || '5', 10);
const BUILTIN_DAILY_TASKS = [
  {
    id: 'DAILY_PRICE_REPORT',
    title: 'FX Peg Proxy Report',
    description: 'EURC/USDC + BRLA/USDC fiat peg proxies via Frankfurter',
    enabled: false,
  },
  {
    id: 'DAILY_POOL_HEALTH',
    title: 'Pool Health Check',
    description: 'Curve pool spread%, virtual_price and coin balances',
  },
  {
    id: 'DAILY_YIELD_RANK',
    title: 'Yield Ranking',
    description: 'Top 3 APY opportunities across USDC/EURC pools',
    enabled: false,
  },
  {
    id: 'DAILY_ARB_SCAN',
    title: 'Arb Signal Simulation',
    description: 'Estimated stablecoin spread check before live fees and execution change the edge',
  },
  {
    id: 'DAILY_WALLET_DIGEST',
    title: 'Wallet Digest',
    description: '24h activity summary and agent wallet balance snapshot',
    enabled: false,
  },
  {
    id: 'DAILY_FOREX_MATRIX',
    title: 'FX Reference Board',
    description: 'Merged fiat peg board for EURC, BRLA, MXNB and JPYC against USDC',
  },
  {
    id: 'DAILY_USDC_PEG_CHECK',
    title: 'USDC Peg Check',
    description: 'USDC/USD peg deviation and depeg risk snapshot',
  },
  {
    id: 'DAILY_MARKET_TAPE',
    title: 'Market Tape',
    description: 'USDC, EURC, ETH and BTC prices with 24h move summary',
    enabled: false,
  },
  {
    id: 'DAILY_PROTOCOL_TVL',
    title: 'Protocol TVL Monitor',
    description: 'Aave, Morpho and Maple TVL change snapshot',
    enabled: false,
  },
  {
    id: 'DAILY_ACTIVITY_RECAP',
    title: 'Wallet & Activity',
    description: 'Recent transaction mix plus wallet task and automation counts for the last 24h',
  },
];
const DAILY_TASK_TYPES = BUILTIN_DAILY_TASKS.map(task => task.id);

const PAID_TASK_FEE_USDC = parseFloat(process.env.PAID_TASK_FEE_USDC || '0.10');
const GAS_FANOUT_TASK_FEE_USDC = parseFloat(process.env.GAS_FANOUT_TASK_FEE_USDC || '0.20');
const AUTOMATION_EXECUTION_FEE_USDC = parseFloat(
  process.env.AUTOMATION_EXECUTION_FEE_USDC || String(PAID_TASK_FEE_USDC),
);
const CARRY_AUTOMATION_FOLLOWUP_DELAY_MS = Math.max(
  parseInt(process.env.CARRY_AUTOMATION_FOLLOWUP_DELAY_MS || '0', 10) || 0,
  0,
);
const CARRY_AUTOMATION_HANDOFF_RECOVERY_AGE_MS = Math.max(
  parseInt(
    process.env.CARRY_AUTOMATION_HANDOFF_RECOVERY_AGE_MS
      || String(Math.max(CARRY_AUTOMATION_FOLLOWUP_DELAY_MS + 10000, 12000)),
    10,
  ) || Math.max(CARRY_AUTOMATION_FOLLOWUP_DELAY_MS + 10000, 12000),
  5000,
);
const CARRY_AUTOMATION_HANDOFF_RECOVERY_INTERVAL_MS = Math.max(
  parseInt(process.env.CARRY_AUTOMATION_HANDOFF_RECOVERY_INTERVAL_MS || '15000', 10) || 15000,
  5000,
);
const CARRY_AUTOMATION_HANDOFF_RECOVERY_BATCH_SIZE = Math.max(
  Math.min(parseInt(process.env.CARRY_AUTOMATION_HANDOFF_RECOVERY_BATCH_SIZE || '25', 10) || 25, 100),
  1,
);
const AUTO_CARRY_HANDOFF_RECOVERY_STAGE_KEYS = [
  'carry_handoff_queued',
  'carry_waiting_followup',
  'carry_followup_running',
];
const AUTO_CARRY_HANDOFF_TERMINAL_ACTIONS = new Set([
  'deploy_wallet_balance',
  'repay_wallet_balance',
  'close_carry',
  'auto_carry_stop',
]);
const MANUAL_DEFI_PAID_TASK_OPTIONS = {
  guard: null,
  incrementDailyPaidCount: false,
};

function formatCarryFollowupDelayForSummary(delayMs = CARRY_AUTOMATION_FOLLOWUP_DELAY_MS) {
  const normalizedDelayMs = Math.max(Number(delayMs) || 0, 0);
  if (normalizedDelayMs <= 0) return '';
  return ` in ${Math.round(normalizedDelayMs / 1000)} seconds`;
}

// ── TIER-2 PAID TASK CATALOG ───────────────────────────────────────────────────
const BUILTIN_TIER2_TASKS = [
  {
    id:          'EXEC_CURVE_SWAP',
    title:       'Curve Swap',
    description: 'Execute a Curve stablecoin pool swap (e.g. USDC → EURC)',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_MANUAL_CURVE_SWAP',
    title:       'Manual Curve Swap',
    description: 'Hidden manual DeFi primitive for Curve stable swaps',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_CURVE_LIQUIDITY_ADD',
    title:       'Curve Liquidity Add',
    description: 'Add one-sided USDC or EURC liquidity into the verified Curve stable pool',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_SINGLE',
    title:       'Manual Curve Liquidity Add Single',
    description: 'Hidden manual DeFi primitive for one-sided Curve liquidity adds',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_DUAL',
    title:       'Manual Curve Liquidity Add Dual',
    description: 'Hidden manual DeFi primitive for dual-token Curve liquidity adds',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_CURVE_LIQUIDITY_REMOVE',
    title:       'Curve Liquidity Withdraw',
    description: 'Burn Curve LP into one stable token from the verified Arc pool',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_SINGLE',
    title:       'Manual Curve Liquidity Remove Single',
    description: 'Hidden manual DeFi primitive for one-sided Curve liquidity withdrawals',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_DUAL',
    title:       'Manual Curve Liquidity Remove Dual',
    description: 'Hidden manual DeFi primitive for dual-token Curve liquidity withdrawals',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_CIRBTC_USDC_ZAP_IN',
    title:       'cirBTC/USDC LP Bootstrap',
    description: 'Use up to 20 USDC, swap part into cirBTC, then mint LP on the direct cirBTC/USDC pair',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CIRBTC_EURC_ZAP_IN',
    title:       'cirBTC/EURC LP Bootstrap',
    description: 'Use up to 16 EURC, swap part into cirBTC, then mint LP on the direct cirBTC/EURC pair',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_MANUAL_DIRECT_PAIR_SWAP',
    title:       'Manual Direct Pair Swap',
    description: 'Hidden manual DeFi primitive for direct-pair swaps',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_ADD',
    title:       'Manual Direct Pair Liquidity Add',
    description: 'Hidden manual DeFi primitive for direct-pair single or dual liquidity adds',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_CIRBTC_USDC_LP_REMOVE',
    title:       'cirBTC/USDC LP Exit',
    description: 'Burn a percentage of the current cirBTC/USDC LP position and return both assets to the agent wallet',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_CIRBTC_EURC_LP_REMOVE',
    title:       'cirBTC/EURC LP Exit',
    description: 'Burn a percentage of the current cirBTC/EURC LP position and return both assets to the agent wallet',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_SINGLE',
    title:       'Manual Direct Pair Liquidity Remove Single',
    description: 'Hidden manual DeFi primitive for direct-pair exits into one target token',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_DUAL',
    title:       'Manual Direct Pair Liquidity Remove Dual',
    description: 'Hidden manual DeFi primitive for direct-pair dual-token exits',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_LENDING_SUPPLY',
    title:       'Lending Supply',
    description: 'Supply USDC or EURC into the Arc-native lending lane from the agent wallet',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_LENDING_WITHDRAW',
    title:       'Lending Withdraw',
    description: 'Withdraw an existing Arc-native lending supply position back into the agent wallet',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_LENDING_BORROW',
    title:       'Lending Borrow',
    description: 'Borrow USDC or EURC against the current Arc-native lending collateral buffer',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_LENDING_REPAY',
    title:       'Lending Repay',
    description: 'Repay an Arc-native lending debt position from the agent wallet',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_LENDING_COLLATERAL_TOP_UP',
    title:       'Lending Collateral Top-Up',
    description: 'Supply the visible wallet collateral needed to rebuild the lending health buffer toward the current target',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_LENDING_SAFE_EXIT',
    title:       'Lending Safe Exit',
    description: 'Repay visible lending debt with wallet funds, then withdraw the remaining supplied positions in one deterministic flow',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_LENDING_DELEVERAGE',
    title:       'Lending Deleverage',
    description: 'Run the deterministic emergency deleverage plan for the current Arc-native lending account',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_LENDING_LIQUIDATE',
    title:       'Lending Liquidate',
    description: 'Liquidate an unhealthy Arc-native lending account using a selected debt and collateral pair',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_AUTO_CARRY_START',
    title:       'Auto Carry Start',
    description: 'Trigger the autonomous carry lane without entering an amount. If a manual stable LP is blocking the lane, this task unwinds it first and then hands the route back to Auto Carry.',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_AUTO_CARRY_STOP',
    title:       'Auto Carry Stop',
    description: 'Turn Auto Carry off and unwind the current autonomous carry leg back toward wallet balances when the live lane state allows it.',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_MANUAL_LENDING_SUPPLY',
    title:       'Manual Lending Supply',
    description: 'Hidden manual DeFi primitive for Arc lending supply actions',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_LENDING_WITHDRAW',
    title:       'Manual Lending Withdraw',
    description: 'Hidden manual DeFi primitive for Arc lending withdraw actions',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_LENDING_BORROW',
    title:       'Manual Lending Borrow',
    description: 'Hidden manual DeFi primitive for Arc lending borrow actions',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_LENDING_REPAY',
    title:       'Manual Lending Repay',
    description: 'Hidden manual DeFi primitive for Arc lending repay actions',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_LENDING_COLLATERAL_TOP_UP',
    title:       'Manual Lending Collateral Top-Up',
    description: 'Hidden manual DeFi primitive for deterministic lending collateral top-up actions',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_LENDING_SAFE_EXIT',
    title:       'Manual Lending Safe Exit',
    description: 'Hidden manual DeFi primitive for deterministic lending safe-exit actions',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_LENDING_DELEVERAGE',
    title:       'Manual Lending Deleverage',
    description: 'Hidden manual DeFi primitive for deterministic emergency lending deleverage',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_MANUAL_LENDING_LIQUIDATE',
    title:       'Manual Lending Liquidate',
    description: 'Hidden manual DeFi primitive for Arc lending liquidation actions',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
    enabled:     false,
  },
  {
    id:          'EXEC_CCTP_BRIDGE',
    title:       'CCTP Bridge',
    description: 'Bridge USDC from Arc Testnet to one selected EVM testnet via Circle CCTP V2',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_SEPOLIA_GAS_FANOUT',
    title:       'Sepolia Gas Fanout',
    description: 'Bridge 0.01 ETH each from Sepolia to Optimism, Base and Arbitrum Sepolia in one run',
    tier:        2,
    fee_usdc:    GAS_FANOUT_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_ARB',
    title:       'Arb Execution',
    description: 'Execute a stablecoin arbitrage trade based on oracle arb signal',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
  {
    id:          'EXEC_REBALANCE',
    title:       'Portfolio Rebalance',
    description: 'Swap to rebalance USDC/EURC portfolio to a target ratio',
    tier:        2,
    fee_usdc:    PAID_TASK_FEE_USDC,
  },
];

// Combined seed list for task_catalog (Tier-1 free + Tier-2 paid)
const _ALL_SEEDED_TASKS = [
  ...BUILTIN_DAILY_TASKS.map(t => ({ ...t, tier: 1, fee_usdc: 0 })),
  ...BUILTIN_TIER2_TASKS,
];
const TASK_PERMISSION_REQUIREMENTS = Object.freeze({
  DAILY_POOL_HEALTH: 'defi_scan',
  DAILY_YIELD_RANK: 'defi_scan',
  DAILY_ARB_SCAN: 'defi_scan',
  DAILY_MARKET_TAPE: 'defi_scan',
  DAILY_PROTOCOL_TVL: 'defi_scan',
  EXEC_ARB: 'arbitrage',
  EXEC_REBALANCE: 'arbitrage',
});
const EXECUTION_TASK_FEE_BY_ID = Object.fromEntries(
  BUILTIN_TIER2_TASKS.map(task => [task.id, Number(task.fee_usdc) || 0]),
);

function getExecutionTaskFeeUsdc(taskId, fallbackFeeUsdc = PAID_TASK_FEE_USDC) {
  const feeUsdc = EXECUTION_TASK_FEE_BY_ID[taskId];
  return Number.isFinite(feeUsdc) && feeUsdc >= 0
    ? feeUsdc
    : fallbackFeeUsdc;
}

async function ensureTaskCatalogSeeded() {
  const placeholders = _ALL_SEEDED_TASKS
    .map((_, index) => {
      const offset = index * 6;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
    })
    .join(', ');

  const params = [];
  for (const task of _ALL_SEEDED_TASKS) {
    params.push(task.id, task.title, task.description, task.tier, task.fee_usdc, task.enabled !== false);
  }

  await db.query(
    `INSERT INTO task_catalog (id, title, description, tier, fee_usdc, enabled)
     VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE
     SET title = EXCLUDED.title,
         description = EXCLUDED.description,
         tier = EXCLUDED.tier,
         fee_usdc = EXCLUDED.fee_usdc,
         enabled = EXCLUDED.enabled`,
    params,
  );

  await db.query(
    `UPDATE task_catalog
        SET enabled = FALSE
      WHERE id = 'EXEC_YIELD_MOVE'`,
  );
}

// Helper: guard + day reset shared by all DAILY_* jobs
async function _dailyTaskGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, daily_free_task_count, free_task_daily_reset_at, daily_limit_reset_at,
            wallet_address
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent)                       return { ok: false, reason: 'agent_not_found' };
  // Dev bypass: skip all limit checks for test addresses
  if (isDailyLimitBypassed(agent)) {
    return { ok: true, agent };
  }
  if (!agent.daily_tasks_enabled)   return { ok: false, reason: 'daily_tasks_disabled' };

  // Daily reset
  if (new Date(agent.free_task_daily_reset_at || agent.daily_limit_reset_at).toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) {
    await db.query(
      `UPDATE agents SET daily_free_task_count = 0, free_task_daily_reset_at = NOW() WHERE id = $1`,
      [agentId],
    );
    agent.daily_free_task_count = 0;
  }
  if (agent.daily_free_task_count >= DAILY_FREE_TASK_CAP) {
    return { ok: false, reason: 'daily_task_cap_reached', count: agent.daily_free_task_count };
  }
  return { ok: true, agent };
}

// Helper: write result + increment counter + reputation (fire-and-forget)
async function _saveTaskResult(agentId, taskId, payload) {
  await db.query(
    `INSERT INTO agent_task_results (agent_id, task_id, payload) VALUES ($1, $2, $3::jsonb)`,
    [agentId, taskId, JSON.stringify(payload)],
  );
  await db.query(
    `UPDATE agents SET daily_free_task_count = daily_free_task_count + 1 WHERE id = $1`,
    [agentId],
  );
  recordReputationEvent(agentId, EVENT_TYPES.DAILY_TASK).catch(() => {});
}

// ── TIER-2 PAID TASK HELPERS ──────────────────────────────────────────────────

const DAILY_PAID_TASK_CAP  = parseInt(process.env.DAILY_PAID_TASK_CAP || '10', 10);

// Check daily paid cap; reset if a new UTC day has started
async function _paidTaskGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, daily_paid_task_count, paid_task_daily_reset_at, daily_limit_reset_at,
            wallet_address, private_key_encrypted,
            max_trade_usdc, oracle_max_eurc_inventory, oracle_min_eurc_reserve,
            carry_automation_enabled, defi_wallet_reserve_usdc
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent)                     return { ok: false, reason: 'agent_not_found' };
  // Dev bypass: skip all limit checks for test addresses
  if (isDailyLimitBypassed(agent)) {
    return { ok: true, agent };
  }
  if (!agent.daily_tasks_enabled) return { ok: false, reason: 'daily_tasks_disabled' };

  if (new Date(agent.paid_task_daily_reset_at || agent.daily_limit_reset_at).toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) {
    await db.query(
      `UPDATE agents SET daily_paid_task_count = 0, paid_task_daily_reset_at = NOW() WHERE id = $1`,
      [agentId],
    );
    agent.daily_paid_task_count = 0;
  }
  if (agent.daily_paid_task_count >= DAILY_PAID_TASK_CAP) {
    return { ok: false, reason: 'daily_paid_cap_reached', count: agent.daily_paid_task_count };
  }
  return { ok: true, agent };
}

async function _manualPaidDefiGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, wallet_address, private_key_encrypted
       FROM agents
      WHERE id = $1`,
    [agentId],
  );

  if (!agent) return { ok: false, reason: 'agent_not_found' };
  return { ok: true, agent };
}

// Write result only — no cap increment, no fee deposit, no implicit reputation side effect.
async function _saveResultOnly(agentId, taskId, payload, options = {}) {
  await db.query(
    `INSERT INTO agent_task_results (agent_id, task_id, payload) VALUES ($1, $2, $3::jsonb)`,
    [agentId, taskId, JSON.stringify(payload)],
  );

  const reputationEventType = typeof options.reputationEventType === 'string'
    ? options.reputationEventType
    : null;

  if (reputationEventType) {
    recordReputationEvent(agentId, reputationEventType).catch(() => {});
  }
}

// Guard for free execution tasks (no daily cap check, only tasks_enabled flag)
async function _freeExecGuard(agentId) {
  const { rows: [agent] } = await db.query(
    `SELECT id, daily_tasks_enabled, wallet_address, private_key_encrypted,
            daily_limit_usdc, max_trade_usdc, slippage_percent
     FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!agent) return { ok: false, reason: 'agent_not_found' };
  if (isDailyLimitBypassed(agent)) {
    return { ok: true, agent };
  }
  if (!agent.daily_tasks_enabled) return { ok: false, reason: 'daily_tasks_disabled' };
  return { ok: true, agent };
}

function _toTaskTxAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function _getCurveStableTaskToken(index) {
  return Number(index) === 1 ? 'EURC' : 'USDC';
}

function _getPaidTaskActivityStatus(payload, executionMeta = {}) {
  if (executionMeta?.forceStatus) return executionMeta.forceStatus;
  if (payload?.failed) return 'failed';
  if (payload?.dryRun) return 'dry_run';
  if (payload?.skipped) return 'skipped';
  return 'confirmed';
}

function _buildFailedPaidTaskPayload(taskId, params = {}, failure) {
  const message = _resolveTaskActivityFailureMessage(failure);
  const payload = {
    ...params,
    failed: true,
    reason: failure?.reason || failure?.code || 'task_execution_failed',
    error: message,
    summary: message,
  };

  if (taskId === 'EXEC_CIRBTC_USDC_ZAP_IN') payload.stableToken = payload.stableToken || 'USDC';
  if (taskId === 'EXEC_CIRBTC_EURC_ZAP_IN') payload.stableToken = payload.stableToken || 'EURC';
  if (taskId === 'EXEC_CIRBTC_USDC_LP_REMOVE') {
    payload.stableToken = payload.stableToken || 'USDC';
    payload.targetToken = payload.targetToken || 'USDC';
  }
  if (taskId === 'EXEC_CIRBTC_EURC_LP_REMOVE') {
    payload.stableToken = payload.stableToken || 'EURC';
    payload.targetToken = payload.targetToken || 'EURC';
  }

  return payload;
}

async function _recordFailedPaidTaskActivity(agentId, taskId, params = {}, failure, executionMeta = {}) {
  if (!agentId || !PAID_TASK_ACTIVITY_SUPPORTED_IDS.has(taskId)) return;
  if (PAID_TASK_RUNTIME_ACTIVITY_IDS.has(taskId)) return;

  await _recordPaidTaskActivity(
    agentId,
    taskId,
    _buildFailedPaidTaskPayload(taskId, params, failure),
    {
      ...executionMeta,
      forceStatus: 'failed',
      failureReason: failure?.reason || failure?.code || null,
      lastError: _resolveTaskActivityFailureMessage(failure),
    },
  );
}

async function _insertTaskActivityRecord(agentId, record) {
  if (record?.txId) {
    await db.query(
      `UPDATE transactions
          SET type = COALESCE($2, type),
              from_chain = COALESCE($3, from_chain),
              to_chain = COALESCE($4, to_chain),
              token = COALESCE($5, token),
              amount_usdc = COALESCE($6, amount_usdc),
              tx_hash = COALESCE($7, tx_hash),
              status = COALESCE($8, status),
              confirmed_at = CASE WHEN COALESCE($8, status) = 'confirmed' THEN COALESCE(confirmed_at, NOW()) ELSE confirmed_at END,
              meta = COALESCE(meta, '{}'::jsonb) || $9::jsonb
        WHERE id = $1`,
      [
        record.txId,
        record.type || null,
        record.fromChain || null,
        record.toChain || null,
        record.token || null,
        record.amount == null ? null : _toTaskTxAmount(record.amount),
        record.txHash || null,
        record.status || null,
        JSON.stringify(record.meta || {}),
      ],
    );
    return record.txId;
  }

  const { rows: [row] } = await db.query(
    `INSERT INTO transactions
       (agent_id, type, from_chain, to_chain, token, amount_usdc, tx_hash, status, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      agentId,
      record.type,
      record.fromChain || null,
      record.toChain || null,
      record.token || 'USDC',
      _toTaskTxAmount(record.amount),
      record.txHash || null,
      record.status || 'confirmed',
      JSON.stringify(record.meta || {}),
    ],
  );

  return row?.id || null;
}

function _resolveTaskActivityFailureMessage(failure) {
  if (!failure) return 'Task execution failed.';
  if (typeof failure === 'string') return failure;

  return failure.errorSummary
    || failure.stageDetail
    || failure.error
    || failure.reason
    || failure.message
    || 'Task execution failed.';
}

function _isAttestationPendingFailure(failure) {
  return /attestation.*(timeout|zaman aşımı)/i.test(_resolveTaskActivityFailureMessage(failure));
}

function _getPaidBridgeActivityStatus(step) {
  switch (step) {
    case 'approving':
      return bridgeActivityService.STATUS.AWAITING_APPROVE;
    case 'approved':
    case 'burning':
      return bridgeActivityService.STATUS.AWAITING_BURN;
    case 'burned':
    case 'attesting':
      return bridgeActivityService.STATUS.PENDING_ATTESTATION;
    case 'attested':
    case 'minting':
      return bridgeActivityService.STATUS.READY_TO_MINT;
    case 'complete':
      return bridgeActivityService.STATUS.MINTED;
    default:
      return bridgeActivityService.STATUS.AWAITING_APPROVE;
  }
}

function _buildPaidBridgeTxMeta(taskRunId, step, data = {}) {
  const meta = {
    taskId: 'EXEC_CCTP_BRIDGE',
    taskRunId,
    bridgeType: 'cctp',
    bridgeStep: step,
    lastUpdated: new Date().toISOString(),
    ...data,
  };

  if (step === 'complete') {
    meta.bridgeCompletionStatus = 'complete';
  } else if (['burned', 'attesting', 'attested', 'minting'].includes(step)) {
    meta.bridgeCompletionStatus = 'destination_pending';
  } else {
    meta.bridgeCompletionStatus = 'source_submitted';
  }

  return meta;
}

async function _createPaidBridgeRuntimeTracking(agent, params = {}, taskRunId = null) {
  const txId = await _insertTaskActivityRecord(agent.id, {
    type: 'bridge',
    fromChain: params.fromChain || 'Arc Testnet',
    toChain: params.toChain || 'Arc Testnet',
    token: 'USDC',
    amount: params.amountUsdc || 0,
    status: 'executing',
    meta: _buildPaidBridgeTxMeta(taskRunId, 'approving'),
  });

  const activity = {
    id: txId,
    txId,
    agentId: agent.id,
    walletAddress: agent.wallet_address || agent.walletAddress,
    fromChain: params.fromChain || 'Arc Testnet',
    toChain: params.toChain || 'Arc Testnet',
    amount: params.amountUsdc || 0,
    token: 'USDC',
    mode: 'auto',
    status: bridgeActivityService.STATUS.AWAITING_APPROVE,
    startedAt: Date.now(),
  };

  await bridgeActivityService.upsertActivity(activity).catch(() => {});
  return { txId, activity, taskRunId, agentId: agent.id };
}

async function _updatePaidBridgeRuntimeTracking(tracking, params = {}, step, data = {}) {
  if (!tracking?.txId) return;

  const txHash = data.mintTxHash || data.burnTxHash || data.approveTxHash || null;

  await _insertTaskActivityRecord(tracking.agentId, {
    txId: tracking.txId,
    type: 'bridge',
    fromChain: params.fromChain || 'Arc Testnet',
    toChain: params.toChain || 'Arc Testnet',
    token: 'USDC',
    amount: params.amountUsdc || 0,
    txHash,
    status: step === 'complete' ? 'confirmed' : 'executing',
    meta: _buildPaidBridgeTxMeta(tracking.taskRunId, step, data),
  });

  const current = await bridgeActivityService.getActivity(tracking.activity.id).catch(() => tracking.activity);
  const next = {
    ...(current || tracking.activity),
    status: _getPaidBridgeActivityStatus(step),
  };

  if (data.approveTxHash) next.approveTxHash = data.approveTxHash;
  if (data.burnTxHash) next.sourceTxHash = data.burnTxHash;
  if (data.messageHash) next.messageHash = data.messageHash;
  if (data.mintTxHash) next.mintTxHash = data.mintTxHash;

  await bridgeActivityService.upsertActivity(next).catch(() => {});
}

async function _failPaidBridgeRuntimeTracking(tracking, params = {}, failure) {
  if (!tracking?.txId) return;

  const message = _resolveTaskActivityFailureMessage(failure);

  await _insertTaskActivityRecord(tracking.agentId, {
    txId: tracking.txId,
    type: 'bridge',
    fromChain: params.fromChain || 'Arc Testnet',
    toChain: params.toChain || 'Arc Testnet',
    token: 'USDC',
    amount: params.amountUsdc || 0,
    status: 'failed',
    meta: {
      taskId: 'EXEC_CCTP_BRIDGE',
      taskRunId: tracking.taskRunId,
      bridgeType: 'cctp',
      error: message,
      summary: message,
      lastError: message,
    },
  });

  const current = await bridgeActivityService.getActivity(tracking.activity.id).catch(() => tracking.activity);
  await bridgeActivityService.upsertActivity({
    ...(current || tracking.activity),
    status: bridgeActivityService.STATUS.FAILED,
    error: message,
  }).catch(() => {});
}

async function _keepPaidBridgePendingAttestation(tracking, params = {}, failure) {
  if (!tracking?.txId) return;

  const message = _resolveTaskActivityFailureMessage(failure);

  await _insertTaskActivityRecord(tracking.agentId, {
    txId: tracking.txId,
    type: 'bridge',
    fromChain: params.fromChain || 'Arc Testnet',
    toChain: params.toChain || 'Arc Testnet',
    token: 'USDC',
    amount: params.amountUsdc || 0,
    status: 'executing',
    meta: {
      taskId: 'EXEC_CCTP_BRIDGE',
      taskRunId: tracking.taskRunId,
      bridgeType: 'cctp',
      bridgeStep: 'attesting',
      bridgeCompletionStatus: 'destination_pending',
      attestationPending: true,
      lastError: message,
      summary: 'Attestation is still pending. This bridge can take up to 30 minutes before the destination mint completes.',
    },
  });

  const current = await bridgeActivityService.getActivity(tracking.activity.id).catch(() => tracking.activity);
  const next = {
    ...(current || tracking.activity),
    status: bridgeActivityService.STATUS.PENDING_ATTESTATION,
  };

  delete next.error;
  await bridgeActivityService.upsertActivity(next).catch(() => {});
}

async function _createPaidGasFanoutRuntimeTracking(agent, taskRunId = null) {
  const txId = await _insertTaskActivityRecord(agent.id, {
    type: 'gas_topup',
    fromChain: 'Sepolia',
    toChain: 'Multiple destinations',
    token: 'ETH',
    amount: 0,
    status: 'executing',
    meta: {
      taskId: 'EXEC_SEPOLIA_GAS_FANOUT',
      taskRunId,
      bridgeType: 'native',
      bridgeStep: 'source_submitted',
      bridgeCompletionStatus: 'source_submitted',
      amountEth: PAID_GAS_FANOUT_AMOUNT_ETH,
      targets: [],
    },
  });

  return {
    txId,
    taskRunId,
    agentId: agent.id,
    walletAddress: agent.wallet_address || agent.walletAddress,
    targets: [],
    bridgeActivities: [],
  };
}

function _getPaidGasFanoutBridgeStatus(step) {
  if (step === 'arrived' || step === 'complete') return bridgeActivityService.STATUS.MINTED;
  if (step === 'awaiting_arrival') return bridgeActivityService.STATUS.PENDING_DESTINATION;
  return bridgeActivityService.STATUS.SOURCE_SUBMITTED;
}

async function _upsertPaidGasFanoutBridgeActivity(tracking, step, data = {}) {
  if (!tracking?.walletAddress || !data?.toChain) return;

  const existing = Array.isArray(tracking.bridgeActivities)
    ? tracking.bridgeActivities.find((activity) => activity.toChain === data.toChain)
    : null;

  const next = await bridgeActivityService.upsertActivity({
    ...(existing || {}),
    agentId: tracking.agentId,
    walletAddress: tracking.walletAddress,
    fromChain: 'Sepolia',
    toChain: data.toChain,
    amount: data.amountEth || existing?.amount || PAID_GAS_FANOUT_AMOUNT_ETH,
    token: 'ETH',
    mode: 'auto',
    bridgeType: 'native',
    status: _getPaidGasFanoutBridgeStatus(step),
    sourceTxHash: data.topUpTxHash || existing?.sourceTxHash || null,
    destinationTxHash: data.destinationTxHash || existing?.destinationTxHash || null,
    mintTxHash: data.destinationTxHash || existing?.mintTxHash || null,
    taskId: 'EXEC_SEPOLIA_GAS_FANOUT',
    taskRunId: tracking.taskRunId,
    parentTxId: tracking.txId,
    startedAt: existing?.startedAt || Date.now(),
  }).catch(() => null);

  if (!next) return;

  const nextActivities = Array.isArray(tracking.bridgeActivities)
    ? tracking.bridgeActivities.filter((activity) => activity.toChain !== data.toChain)
    : [];
  nextActivities.push(next);
  tracking.bridgeActivities = nextActivities;
}

function _applyGasFanoutStepToTargets(tracking, step, data = {}) {
  const toChain = data.toChain;
  if (!toChain) return Array.isArray(tracking.targets) ? tracking.targets : [];

  const nextTargets = Array.isArray(tracking.targets) ? [...tracking.targets] : [];
  const index = nextTargets.findIndex(target => target.toChain === toChain);
  const current = index >= 0 ? nextTargets[index] : { toChain };
  const updated = {
    ...current,
    fromChain: data.fromChain || current.fromChain || 'Sepolia',
    amountEth: data.amountEth || current.amountEth || PAID_GAS_FANOUT_AMOUNT_ETH,
    topUpTxHash: data.topUpTxHash || current.topUpTxHash || null,
    sourceTxHash: data.topUpTxHash || data.sourceTxHash || current.sourceTxHash || current.topUpTxHash || null,
    destinationTxHash: data.destinationTxHash || current.destinationTxHash || null,
    status: step,
  };

  if (index >= 0) nextTargets[index] = updated;
  else nextTargets.push(updated);

  tracking.targets = nextTargets;
  return nextTargets;
}

async function _updatePaidGasFanoutRuntimeTracking(tracking, step, data = {}) {
  if (!tracking?.txId) return;

  const targets = _applyGasFanoutStepToTargets(tracking, step, data);
  const txHash = data.topUpTxHash || targets.find(target => target?.topUpTxHash)?.topUpTxHash || null;

  if (data?.toChain) {
    await _upsertPaidGasFanoutBridgeActivity(tracking, step, data);
  }

  await _insertTaskActivityRecord(tracking.agentId, {
    txId: tracking.txId,
    type: 'gas_topup',
    fromChain: 'Sepolia',
    toChain: data.toChain || 'Multiple destinations',
    token: 'ETH',
    amount: 0,
    txHash,
    status: step === 'complete' ? 'confirmed' : 'executing',
    meta: {
      taskId: 'EXEC_SEPOLIA_GAS_FANOUT',
      taskRunId: tracking.taskRunId,
      bridgeType: 'native',
      bridgeStep: step === 'complete' ? 'complete' : (data.topUpTxHash ? 'destination_pending' : 'source_submitted'),
      bridgeCompletionStatus: step === 'complete' ? 'complete' : 'destination_pending',
      amountEth: data.amountEth || PAID_GAS_FANOUT_AMOUNT_ETH,
      currentTarget: data.toChain || null,
      topUpTxHash: data.topUpTxHash || null,
      targets,
    },
  });
}

async function _failPaidGasFanoutRuntimeTracking(tracking, failure) {
  if (!tracking?.txId) return;

  const message = _resolveTaskActivityFailureMessage(failure);

  if (Array.isArray(tracking.bridgeActivities) && tracking.bridgeActivities.length > 0) {
    await Promise.all(
      tracking.bridgeActivities.map((activity) => {
        if (!activity || ['minted', 'dismissed', 'failed'].includes(activity.status)) return null;
        return bridgeActivityService.upsertActivity({
          ...activity,
          status: bridgeActivityService.STATUS.FAILED,
          error: message,
        }).catch(() => {});
      }),
    );
  }

  await _insertTaskActivityRecord(tracking.agentId, {
    txId: tracking.txId,
    type: 'gas_topup',
    fromChain: 'Sepolia',
    toChain: 'Multiple destinations',
    token: 'ETH',
    amount: 0,
    status: 'failed',
    meta: {
      taskId: 'EXEC_SEPOLIA_GAS_FANOUT',
      taskRunId: tracking.taskRunId,
      bridgeType: 'native',
      error: message,
      summary: message,
      lastError: message,
      amountEth: PAID_GAS_FANOUT_AMOUNT_ETH,
      targets: Array.isArray(tracking.targets) ? tracking.targets : [],
    },
  });
}

async function _recordPaidTaskActivity(agentId, taskId, payload, executionMeta) {
  const status = _getPaidTaskActivityStatus(payload, executionMeta);

  if (taskId === 'EXEC_CIRBTC_USDC_ZAP_IN' || taskId === 'EXEC_CIRBTC_EURC_ZAP_IN' || taskId === 'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_ADD') {
    await _insertTaskActivityRecord(agentId, {
      type: 'direct_lp_add',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.stableToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.mintTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CIRBTC_USDC_LP_REMOVE' || taskId === 'EXEC_CIRBTC_EURC_LP_REMOVE' || taskId === 'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_DUAL' || taskId === 'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_SINGLE') {
    await _insertTaskActivityRecord(agentId, {
      type: 'direct_lp_remove',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.targetToken || payload?.stableToken || 'USDC',
      amount: payload?.lpAmount || payload?.targetTokenAmount || 0,
      txHash: payload?.swapTxHash || payload?.burnTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (
    taskId === 'EXEC_LENDING_SUPPLY'
    || taskId === 'EXEC_LENDING_WITHDRAW'
    || taskId === 'EXEC_LENDING_BORROW'
    || taskId === 'EXEC_LENDING_REPAY'
    || taskId === 'EXEC_MANUAL_LENDING_SUPPLY'
    || taskId === 'EXEC_MANUAL_LENDING_WITHDRAW'
    || taskId === 'EXEC_MANUAL_LENDING_BORROW'
    || taskId === 'EXEC_MANUAL_LENDING_REPAY'
  ) {
    await _insertTaskActivityRecord(agentId, {
      type: `lending_${String(payload?.action || '').toLowerCase() || 'action'}`,
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.asset || 'USDC',
      amount: payload?.amount || 0,
      txHash: payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_AUTO_CARRY_START' || taskId === 'EXEC_AUTO_CARRY_STOP') {
    await _insertTaskActivityRecord(agentId, {
      type: taskId === 'EXEC_AUTO_CARRY_START' ? 'carry_start' : 'carry_stop',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.stableToken || 'USDC',
      amount: payload?.positionValueUsd || payload?.debtAmount || 0,
      txHash: payload?.repayTxHash || payload?.removeLiquidityTxHash || payload?.conversionTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_LENDING_COLLATERAL_TOP_UP' || taskId === 'EXEC_MANUAL_LENDING_COLLATERAL_TOP_UP') {
    const firstStep = Array.isArray(payload?.stepsExecuted) && payload.stepsExecuted.length > 0
      ? payload.stepsExecuted[0]
      : (Array.isArray(payload?.plannedSteps) && payload.plannedSteps.length > 0 ? payload.plannedSteps[0] : null);

    await _insertTaskActivityRecord(agentId, {
      type: 'lending_collateral_topup',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: firstStep?.asset || 'USDC',
      amount: payload?.collateralUsdPlanned || firstStep?.usdAmount || 0,
      txHash: firstStep?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_LENDING_SAFE_EXIT' || taskId === 'EXEC_MANUAL_LENDING_SAFE_EXIT') {
    const firstStep = Array.isArray(payload?.stepsExecuted) && payload.stepsExecuted.length > 0
      ? payload.stepsExecuted[0]
      : (Array.isArray(payload?.plannedSteps) && payload.plannedSteps.length > 0 ? payload.plannedSteps[0] : null);

    await _insertTaskActivityRecord(agentId, {
      type: 'lending_safe_exit',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: firstStep?.asset || 'USDC',
      amount: payload?.repayUsdPlanned || payload?.withdrawUsdPlanned || firstStep?.usdAmount || 0,
      txHash: firstStep?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_LENDING_DELEVERAGE' || taskId === 'EXEC_MANUAL_LENDING_DELEVERAGE') {
    const firstStep = Array.isArray(payload?.stepsExecuted) && payload.stepsExecuted.length > 0
      ? payload.stepsExecuted[0]
      : (Array.isArray(payload?.plannedSteps) && payload.plannedSteps.length > 0 ? payload.plannedSteps[0] : null);

    await _insertTaskActivityRecord(agentId, {
      type: 'lending_deleverage',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: firstStep?.asset || 'USDC',
      amount: payload?.repayUsdPlanned || firstStep?.usdAmount || 0,
      txHash: firstStep?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_LENDING_LIQUIDATE' || taskId === 'EXEC_MANUAL_LENDING_LIQUIDATE') {
    await _insertTaskActivityRecord(agentId, {
      type: 'lending_liquidation',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.debtAsset || 'USDC',
      amount: payload?.amount || 0,
      txHash: payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CURVE_SWAP' || taskId === 'EXEC_MANUAL_CURVE_SWAP' || taskId === 'EXEC_MANUAL_DIRECT_PAIR_SWAP') {
    await _insertTaskActivityRecord(agentId, {
      type: 'swap',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: executionMeta.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CURVE_LIQUIDITY_ADD' || taskId === 'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_SINGLE' || taskId === 'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_DUAL') {
    await _insertTaskActivityRecord(agentId, {
      type: 'curve_lp_add',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.tokenIn || 'USDC',
      amount: payload?.amountIn || payload?.amountUsdc || 0,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CURVE_LIQUIDITY_REMOVE' || taskId === 'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_SINGLE' || taskId === 'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_DUAL') {
    await _insertTaskActivityRecord(agentId, {
      type: 'curve_lp_remove',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.tokenOut || 'USDC',
      amount: payload?.amountOut || payload?.lpAmount || 0,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_CCTP_BRIDGE') {
    await _insertTaskActivityRecord(agentId, {
      txId: executionMeta.activityTxId || null,
      type: 'bridge',
      fromChain: payload?.fromChain || 'Arc Testnet',
      toChain: payload?.toChain || 'Arc Testnet',
      token: 'USDC',
      amount: payload?.amountUsdc,
      txHash: payload?.burnTxHash || payload?.txHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_SEPOLIA_GAS_FANOUT') {
    await _insertTaskActivityRecord(agentId, {
      txId: executionMeta.activityTxId || null,
      type: 'gas_topup',
      fromChain: payload?.fromChain || 'Sepolia',
      toChain: Array.isArray(payload?.targets) && payload.targets.length === 1
        ? payload.targets[0].toChain
        : 'Multiple destinations',
      token: 'ETH',
      amount: 0,
      txHash: payload?.targets?.[0]?.topUpTxHash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_ARB') {
    await _insertTaskActivityRecord(agentId, {
      type: 'task_arb',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: executionMeta.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.swapTxHash || payload?.swap?.txHash || payload?.swap?.hash || null,
      status,
      meta: executionMeta,
    });
    return;
  }

  if (taskId === 'EXEC_REBALANCE') {
    await _insertTaskActivityRecord(agentId, {
      type: 'rebalance',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      token: payload?.fromToken || 'USDC',
      amount: payload?.amountIn,
      txHash: payload?.txHash || payload?.hash || null,
      status,
      meta: executionMeta,
    });
  }
}

// Write result + increment daily_paid_task_count + attach task economy fee metadata
async function _savePaidTaskResult(agentId, taskId, payload, agent, options = {}) {
  const feeUsdc = Number.isFinite(Number(options.feeUsdc))
    ? Number(options.feeUsdc)
    : getExecutionTaskFeeUsdc(taskId);
  const fromChain = options.fromChain || taskEconomyService.getTaskEconomyConfigSummary().chain;
  const toChain = options.toChain || taskEconomyService.getTaskEconomyConfigSummary().chain;
  const incrementDailyPaidCount = options.incrementDailyPaidCount !== false;
  let economy = null;

  try {
    economy = await taskEconomyService.settleTaskExecutionFee({
      agent,
      taskId,
      feeUsdc,
      fromChain,
      toChain,
    });
  } catch (err) {
    economy = {
      mode: 'circle_gateway_task_fee',
      rail: 'agentic_task_economy',
      taskId,
      feeUsdc,
      sourceChain: fromChain,
      destinationChain: toChain,
      status: 'failed',
      error: err.message,
    };
    console.warn(`[TASK_ECONOMY] ${taskId} fee settlement failed:`, err.message);
  }

  const resultPayload = { ...payload, economy };

  const { rows: [storedResult] } = await db.query(
    `INSERT INTO agent_task_results (agent_id, task_id, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, created_at`,
    [agentId, taskId, JSON.stringify(resultPayload)],
  );

  const executionMeta = {
    taskId,
    taskRunId: options.taskRunId || null,
    activityTxId: options.activityTxId || null,
    taskResultId: storedResult?.id || null,
    taskResultCreatedAt: storedResult?.created_at || null,
    txHash: payload?.txHash || payload?.hash || payload?.swapTxHash || null,
    fromToken: payload?.fromToken || _getCurveStableTaskToken(payload?.indexIn),
    toToken: payload?.toToken || _getCurveStableTaskToken(payload?.indexOut),
    executionRail: payload?.executionRail || null,
    swapExecutionRail: payload?.swapExecutionRail || null,
    swapRouteStrategy: payload?.swapRouteStrategy || null,
    swapRouteReason: payload?.swapRouteReason || null,
    poolAddress: payload?.poolAddress || null,
    poolSource: payload?.poolSource || null,
    indexIn: payload?.indexIn ?? null,
    indexOut: payload?.indexOut ?? null,
    minDy: payload?.minDy || payload?.swap?.minDy || null,
    minLpAmount: payload?.minLpAmount || null,
    minAmountOut: payload?.minAmountOut || null,
    stableToken: payload?.stableToken || null,
    volatileToken: payload?.volatileToken || null,
    amountIn: payload?.amountIn || null,
    requestedAmountIn: payload?.requestedAmountIn || payload?.amountIn || null,
    amountUsdc: payload?.amountUsdc || null,
    amountEth: payload?.amountEth || null,
    swappedAmountIn: payload?.swappedAmountIn || null,
    remainingAmountIn: payload?.remainingAmountIn || null,
    amountOut: payload?.amountOut || null,
    lpAmount: payload?.lpAmount || null,
    fromChain: payload?.fromChain || null,
    toChain: payload?.toChain || null,
    direction: payload?.direction || null,
    bridgeType: payload?.bridgeType || null,
    kind: payload?.kind || null,
    targets: Array.isArray(payload?.targets) ? payload.targets : null,
    signalOpportunity: payload?.signal?.opportunity || null,
    liquidityStableAmountUsed: payload?.liquidityStableAmountUsed || null,
    liquidityStableAmountRemaining: payload?.liquidityStableAmountRemaining || null,
    liquidityVolatileAmountUsed: payload?.liquidityVolatileAmountUsed || null,
    liquidityVolatileAmountRemaining: payload?.liquidityVolatileAmountRemaining || null,
    withdrawPct: payload?.withdrawPct || null,
    token0Amount: payload?.token0Amount || null,
    token1Amount: payload?.token1Amount || null,
    token0Symbol: payload?.token0Symbol || null,
    token1Symbol: payload?.token1Symbol || null,
    swapTxHash: payload?.swapTxHash || null,
    swapPoolAddress: payload?.swapPoolAddress || null,
    swapPoolSource: payload?.swapPoolSource || null,
    mintTxHash: payload?.mintTxHash || null,
    burnTxHash: payload?.burnTxHash || null,
    summary: payload?.summary || null,
    economy,
  };

  await _recordPaidTaskActivity(agentId, taskId, payload, executionMeta);

  if (incrementDailyPaidCount) {
    await db.query(
      `UPDATE agents SET daily_paid_task_count = daily_paid_task_count + 1 WHERE id = $1`,
      [agentId],
    );
  }
  recordReputationEvent(agentId, EVENT_TYPES.PAID_TASK).catch(() => {});

  return resultPayload;
}

function registerPaidTaskProcessor(name, concurrency, executePaidTask, resolveEconomyOptions) {
  REGISTERED_PAID_TASK_PROCESSORS.add(name);

  const options = typeof resolveEconomyOptions === 'function'
    ? { resolveEconomyOptions }
    : (resolveEconomyOptions || {});
  const guardTask = options.guard || _paidTaskGuard;
  const incrementDailyPaidCount = options.incrementDailyPaidCount !== false;
  const economyResolver = typeof options.resolveEconomyOptions === 'function'
    ? options.resolveEconomyOptions
    : null;

  registerTaskProcessor(name, concurrency, async (job) => {
    const { agentId, params = {}, taskRunId = null } = job.data;
    const guard = await guardTask(agentId);
    if (!guard.ok) {
      await _recordFailedPaidTaskActivity(agentId, name, params, guard, { taskRunId });
      return guard;
    }
    const { agent } = guard;

    const context = {
      job,
      agentId,
      agent,
      params,
      taskRunId,
      dryRun: shouldUseDryRun(agent),
    };
    const result = await executePaidTask(context);
    if (!result.ok) {
      await _recordFailedPaidTaskActivity(agentId, name, params, result, { taskRunId });
      return result;
    }

    const economyOptions = economyResolver
      ? economyResolver({ ...context, result }) || {}
      : {};

    const storedPayload = await _savePaidTaskResult(agentId, name, result.payload, agent, {
      feeUsdc: getExecutionTaskFeeUsdc(name),
      incrementDailyPaidCount,
      taskRunId,
      ...economyOptions,
    });
    return { ...result, payload: storedPayload };
  });
}

function assertPaidTaskEconomyCoverage() {
  const missing = BUILTIN_TIER2_TASKS
    .map(task => task.id)
    .filter(taskId => !REGISTERED_PAID_TASK_PROCESSORS.has(taskId));

  if (missing.length > 0) {
    throw new Error(`Missing paid task economy coverage for: ${missing.join(', ')}`);
  }
}

function assertPaidTaskActivityCoverage() {
  const missing = BUILTIN_TIER2_TASKS
    .map(task => task.id)
    .filter(taskId => !PAID_TASK_ACTIVITY_SUPPORTED_IDS.has(taskId));

  if (missing.length > 0) {
    throw new Error(`Missing paid task activity coverage for: ${missing.join(', ')}`);
  }
}

// ── DAILY_PRICE_REPORT ────────────────────────────────────────────────────────
registerTaskProcessor('DAILY_PRICE_REPORT', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const [eurc, brla] = await Promise.allSettled([
    oracle.getForexRate('EURC', 'USDC'),
    oracle.getForexRate('BRLA', 'USDC'),
  ]);
  const payload = {
    EURC_USDC: eurc.status === 'fulfilled' ? eurc.value : null,
    BRLA_USDC: brla.status === 'fulfilled' ? brla.value : null,
    summary:   [
      eurc.status === 'fulfilled' ? `EURC/USDC peg proxy ${eurc.value.rate}` : null,
      brla.status === 'fulfilled' ? `BRLA/USDC peg proxy ${brla.value.rate}` : null,
    ].filter(Boolean).join(' · ') || 'Fiat peg proxy snapshot captured for EURC and BRLA.',
    fetchedAt:  new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_PRICE_REPORT', payload);
  return { ok: true, payload };
});

// ── DAILY_POOL_HEALTH ─────────────────────────────────────────────────────────
registerTaskProcessor('DAILY_POOL_HEALTH', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const forexRate = await oracle.getForexRate('EURC', 'USDC');
  const poolState  = await _getOracleStablePoolState(forexRate);

  const spread = Math.abs(poolState.impliedRate - forexRate.rate) / forexRate.rate;
  const health  = spread > 0.02 ? 'alert' : spread > 0.005 ? 'opportunity' : 'healthy';

  const payload = {
    spread,
    health,
    poolState,
    summary: `Pool health ${health} with ${(spread * 100).toFixed(2)}% spread versus forex.`,
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_POOL_HEALTH', payload);
  return { ok: true, payload };
});

// ── DAILY_YIELD_RANK ──────────────────────────────────────────────────────────
registerTaskProcessor('DAILY_YIELD_RANK', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const opportunities = await oracle.getYieldOpportunities();
  const top3 = (opportunities || []).slice(0, 3);

  const payload = {
    top3,
    summary: top3.length
      ? `Top yield venues: ${top3.map(item => `${item.name} ${item.apy}%`).join(' · ')}`
      : 'Yield ranking completed with no eligible pools.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_YIELD_RANK', payload);
  return { ok: true, payload };
});

// ── DAILY_ARB_SCAN ────────────────────────────────────────────────────────────
registerTaskProcessor('DAILY_ARB_SCAN', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const forexRate = await oracle.getForexRate('EURC', 'USDC');
  const poolState  = await _getOracleStablePoolState(forexRate);

  const signal = oracle.buildArbSignal({
    strategy:      'stablecoin_fx',
    forexRate:     forexRate.rate,
    poolRate:      poolState.impliedRate,
    poolFee:       poolState.fee,
    poolLiquidity: (poolState.reserves?.token0 ?? 0) + (poolState.reserves?.token1 ?? 0),
    priceImpacts:  poolState.priceImpact,
    baseToken:     'EURC',
    quoteToken:    'USDC',
  });
  const referenceAmountUsdc = Number(signal.opportunity?.amountUsdc || 0);
  const formatArbMetric = (value, maximumFractionDigits = 2) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value || '0');
    return numeric.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits,
    });
  };

  const payload = {
    mode: 'simulation',
    signal: signal.opportunity.found ? signal : null,
    referenceSwapAmountUsdc: referenceAmountUsdc > 0 ? referenceAmountUsdc : null,
    summary: signal.opportunity.found
      ? `Reference only: if you swapped about ${formatArbMetric(referenceAmountUsdc, 0)} USDC on the Curve leg, the current spread suggests roughly ${formatArbMetric(signal.opportunity.expectedProfitUsdc || signal.opportunity.netProfitUsdc || 0)} USDC before bridge, exit and live fees.`
      : 'Simulation did not find a profitable arbitrage setup in the latest scan.',
    disclaimer: 'Estimate only. Live bridge, exit pricing and fees can change before execution.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_ARB_SCAN', payload);
  return { ok: true, payload };
});

// ── DAILY_WALLET_DIGEST ───────────────────────────────────────────────────────
registerTaskProcessor('DAILY_WALLET_DIGEST', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const [agentRow, taskCount] = await Promise.all([
    db.query(`SELECT wallet_address, daily_free_task_count, daily_auto_tx_count FROM agents WHERE id = $1`, [agentId]),
    db.query(
      `SELECT COUNT(*) AS cnt FROM agent_task_results WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    ),
  ]);
  const a = agentRow.rows[0] || {};
  const payload = {
    walletAddress:    a.wallet_address,
    tasksToday:       parseInt(taskCount.rows[0]?.cnt || '0', 10),
    dailyFreeCount:   a.daily_free_task_count ?? 0,
    dailyAutoTxCount: a.daily_auto_tx_count   ?? 0,
    summary:          `Wallet digest captured with ${parseInt(taskCount.rows[0]?.cnt || '0', 10)} task records and ${a.daily_auto_tx_count ?? 0} auto tx in the last 24h.`,
    fetchedAt:        new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_WALLET_DIGEST', payload);
  return { ok: true, payload };
});

// ── DAILY_FOREX_MATRIX ───────────────────────────────────────────────────────
registerTaskProcessor('DAILY_FOREX_MATRIX', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const rates = await oracle.getAllForexRates();
  const pairs = Object.entries(rates || {});
  const strongest = pairs.sort((left, right) => (right[1]?.rate ?? 0) - (left[1]?.rate ?? 0))[0];
  const featuredPairs = ['EURC/USDC', 'BRLA/USDC']
    .map((pair) => (rates?.[pair] ? `${pair} ${rates[pair].rate}` : null))
    .filter(Boolean);

  const payload = {
    rates,
    summary: featuredPairs.length
      ? `${featuredPairs.join(' · ')} · tracked ${pairs.length} fiat peg proxies${strongest ? ` · highest proxy ${strongest[0]} ${strongest[1].rate}` : ''}`
      : 'Tracked fiat peg proxies for the daily reference board.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_FOREX_MATRIX', payload);
  return { ok: true, payload };
});

// ── DAILY_USDC_PEG_CHECK ─────────────────────────────────────────────────────
registerTaskProcessor('DAILY_USDC_PEG_CHECK', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const peg = await oracle.getUsdcPegDeviation();
  const payload = {
    ...peg,
    summary: peg.isDepegRisk
      ? `USDC peg deviation is ${peg.deviationPct}% — depeg risk flagged.`
      : `USDC peg deviation is ${peg.deviationPct}% — no depeg risk detected.`,
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_USDC_PEG_CHECK', payload);
  return { ok: true, payload };
});

// ── DAILY_MARKET_TAPE ────────────────────────────────────────────────────────
registerTaskProcessor('DAILY_MARKET_TAPE', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const prices = await oracle.getMultipleTokenPrices(['USDC', 'EURC', 'ETH', 'BTC']);
  const movers = Object.values(prices || {}).sort((left, right) => Math.abs(right.change24h || 0) - Math.abs(left.change24h || 0));
  const leadMover = movers[0];

  const payload = {
    prices,
    summary: leadMover
      ? `Tracked ${movers.length} assets. Largest 24h move: ${leadMover.symbol} ${Number(leadMover.change24h || 0).toFixed(2)}%.`
      : 'Market tape snapshot completed for tracked assets.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_MARKET_TAPE', payload);
  return { ok: true, payload };
});

// ── DAILY_PROTOCOL_TVL ───────────────────────────────────────────────────────
registerTaskProcessor('DAILY_PROTOCOL_TVL', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const protocolIds = ['aave', 'morpho', 'maple'];
  const snapshots = await Promise.allSettled(
    protocolIds.map(async (protocolId) => ({
      protocolId,
      snapshot: await oracle.getProtocolTvl(protocolId),
    })),
  );

  const protocols = snapshots
    .filter(result => result.status === 'fulfilled' && result.value.snapshot)
    .map(result => result.value);
  const largest = protocols.slice().sort((left, right) => (right.snapshot.tvl ?? 0) - (left.snapshot.tvl ?? 0))[0];

  const payload = {
    protocols,
    summary: largest
      ? `Largest TVL snapshot: ${largest.protocolId} at ${Math.round((largest.snapshot.tvl || 0) / 1_000_000)}M USD.`
      : 'Protocol TVL snapshot completed, but no live TVL data was available.',
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_PROTOCOL_TVL', payload);
  return { ok: true, payload };
});

// ── DAILY_ACTIVITY_RECAP ─────────────────────────────────────────────────────
registerTaskProcessor('DAILY_ACTIVITY_RECAP', 3, async (job) => {
  const { agentId } = job.data;
  const guard = await _dailyTaskGuard(agentId);
  if (!guard.ok) return guard;

  const [countsResult, recentResult, agentRow, taskCount] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
         COUNT(*) FILTER (WHERE type = 'receive') AS receive_count,
         COUNT(*) FILTER (WHERE type = 'bridge') AS bridge_count,
         COUNT(*) FILTER (WHERE type = 'swap') AS swap_count
       FROM transactions
       WHERE agent_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    ),
    db.query(
      `SELECT type, status, token, amount_usdc, created_at
       FROM transactions
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT 3`,
      [agentId],
    ),
    db.query(
      `SELECT wallet_address, daily_free_task_count, daily_auto_tx_count
         FROM agents
        WHERE id = $1`,
      [agentId],
    ),
    db.query(
      `SELECT COUNT(*) AS cnt
         FROM agent_task_results
        WHERE agent_id = $1
          AND created_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    ),
  ]);

  const counts = countsResult.rows[0] || {};
  const agentSummary = agentRow.rows[0] || {};
  const totalCount = parseInt(counts.total || '0', 10);
  const confirmedCount = parseInt(counts.confirmed_count || '0', 10);
  const taskRecordCount = parseInt(taskCount.rows[0]?.cnt || '0', 10);
  const dailyAutoTxCount = agentSummary.daily_auto_tx_count ?? 0;
  const payload = {
    counts,
    recent: recentResult.rows,
    walletAddress: agentSummary.wallet_address || null,
    tasksToday: taskRecordCount,
    dailyFreeCount: agentSummary.daily_free_task_count ?? 0,
    dailyAutoTxCount,
    summary: `Wallet & activity: ${totalCount} tx, ${confirmedCount} confirmed, ${taskRecordCount} task records and ${dailyAutoTxCount} auto tx in the last 24h.`,
    fetchedAt: new Date().toISOString(),
  };
  await _saveTaskResult(agentId, 'DAILY_ACTIVITY_RECAP', payload);
  return { ok: true, payload };
});

// ── TIER-2 PAID TASK PROCESSORS ───────────────────────────────────────────────
// Each processor: guard → execute DeFi op → save result + fee deposit (fire-and-forget)

// ── EXEC_CURVE_SWAP ───────────────────────────────────────────────────────────
registerPaidTaskProcessor('EXEC_CURVE_SWAP', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveSwapTask({
    agent,
    params,
    dryRun,
    defaultCurvePool: _getUsdcEurcCurvePool(),
  })
));

registerPaidTaskProcessor('EXEC_CURVE_LIQUIDITY_ADD', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityAddTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_CURVE_LIQUIDITY_REMOVE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityRemoveTask({
    agent,
    params,
    dryRun,
  })
));

MANUAL_DEFI_PAID_TASK_OPTIONS.guard = _manualPaidDefiGuard;

registerPaidTaskProcessor('EXEC_MANUAL_CURVE_SWAP', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveSwapTask({
    agent,
    params,
    dryRun,
    defaultCurvePool: _getUsdcEurcCurvePool(),
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_CURVE_LIQUIDITY_ADD_SINGLE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityAddTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_CURVE_LIQUIDITY_ADD_DUAL', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityAddBalancedTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_SINGLE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityRemoveTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_DUAL', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeCurveLiquidityRemoveBalancedTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_CIRBTC_USDC_ZAP_IN', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairZapInTask({
    agent,
    params,
    dryRun,
    stableToken: 'USDC',
  })
));

registerPaidTaskProcessor('EXEC_CIRBTC_EURC_ZAP_IN', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairZapInTask({
    agent,
    params,
    dryRun,
    stableToken: 'EURC',
  })
));

registerPaidTaskProcessor('EXEC_MANUAL_DIRECT_PAIR_SWAP', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairSwapTask({
    agent,
    params,
    dryRun,
    stableToken: params.stableToken || 'USDC',
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_ADD', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairAddLiquidityTask({
    agent,
    params,
    dryRun,
    stableToken: params.stableToken || 'USDC',
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_CIRBTC_USDC_LP_REMOVE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairRemoveLiquidityTask({
    agent,
    params,
    dryRun,
    stableToken: 'USDC',
  })
));

registerPaidTaskProcessor('EXEC_CIRBTC_EURC_LP_REMOVE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairRemoveLiquidityTask({
    agent,
    params,
    dryRun,
    stableToken: 'EURC',
  })
));

registerPaidTaskProcessor('EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_SINGLE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairRemoveLiquiditySingleTask({
    agent,
    params,
    dryRun,
    stableToken: params.stableToken || 'USDC',
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_DUAL', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeDirectPairRemoveLiquidityTask({
    agent,
    params,
    dryRun,
    stableToken: params.stableToken || 'USDC',
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_LENDING_SUPPLY', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingSupplyTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_LENDING_WITHDRAW', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingWithdrawTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_LENDING_BORROW', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingBorrowTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_LENDING_REPAY', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingRepayTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_LENDING_COLLATERAL_TOP_UP', 2, async ({ agent, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingCollateralTopUpTask({
    agent,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_LENDING_SAFE_EXIT', 2, async ({ agent, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingSafeExitTask({
    agent,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_LENDING_DELEVERAGE', 2, async ({ agent, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingEmergencyDeleverageTask({
    agent,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_LENDING_LIQUIDATE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingLiquidationTask({
    agent,
    params,
    dryRun,
  })
));

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_SUPPLY', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingSupplyTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_WITHDRAW', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingWithdrawTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_BORROW', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingBorrowTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_REPAY', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingRepayTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_COLLATERAL_TOP_UP', 2, async ({ agent, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingCollateralTopUpTask({
    agent,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_SAFE_EXIT', 2, async ({ agent, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingSafeExitTask({
    agent,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_DELEVERAGE', 2, async ({ agent, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingEmergencyDeleverageTask({
    agent,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_MANUAL_LENDING_LIQUIDATE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeNativeLendingLiquidationTask({
    agent,
    params,
    dryRun,
  })
), MANUAL_DEFI_PAID_TASK_OPTIONS);

registerPaidTaskProcessor('EXEC_AUTO_CARRY_START', 1, async ({ agent, dryRun, taskRunId }) => (
  executeAutoCarryStartTask({
    agent,
    dryRun,
    taskRunId,
  })
));

registerPaidTaskProcessor('EXEC_AUTO_CARRY_STOP', 1, async ({ agent, dryRun, taskRunId }) => (
  executeAutoCarryStopTask({
    agent,
    dryRun,
    taskRunId,
  })
));

// ── EXEC_CCTP_BRIDGE ──────────────────────────────────────────────────────────
// Paid (Tier-2) — fee settles back into the shared Arc revenue pool.
registerPaidTaskProcessor('EXEC_CCTP_BRIDGE', 1, async ({ agent, params, dryRun, taskRunId }) => {
  const hasValidParams = params?.fromChain && params?.toChain && Number(params?.amountUsdc) > 0;
  const tracking = !dryRun && hasValidParams
    ? await _createPaidBridgeRuntimeTracking(agent, params, taskRunId)
    : null;

  try {
    const result = await agenticTaskExecutionService.executeBridgeTask({
      agent,
      params,
      dryRun,
      onStep: async (step, data) => {
        await _reportTaskRunStage(taskRunId, _buildBridgeStageMeta(step, params, data));
        if (tracking) {
          await _updatePaidBridgeRuntimeTracking(tracking, params, step, data);
        }
      },
    });

    if (tracking && result?.ok === false) {
      await _failPaidBridgeRuntimeTracking(tracking, params, result);
    }

    if (tracking && result?.ok && result?.payload) {
      result.payload.activityTxId = tracking.txId;
    }

    return result;
  } catch (error) {
    if (tracking) {
      if (_isAttestationPendingFailure(error)) {
        await _keepPaidBridgePendingAttestation(tracking, params, error);
      } else {
        await _failPaidBridgeRuntimeTracking(tracking, params, error);
      }
    }
    throw error;
  }
}, ({ result, params, taskRunId }) => ({
  fromChain: result?.payload?.fromChain || params.fromChain || 'Arc Testnet',
  toChain: 'Arc Testnet',
  taskRunId,
  activityTxId: result?.payload?.activityTxId || null,
}));

// ── EXEC_SEPOLIA_GAS_FANOUT ──────────────────────────────────────────────────
registerPaidTaskProcessor('EXEC_SEPOLIA_GAS_FANOUT', 1, async ({ agent, dryRun, taskRunId }) => {
  const tracking = dryRun ? null : await _createPaidGasFanoutRuntimeTracking(agent, taskRunId);

  try {
    const result = await agenticTaskExecutionService.executeSepoliaGasFanoutTask({
      agent,
      dryRun,
      onStep: async (step, data) => {
        await _reportTaskRunStage(taskRunId, _buildGasFanoutStageMeta(step, data));
        if (tracking) {
          await _updatePaidGasFanoutRuntimeTracking(tracking, step, data);
        }
      },
    });

    if (tracking && result?.ok === false) {
      await _failPaidGasFanoutRuntimeTracking(tracking, result);
    }

    if (tracking && result?.ok && result?.payload) {
      result.payload.activityTxId = tracking.txId;
    }

    return result;
  } catch (error) {
    if (tracking) {
      await _failPaidGasFanoutRuntimeTracking(tracking, error);
    }
    throw error;
  }
}, ({ result, taskRunId }) => {
  const taskEconomyChain = taskEconomyService.getTaskEconomyConfigSummary().chain;
  return {
    fromChain: taskEconomyChain,
    toChain: taskEconomyChain,
    taskRunId,
    activityTxId: result?.payload?.activityTxId || null,
  };
});

// ── EXEC_YIELD_MOVE ───────────────────────────────────────────────────────────
registerTaskProcessor('EXEC_YIELD_MOVE', 2, async (job) => {
  const { agentId, params = {} } = job.data;
  const guard = await _paidTaskGuard(agentId);
  if (!guard.ok) return guard;
  const { agent } = guard;

  const result = await agenticTaskExecutionService.executeYieldMoveTask({
    agent,
    params,
    dryRun: shouldUseDryRun(agent),
  });
  if (!result.ok) return result;

  const storedPayload = await _savePaidTaskResult(agentId, 'EXEC_YIELD_MOVE', result.payload, agent);
  return { ...result, payload: storedPayload };
});

// ── EXEC_ARB ──────────────────────────────────────────────────────────────────
registerPaidTaskProcessor('EXEC_ARB', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeArbTask({
    agent,
    params,
    dryRun,
    pricingPool: _getEurcUsdcCurvePool(),
    swapPool: _getUsdcEurcCurvePool(),
  })
));

// ── EXEC_REBALANCE ────────────────────────────────────────────────────────────
registerPaidTaskProcessor('EXEC_REBALANCE', 2, async ({ agent, params, dryRun }) => (
  agenticTaskExecutionService.executeRebalanceTask({
    agent,
    params,
    dryRun,
  })
));

assertPaidTaskEconomyCoverage();
assertPaidTaskActivityCoverage();

async function scheduleDailyTasks() {
  await ensureTaskCatalogSeeded();
  console.log(`[DAILY_TASKS] Catalog ready — ${DAILY_TASK_TYPES.length} Tier-1 free tasks + ${BUILTIN_TIER2_TASKS.length} Tier-2 paid tasks`);
}

// ── Event listeners ────────────────────────────────────────────────────────────
const registeredQueueHandlers = Object.keys(queue.handlers || {}).sort();
console.log(`[QUEUE] Registered Bull handlers (${registeredQueueHandlers.length})`);
if (VERBOSE_QUEUE_LOGS) {
  console.log(`[QUEUE] Registered Bull handler names: ${registeredQueueHandlers.join(', ')}`);
}
syncBullRedisListenerCaps(registeredQueueHandlers.length);
queue.on('failed',    (job, err) => console.error(`[QUEUE] Job ${job.id} failed:`, err.message));
if (VERBOSE_QUEUE_LOGS) {
  queue.on('completed', (job) => console.log(`[QUEUE] Job ${job.id} completed`));
}

// ── Export the queue for use in indexerService ─────────────────────────────────
module.exports = queue;
module.exports.scheduleMarketAnalysisLoop = scheduleMarketAnalysisLoop;
module.exports.scheduleOracleLoop = scheduleOracleLoop;
module.exports.scheduleDefiLoop   = scheduleDefiLoop;
module.exports.scheduleDailyTasks = scheduleDailyTasks;
module.exports.canQueueManualTasks = canQueueManualTasks;
module.exports.queueManualTask = queueManualTask;
module.exports.runTaskInline = runTaskInline;
module.exports.guardTaskPermission = guardTaskPermission;
module.exports.resumeLocalWorkers = resumeLocalWorkers;
module.exports.pauseLocalWorkers = pauseLocalWorkers;
module.exports.cleanupMalformedActiveDefiLoopJobs = cleanupMalformedActiveDefiLoopJobs;
module.exports.recoverMissingAutoCarryHandoffRuns = recoverMissingAutoCarryHandoffRuns;
module.exports.queueDefiLoopForAgent = queueDefiLoopForAgent;
