'use strict';

const POLICY_ID = 'stable_usdc_eurc_lp_manager_v2';
const DEFAULT_MAX_TRADE_USDC = 25;
const DEFAULT_MAX_LIQUIDITY_DEPLOY_USDC = 25;
const DEFAULT_MIN_LIQUIDITY_DEPLOY_USDC = 10;
const DEFAULT_TARGET_LP_ALLOCATION_PCT = 25;
const DEFAULT_TARGET_LP_MIN_ALLOCATION_PCT = 20;
const DEFAULT_TARGET_LP_MAX_ALLOCATION_PCT = 30;
const DEFAULT_MAX_REBALANCE_EURC = 25;
const DEFAULT_MIN_REBALANCE_EURC = 10;
const DEFAULT_MAX_ORACLE_DEVIATION_PCT = 2;
const DEFAULT_HARD_EXIT_ORACLE_DEVIATION_PCT = 12;
const DEFAULT_MAX_PRICE_IMPACT_PCT = 0.75;
const DEFAULT_MIN_RESERVE_PER_SIDE = 1000;
const DEFAULT_MIN_LP_EXIT_AMOUNT = 0.000001;
const DEFAULT_MARKET_SIGNAL_MAX_AGE_MINUTES = 360;

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

function normalizeLpAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function clampFiniteNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
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

function isFreshIsoTimestamp(value, maxAgeMs) {
  if (!value || !(maxAgeMs > 0)) return false;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return (Date.now() - timestamp) <= maxAgeMs;
}

function isFutureIsoTimestamp(value) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return timestamp > Date.now();
}

function resolveAllocationProfile({
  marketAnalysis,
  stableCapitalUsd,
} = {}) {
  const configuredTargetPct = clampFiniteNumber(
    process.env.STABLE_AUTOMATION_TARGET_LP_ALLOCATION_PCT,
    1,
    100,
    DEFAULT_TARGET_LP_ALLOCATION_PCT,
  );
  const configuredMinPct = clampFiniteNumber(
    process.env.STABLE_AUTOMATION_MIN_LP_ALLOCATION_PCT,
    1,
    100,
    DEFAULT_TARGET_LP_MIN_ALLOCATION_PCT,
  );
  const configuredMaxPct = clampFiniteNumber(
    process.env.STABLE_AUTOMATION_MAX_LP_ALLOCATION_PCT,
    configuredMinPct,
    100,
    DEFAULT_TARGET_LP_MAX_ALLOCATION_PCT,
  );

  let minPct = configuredMinPct;
  let maxPct = configuredMaxPct;
  let targetPct = clampFiniteNumber(
    configuredTargetPct,
    minPct,
    maxPct,
    Math.min(Math.max(configuredTargetPct, minPct), maxPct),
  );
  let source = 'policy_default';
  let signalFresh = false;

  const maxAgeMinutes = clampFiniteNumber(
    process.env.STABLE_AUTOMATION_MARKET_SIGNAL_MAX_AGE_MINUTES,
    1,
    1440,
    DEFAULT_MARKET_SIGNAL_MAX_AGE_MINUTES,
  );
  const signal = marketAnalysis?.signal && typeof marketAnalysis.signal === 'object'
    ? marketAnalysis.signal
    : null;

  if (signal && String(signal.lane || '').toLowerCase() === 'stable_curve') {
    signalFresh = isFreshIsoTimestamp(marketAnalysis?.recordedAt, maxAgeMinutes * 60_000);
    if (signalFresh) {
      minPct = clampFiniteNumber(signal.stableLpMinAllocationPct, 1, 100, minPct);
      maxPct = clampFiniteNumber(signal.stableLpMaxAllocationPct, minPct, 100, maxPct);
      targetPct = clampFiniteNumber(
        signal.stableLpTargetAllocationPct,
        minPct,
        maxPct,
        clampFiniteNumber(targetPct, minPct, maxPct, targetPct),
      );
      source = `market_analysis:${marketAnalysis?.engine || 'unknown'}`;
    }
  }

  const normalizedStableCapitalUsd = normalizeUsdcAmount(stableCapitalUsd);
  const targetUsd = normalizeUsdcAmount(normalizedStableCapitalUsd * (targetPct / 100));
  const minUsd = normalizeUsdcAmount(normalizedStableCapitalUsd * (minPct / 100));
  const maxUsd = normalizeUsdcAmount(normalizedStableCapitalUsd * (maxPct / 100));

  return {
    minPct,
    maxPct,
    targetPct,
    minUsd,
    maxUsd,
    targetUsd,
    source,
    signalFresh,
  };
}

function buildHoldReason({
  positionPresent,
  positionValueUsd,
  targetLpMinUsd,
  targetLpMaxUsd,
  positionBelowTargetBand,
  suggestedLiquidityDeployUsdc,
  minLiquidityDeployUsdc,
} = {}) {
  if (positionPresent && positionBelowTargetBand && suggestedLiquidityDeployUsdc < minLiquidityDeployUsdc) {
    return `Stable LP manager wants to top the position back into the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band, but deployable USDC is below the minimum ${minLiquidityDeployUsdc} required for a top-up.`;
  }

  if (positionPresent) {
    const positionValueLabel = Number.isFinite(positionValueUsd)
      ? `${normalizeUsdcAmount(positionValueUsd)} USD`
      : 'the current LP value';
    return `Stable LP manager is holding the existing position because ${positionValueLabel} remains inside the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band and pool conditions remain healthy.`;
  }

  if (suggestedLiquidityDeployUsdc < minLiquidityDeployUsdc) {
    return `Stable LP manager did not open or top up the position because deployable USDC is below the minimum ${minLiquidityDeployUsdc} required to reach the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band.`;
  }

  return 'No stable LP management action qualified for this cycle.';
}

function buildSuccessReason({
  operationType,
  amount,
  assetSymbol,
  lpAction,
  targetLpMinUsd,
  targetLpMaxUsd,
} = {}) {
  if (operationType === 'add_liquidity') {
    const actionLabel = lpAction === 'top_up'
      ? `a Curve liquidity top-up for ${amount} ${assetSymbol} to move the LP back toward the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band`
      : `a Curve liquidity add for ${amount} ${assetSymbol}`;
    return `Stable LP manager v2 approved ${actionLabel}.`;
  }
  if (operationType === 'remove_liquidity') {
    if (lpAction === 'trim_to_target') {
      return `Stable LP manager v2 approved a partial Curve LP trim of ${amount} ${assetSymbol} to bring exposure back under the ${targetLpMaxUsd} USD target cap.`;
    }
    return `Stable LP manager v2 approved a defensive Curve LP exit for ${amount} ${assetSymbol}.`;
  }

  return `Stable LP manager v2 approved ${amount} ${assetSymbol}.`;
}

function evaluateStableAutomationPolicy({
  agent,
  forexRate,
  poolState,
  signal,
  pricingPool,
  swapPool,
  requestedAmountUsdc,
  walletBalances,
  walletReserveUsdc: walletReserveUsdcInput,
  position,
  marketAnalysis,
  manualCooldownUntil,
} = {}) {
  const requestedAmount = normalizeUsdcAmount(requestedAmountUsdc);
  const agentMaxTradeUsdc = toFiniteNumber(agent?.max_trade_usdc);
  const configuredMaxTradeUsdc = readPositiveNumberEnv('STABLE_AUTOMATION_MAX_TRADE_USDC', DEFAULT_MAX_TRADE_USDC);
  const effectiveMaxTradeUsdc = normalizeUsdcAmount(
    agentMaxTradeUsdc > 0
      ? Math.min(configuredMaxTradeUsdc, agentMaxTradeUsdc)
      : configuredMaxTradeUsdc,
  );
  const suggestedAmountUsdc = normalizeUsdcAmount(
    requestedAmount > 0
      ? Math.min(requestedAmount, effectiveMaxTradeUsdc)
      : 0,
  );
  const configuredMaxLiquidityDeployUsdc = readPositiveNumberEnv(
    'STABLE_AUTOMATION_MAX_LIQUIDITY_DEPLOY_USDC',
    DEFAULT_MAX_LIQUIDITY_DEPLOY_USDC,
  );
  const minLiquidityDeployUsdc = readPositiveNumberEnv(
    'STABLE_AUTOMATION_MIN_LIQUIDITY_DEPLOY_USDC',
    DEFAULT_MIN_LIQUIDITY_DEPLOY_USDC,
  );
  const minLpExitAmount = readPositiveNumberEnv(
    'STABLE_AUTOMATION_MIN_LP_EXIT_AMOUNT',
    DEFAULT_MIN_LP_EXIT_AMOUNT,
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
  const positionLpBalance = toFiniteNumber(position?.lpToken?.balance) || 0;
  const positionPresent = positionLpBalance > 0;
  const positionValueUsd = normalizeUsdcAmount(toFiniteNumber(position?.valuation?.totalUsd));
  const totalStableCapitalUsd = normalizeUsdcAmount(deployableUsdcBalance + availableEurcBalance + positionValueUsd);
  const allocationProfile = resolveAllocationProfile({
    marketAnalysis,
    stableCapitalUsd: totalStableCapitalUsd,
  });
  const targetLpMinUsd = allocationProfile.minUsd;
  const targetLpMaxUsd = allocationProfile.maxUsd;
  const targetLpTargetUsd = allocationProfile.targetUsd;
  const positionBelowTargetBand = positionPresent && positionValueUsd > 0 && positionValueUsd < targetLpMinUsd;
  const positionAboveTargetBand = positionPresent && positionValueUsd > targetLpMaxUsd;
  const positionAllocationPct = totalStableCapitalUsd > 0
    ? normalizeUsdcAmount((positionValueUsd / totalStableCapitalUsd) * 100)
    : 0;
  const targetLiquidityGapUsdc = normalizeUsdcAmount(
    positionPresent
      ? Math.max(targetLpTargetUsd - positionValueUsd, 0)
      : targetLpTargetUsd,
  );
  const suggestedLiquidityDeployUsdc = normalizeUsdcAmount(
    Math.min(deployableUsdcBalance, configuredMaxLiquidityDeployUsdc, targetLiquidityGapUsdc),
  );
  const observedLiquidityDeployImpactPct = selectObservedPriceImpactPct(suggestedLiquidityDeployUsdc, poolState?.priceImpact);
  const exitObservedPriceImpactPct = toFiniteNumber(poolState?.priceImpact?.swap1k);
  const minReservePerSide = readPositiveNumberEnv('STABLE_AUTOMATION_MIN_RESERVE_PER_SIDE', DEFAULT_MIN_RESERVE_PER_SIDE);
  const maxOracleDeviationPct = readPositiveNumberEnv('STABLE_AUTOMATION_MAX_ORACLE_DEVIATION_PCT', DEFAULT_MAX_ORACLE_DEVIATION_PCT);
  const hardExitOracleDeviationPct = readPositiveNumberEnv(
    'STABLE_AUTOMATION_HARD_EXIT_ORACLE_DEVIATION_PCT',
    DEFAULT_HARD_EXIT_ORACLE_DEVIATION_PCT,
  );
  const maxPriceImpactPct = readPositiveNumberEnv('STABLE_AUTOMATION_MAX_PRICE_IMPACT_PCT', DEFAULT_MAX_PRICE_IMPACT_PCT);
  const allowFallbackForex = process.env.STABLE_AUTOMATION_ALLOW_FALLBACK_FOREX === 'true';
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
  const liveForex = allowFallbackForex || forexRate?.isFallback !== true;
  const liquidityActive = String(poolState?.liquidityState || '').toLowerCase() === 'active';
  const reserveDepthHealthy = Number(poolState?.reserves?.token0 || 0) >= minReservePerSide
    && Number(poolState?.reserves?.token1 || 0) >= minReservePerSide;
  const oracleDeviationWithinBand = oracleDeviationPct != null && oracleDeviationPct <= maxOracleDeviationPct;
  const oracleDeviationHardBreach = oracleDeviationPct != null && oracleDeviationPct > hardExitOracleDeviationPct;
  const addLiquidityPriceImpactWithinBand = observedLiquidityDeployImpactPct != null && observedLiquidityDeployImpactPct <= maxPriceImpactPct;
  const hardExitRiskTriggered = positionPresent && (
    !liveForex
      || !liquidityActive
      || !reserveDepthHealthy
      || oracleDeviationHardBreach
      || !(exitObservedPriceImpactPct != null && exitObservedPriceImpactPct <= maxPriceImpactPct)
  );
  const manualCooldownActive = isFutureIsoTimestamp(manualCooldownUntil);
  const bandTrimTriggered = positionPresent && !hardExitRiskTriggered && positionAboveTargetBand;
  const exitRiskTriggered = hardExitRiskTriggered || bandTrimTriggered;
  const suggestedLpExitValueUsd = normalizeUsdcAmount(
    !positionPresent
      ? 0
      : hardExitRiskTriggered
        ? positionValueUsd
        : Math.max(positionValueUsd - targetLpTargetUsd, 0),
  );
  const suggestedLpExitFraction = positionPresent && positionValueUsd > 0
    ? Math.min(Math.max(suggestedLpExitValueUsd / positionValueUsd, 0), 1)
    : 0;
  const suggestedLpExitAmount = positionPresent
    ? (hardExitRiskTriggered
      ? String(position?.lpToken?.balance || '0')
      : String(normalizeLpAmount(positionLpBalance * suggestedLpExitFraction)))
    : '0';
  const lpAction = hardExitRiskTriggered
    ? 'full_exit'
    : bandTrimTriggered
      ? 'trim_to_target'
      : positionBelowTargetBand
        ? 'top_up'
        : null;

  let operationType = null;
  if (positionPresent && exitRiskTriggered) {
    operationType = 'remove_liquidity';
  } else if (positionPresent && positionBelowTargetBand && suggestedLiquidityDeployUsdc >= minLiquidityDeployUsdc) {
    operationType = 'add_liquidity';
  } else if (!positionPresent && suggestedLiquidityDeployUsdc >= minLiquidityDeployUsdc) {
    operationType = 'add_liquidity';
  }

  const actionChecks = {
    add_liquidity: {
      routeVerified: buildCheck(
        routeVerified,
        'Only the verified Curve USDC/EURC pool is eligible for automated liquidity adds.',
      ),
      liveForex: buildCheck(
        liveForex,
        'Automation requires a live forex rate before opening a stable LP position.',
      ),
      targetBandNeedsLiquidity: buildCheck(
        !positionPresent || positionBelowTargetBand,
        `Automation only adds LP when opening a new position or topping an underweight one back into the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band.`,
      ),
      liquidityActive: buildCheck(
        liquidityActive,
        'The stable pool must report active liquidity before automation can add LP.',
      ),
      reserveDepth: buildCheck(
        reserveDepthHealthy,
        `Both stable reserves must stay above ${minReservePerSide} before automation can add LP.`,
      ),
      addSizePositive: buildCheck(
        suggestedLiquidityDeployUsdc >= minLiquidityDeployUsdc,
        `Deployable USDC must stay above ${minLiquidityDeployUsdc} before automation can add LP.`,
      ),
      oracleDeviation: buildCheck(
        oracleDeviationWithinBand,
        `Pool/forex deviation must stay within ${maxOracleDeviationPct}% before automation can add LP.`,
      ),
      priceImpact: buildCheck(
        addLiquidityPriceImpactWithinBand,
        `Observed Curve price impact must stay within ${maxPriceImpactPct}% for the proposed LP add.`,
      ),
    },
    remove_liquidity: {
      routeVerified: buildCheck(
        routeVerified,
        'Only the verified Curve USDC/EURC pool is eligible for automated LP exits.',
      ),
      exitRequired: buildCheck(
        exitRiskTriggered,
        `Automation only removes LP when pool safety checks fail or the position rises above the ${targetLpMaxUsd} USD target cap.`,
      ),
      positionPresent: buildCheck(
        positionPresent,
        'A stable LP position must exist before automation can remove liquidity.',
      ),
      manualCooldown: buildCheck(
        !manualCooldownActive || hardExitRiskTriggered,
        manualCooldownUntil
          ? `A recent manual stable LP add is still in cooldown until ${manualCooldownUntil}. Only hard-risk exits are allowed during this window.`
          : 'A recent manual stable LP add is still in cooldown. Only hard-risk exits are allowed during this window.',
      ),
      lpExitSizePositive: buildCheck(
        Number(suggestedLpExitAmount) >= minLpExitAmount,
        `LP balance must stay above ${minLpExitAmount} before automation can remove liquidity.`,
      ),
    },
  };

  const operationChecks = operationType ? actionChecks[operationType] : null;
  const firstFailedCheck = operationChecks ? getFirstFailedCheck(operationChecks) : null;
  const execute = Boolean(operationType) && !firstFailedCheck;
  const actionAmount = operationType === 'add_liquidity'
    ? suggestedLiquidityDeployUsdc
    : operationType === 'remove_liquidity'
      ? suggestedLpExitAmount
      : suggestedAmountUsdc;
  const actionAssetSymbol = operationType === 'remove_liquidity'
      ? 'LP'
      : 'USDC';
  const actionParams = execute
    ? (operationType === 'add_liquidity'
      ? {
          tokenIn: 'USDC',
          amountIn: String(suggestedLiquidityDeployUsdc),
          lpAction,
          targetMinUsd: targetLpMinUsd,
          targetUsd: targetLpTargetUsd,
          targetMaxUsd: targetLpMaxUsd,
        }
      : operationType === 'remove_liquidity'
        ? {
            lpAmount: suggestedLpExitAmount,
            mode: 'single',
            tokenOut: 'USDC',
            lpAction,
            expectedValueUsd: suggestedLpExitValueUsd,
            targetUsd: targetLpTargetUsd,
            targetMaxUsd: targetLpMaxUsd,
          }
        : null)
    : null;

  return {
    policyId: POLICY_ID,
    verdict: {
      lane: 'stable_curve_lp',
      execute,
      operationType,
      reason: execute
        ? buildSuccessReason({
            operationType,
            amount: actionAmount,
            assetSymbol: actionAssetSymbol,
            lpAction,
            targetLpMinUsd,
            targetLpMaxUsd,
          })
        : operationChecks && firstFailedCheck
          ? `Stable LP manager v2 blocked execution: ${firstFailedCheck[1].detail}`
          : buildHoldReason({
              positionPresent,
              positionValueUsd,
              targetLpMinUsd,
              targetLpMaxUsd,
              positionBelowTargetBand,
              suggestedLiquidityDeployUsdc,
              minLiquidityDeployUsdc,
            }),
      suggestedAmountUsdc: execute
        ? operationType === 'remove_liquidity'
          ? suggestedLpExitValueUsd
          : normalizeUsdcAmount(actionAmount)
        : 0,
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
      suggestedAmountUsdc,
      suggestedLiquidityDeployUsdc,
      suggestedLpExitAmount,
      suggestedLpExitValueUsd,
      suggestedLpExitFraction,
      totalStableCapitalUsd,
      targetLpMinUsd,
      targetLpTargetUsd,
      targetLpMaxUsd,
      targetLpMinAllocationPct: allocationProfile.minPct,
      targetLpTargetAllocationPct: allocationProfile.targetPct,
      targetLpMaxAllocationPct: allocationProfile.maxPct,
      targetLpAllocationSource: allocationProfile.source,
      marketSignalFresh: allocationProfile.signalFresh,
      manualCooldownUntil: manualCooldownUntil || null,
      manualCooldownActive,
      targetLiquidityGapUsdc,
      effectiveMaxTradeUsdc,
      walletReserveUsdc,
      availableUsdcBalance,
      availableEurcBalance,
      deployableUsdcBalance,
      positionPresent,
      positionLpBalance,
      positionValueUsd,
      positionAllocationPct,
      positionBelowTargetBand,
      positionAboveTargetBand,
      exitRiskTriggered,
      hardExitRiskTriggered,
      bandTrimTriggered,
      lpAction,
      oracleDeviationPct,
      oracleDeviationHardBreach,
      hardExitOracleDeviationPct,
      observedLiquidityDeployImpactPct,
      exitObservedPriceImpactPct,
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
  evaluateStableAutomationPolicy,
};