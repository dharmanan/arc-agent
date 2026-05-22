'use strict';

const POLICY_ID = 'oracle_stable_curve_strategy_v1';
const DEFAULT_MAX_TRADE_USDC = 25;
const DEFAULT_MAX_REBALANCE_EURC = 25;
const DEFAULT_MIN_REBALANCE_EURC = 10;
const DEFAULT_MAX_PRICE_IMPACT_PCT = 0.75;
const DEFAULT_MIN_RESERVE_PER_SIDE = 1000;

function readPositiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeUsdcAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function selectObservedPriceImpactPct(amountUsdc, priceImpact = {}) {
  const normalizedAmountUsdc = toFiniteNumber(amountUsdc);
  if (!(normalizedAmountUsdc > 0)) return null;

  if (normalizedAmountUsdc <= 1_000) return toFiniteNumber(priceImpact.swap1k);
  if (normalizedAmountUsdc <= 10_000) return toFiniteNumber(priceImpact.swap10k);
  if (normalizedAmountUsdc <= 50_000) return toFiniteNumber(priceImpact.swap50k);
  return null;
}

function buildCheck(passed, detail) {
  return {
    passed: Boolean(passed),
    detail,
  };
}

function getFirstFailedCheck(checks) {
  return Object.entries(checks).find(([, value]) => value?.passed !== true) || null;
}

function buildHoldReason({
  buyEurcFromPool,
  signalEligible,
  executionGateApproved,
  suggestedSwapAmountUsdc,
  suggestedRebalanceAmountEurc,
  minRebalanceEurc,
} = {}) {
  if (buyEurcFromPool && !signalEligible) {
    return 'Oracle strategy lane held because the current EURC discount signal is not profitable enough to trade.';
  }

  if (buyEurcFromPool && !executionGateApproved) {
    return 'Oracle strategy lane held because the advisory execution gate kept this opportunity in HOLD.';
  }

  if (buyEurcFromPool && suggestedSwapAmountUsdc <= 0) {
    return 'Oracle strategy lane held because no deployable USDC remained for the Curve entry trade.';
  }

  if (!buyEurcFromPool && suggestedRebalanceAmountEurc < minRebalanceEurc) {
    return `Oracle strategy lane saw reverse pricing, but wallet EURC stayed below the minimum ${minRebalanceEurc} required for a rebalance.`;
  }

  return 'No oracle strategy action qualified for this cycle.';
}

function buildSuccessReason({
  operationType,
  amount,
  assetSymbol,
} = {}) {
  if (operationType === 'rebalance') {
    return `Oracle strategy policy v1 approved a ${assetSymbol} -> USDC rebalance for ${amount} ${assetSymbol}.`;
  }

  return `Oracle strategy policy v1 approved the verified Curve USDC -> EURC route for ${amount} ${assetSymbol}.`;
}

function evaluateOracleStrategyPolicy({
  agent,
  forexRate,
  poolState,
  signal,
  executionGate,
  pricingPool,
  swapPool,
  requestedAmountUsdc,
  walletBalances,
  walletReserveUsdc: walletReserveUsdcInput,
} = {}) {
  const requestedAmount = normalizeUsdcAmount(requestedAmountUsdc);
  const configuredMaxTradeUsdc = readPositiveNumberEnv('ORACLE_STRATEGY_MAX_TRADE_USDC', DEFAULT_MAX_TRADE_USDC);
  const configuredMaxRebalanceEurc = readPositiveNumberEnv('ORACLE_STRATEGY_MAX_REBALANCE_EURC', DEFAULT_MAX_REBALANCE_EURC);
  const minRebalanceEurc = readPositiveNumberEnv('ORACLE_STRATEGY_MIN_REBALANCE_EURC', DEFAULT_MIN_REBALANCE_EURC);
  const agentMaxTradeUsdc = toFiniteNumber(agent?.max_trade_usdc);
  const effectiveMaxTradeUsdc = normalizeUsdcAmount(
    agentMaxTradeUsdc > 0
      ? Math.min(configuredMaxTradeUsdc, agentMaxTradeUsdc)
      : configuredMaxTradeUsdc,
  );

  const forexRateNumeric = toFiniteNumber(forexRate?.rate);
  const poolRateNumeric = toFiniteNumber(poolState?.impliedRate);
  const oracleDeviationPct = forexRateNumeric > 0 && poolRateNumeric != null
    ? Math.abs((poolRateNumeric - forexRateNumeric) / forexRateNumeric) * 100
    : null;
  const walletReserveUsdc = normalizeUsdcAmount(walletReserveUsdcInput);
  const availableUsdcBalance = normalizeUsdcAmount(walletBalances?.usdc);
  const availableEurcBalance = normalizeUsdcAmount(walletBalances?.eurc);
  const deployableUsdcBalance = normalizeUsdcAmount(Math.max(availableUsdcBalance - walletReserveUsdc, 0));
  const gateSuggestedAmountUsdc = normalizeUsdcAmount(executionGate?.verdict?.suggestedAmount);
  const requestedSwapAmountUsdc = gateSuggestedAmountUsdc > 0
    ? gateSuggestedAmountUsdc
    : requestedAmount;
  const suggestedAmountUsdc = normalizeUsdcAmount(
    requestedSwapAmountUsdc > 0
      ? Math.min(requestedSwapAmountUsdc, effectiveMaxTradeUsdc)
      : 0,
  );
  const suggestedSwapAmountUsdc = normalizeUsdcAmount(Math.min(suggestedAmountUsdc, deployableUsdcBalance));
  const suggestedRebalanceAmountEurc = normalizeUsdcAmount(Math.min(availableEurcBalance, configuredMaxRebalanceEurc));
  const observedSwapPriceImpactPct = selectObservedPriceImpactPct(suggestedSwapAmountUsdc, poolState?.priceImpact);
  const observedRebalanceImpactPct = selectObservedPriceImpactPct(suggestedRebalanceAmountEurc, poolState?.priceImpact);
  const maxPriceImpactPct = readPositiveNumberEnv('ORACLE_STRATEGY_MAX_PRICE_IMPACT_PCT', DEFAULT_MAX_PRICE_IMPACT_PCT);
  const minReservePerSide = readPositiveNumberEnv('ORACLE_STRATEGY_MIN_RESERVE_PER_SIDE', DEFAULT_MIN_RESERVE_PER_SIDE);
  const allowFallbackForex = process.env.ORACLE_STRATEGY_ALLOW_FALLBACK_FOREX === 'true';

  const routeVerified = Boolean(
    pricingPool?.protocol === 'curve'
      && pricingPool?.key === 'EURC-USDC'
      && pricingPool?.baseToken?.symbol === 'EURC'
      && pricingPool?.quoteToken?.symbol === 'USDC'
      && swapPool?.protocol === 'curve'
      && swapPool?.key === 'USDC-EURC'
      && swapPool?.baseToken?.symbol === 'USDC'
      && swapPool?.quoteToken?.symbol === 'EURC'
      && swapPool?.address
  );
  const signalEligible = Boolean(
    signal?.opportunity?.found
      && signal?.opportunity?.confidence !== 'LOW'
      && Number(signal?.opportunity?.netProfitUsdc || 0) > 0
  );
  const executionGateApproved = executionGate?.verdict?.execute === true;
  const liveForex = allowFallbackForex || forexRate?.isFallback !== true;
  const liquidityActive = String(poolState?.liquidityState || '').toLowerCase() === 'active';
  const reserveDepthHealthy = Number(poolState?.reserves?.token0 || 0) >= minReservePerSide
    && Number(poolState?.reserves?.token1 || 0) >= minReservePerSide;
  const buyEurcFromPool = forexRateNumeric != null && poolRateNumeric != null && poolRateNumeric < forexRateNumeric;
  const swapPriceImpactWithinBand = observedSwapPriceImpactPct != null && observedSwapPriceImpactPct <= maxPriceImpactPct;
  const rebalancePriceImpactWithinBand = observedRebalanceImpactPct != null && observedRebalanceImpactPct <= maxPriceImpactPct;

  let operationType = null;
  if (buyEurcFromPool && signalEligible && executionGateApproved) {
    operationType = 'swap';
  } else if (!buyEurcFromPool && suggestedRebalanceAmountEurc >= minRebalanceEurc) {
    operationType = 'rebalance';
  }

  const actionChecks = {
    swap: {
      routeVerified: buildCheck(
        routeVerified,
        'Only the verified Curve USDC -> EURC route is eligible for oracle strategy automation.',
      ),
      liveForex: buildCheck(
        liveForex,
        'Oracle strategy automation requires a live forex rate before trading.',
      ),
      directionVerified: buildCheck(
        buyEurcFromPool,
        'Oracle strategy only buys EURC when Curve prices it below the live forex rate.',
      ),
      signalEligible: buildCheck(
        signalEligible,
        'The current signal must remain profitable with at least medium confidence.',
      ),
      executionGate: buildCheck(
        executionGateApproved,
        'The advisory execution gate must explicitly approve this opportunity before the oracle lane trades.',
      ),
      liquidityActive: buildCheck(
        liquidityActive,
        'The stable pool must report active liquidity before oracle strategy automation can trade.',
      ),
      reserveDepth: buildCheck(
        reserveDepthHealthy,
        `Both stable reserves must stay above ${minReservePerSide} before oracle strategy automation can trade.`,
      ),
      sizePositive: buildCheck(
        suggestedSwapAmountUsdc > 0,
        'Deployable USDC must stay above zero after oracle strategy sizing caps.',
      ),
      pricingGapVisible: buildCheck(
        oracleDeviationPct != null,
        'Pool/forex pricing must be measurable before oracle strategy automation can trade.',
      ),
      priceImpact: buildCheck(
        swapPriceImpactWithinBand,
        `Observed Curve price impact must stay within ${maxPriceImpactPct}% for the proposed oracle trade.`,
      ),
    },
    rebalance: {
      routeVerified: buildCheck(
        routeVerified,
        'Only the verified Curve EURC -> USDC route is eligible for oracle strategy rebalances.',
      ),
      liveForex: buildCheck(
        liveForex,
        'Oracle strategy automation requires a live forex rate before rebalancing stable inventory.',
      ),
      reverseDirection: buildCheck(
        !buyEurcFromPool,
        'Oracle strategy rebalances only run when Curve pricing favors rotating EURC back into USDC.',
      ),
      liquidityActive: buildCheck(
        liquidityActive,
        'The stable pool must report active liquidity before oracle strategy automation can rebalance inventory.',
      ),
      reserveDepth: buildCheck(
        reserveDepthHealthy,
        `Both stable reserves must stay above ${minReservePerSide} before oracle strategy automation can rebalance inventory.`,
      ),
      rebalanceSizePositive: buildCheck(
        suggestedRebalanceAmountEurc >= minRebalanceEurc,
        `Wallet EURC balance must stay above ${minRebalanceEurc} before oracle strategy automation can rebalance.`,
      ),
      pricingGapVisible: buildCheck(
        oracleDeviationPct != null,
        'Pool/forex pricing must be measurable before oracle strategy automation can rebalance inventory.',
      ),
      priceImpact: buildCheck(
        rebalancePriceImpactWithinBand,
        `Observed Curve price impact must stay within ${maxPriceImpactPct}% for the proposed oracle rebalance.`,
      ),
    },
  };

  const operationChecks = operationType ? actionChecks[operationType] : null;
  const firstFailedCheck = operationChecks ? getFirstFailedCheck(operationChecks) : null;
  const execute = Boolean(operationType) && !firstFailedCheck;
  const actionAmount = operationType === 'rebalance'
    ? suggestedRebalanceAmountEurc
    : suggestedSwapAmountUsdc;
  const actionAssetSymbol = operationType === 'rebalance' ? 'EURC' : 'USDC';
  const actionParams = execute
    ? (operationType === 'rebalance'
      ? {
          fromToken: 'EURC',
          toToken: 'USDC',
          amountIn: String(suggestedRebalanceAmountEurc),
        }
      : {
          fromToken: 'USDC',
          toToken: 'EURC',
          amountIn: String(suggestedSwapAmountUsdc),
        })
    : null;

  return {
    policyId: POLICY_ID,
    verdict: {
      lane: 'oracle_strategy',
      execute,
      operationType,
      reason: execute
        ? buildSuccessReason({
            operationType,
            amount: actionAmount,
            assetSymbol: actionAssetSymbol,
          })
        : operationChecks && firstFailedCheck
          ? `Oracle strategy policy v1 blocked execution: ${firstFailedCheck[1].detail}`
          : buildHoldReason({
              buyEurcFromPool,
              signalEligible,
              executionGateApproved,
              suggestedSwapAmountUsdc,
              suggestedRebalanceAmountEurc,
              minRebalanceEurc,
            }),
      suggestedAmountUsdc: execute ? normalizeUsdcAmount(actionAmount) : 0,
      actionAssetSymbol,
      actionParams,
      blockedBy: execute
        ? null
        : operationChecks && firstFailedCheck
          ? firstFailedCheck[0]
          : 'no_action',
    },
    metrics: {
      requestedAmountUsdc: requestedAmount,
      gateSuggestedAmountUsdc,
      suggestedAmountUsdc,
      suggestedSwapAmountUsdc,
      suggestedRebalanceAmountEurc,
      executionGateApproved,
      signalEligible,
      buyEurcFromPool,
      walletReserveUsdc,
      availableUsdcBalance,
      availableEurcBalance,
      deployableUsdcBalance,
      oracleDeviationPct,
      observedSwapPriceImpactPct,
      observedRebalanceImpactPct,
      forexRate: forexRateNumeric,
      poolRate: poolRateNumeric,
      forexIsFallback: Boolean(forexRate?.isFallback),
      liquidityState: poolState?.liquidityState || 'unknown',
      reserveToken0: toFiniteNumber(poolState?.reserves?.token0),
      reserveToken1: toFiniteNumber(poolState?.reserves?.token1),
      routeSource: swapPool?.source || null,
      routeAddress: swapPool?.address || null,
    },
    checks: operationChecks || {},
  };
}

module.exports = {
  evaluateOracleStrategyPolicy,
};