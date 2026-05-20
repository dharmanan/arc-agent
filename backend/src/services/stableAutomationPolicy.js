'use strict';

const POLICY_ID = 'stable_usdc_eurc_curve_v1';
const DEFAULT_MAX_TRADE_USDC = 25;
const DEFAULT_MAX_LIQUIDITY_DEPLOY_USDC = 25;
const DEFAULT_MIN_LIQUIDITY_DEPLOY_USDC = 10;
const DEFAULT_TARGET_LP_MIN_USD = 20;
const DEFAULT_TARGET_LP_MAX_USD = 30;
const DEFAULT_MAX_REBALANCE_EURC = 25;
const DEFAULT_MIN_REBALANCE_EURC = 10;
const DEFAULT_MAX_ORACLE_DEVIATION_PCT = 2;
const DEFAULT_MAX_PRICE_IMPACT_PCT = 0.75;
const DEFAULT_MIN_RESERVE_PER_SIDE = 1000;
const DEFAULT_MIN_LP_EXIT_AMOUNT = 0.000001;

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
  positionPresent,
  positionValueUsd,
  targetLpMinUsd,
  targetLpMaxUsd,
  positionBelowTargetBand,
  signalEligible,
  buyEurcFromPool,
  suggestedLiquidityDeployUsdc,
  minLiquidityDeployUsdc,
  suggestedRebalanceAmountEurc,
  minRebalanceEurc,
} = {}) {
  if (positionPresent && positionBelowTargetBand && suggestedLiquidityDeployUsdc < minLiquidityDeployUsdc) {
    return `Stable automation wants to top the LP back into the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band, but deployable USDC is below the minimum ${minLiquidityDeployUsdc} required for a top-up.`;
  }

  if (positionPresent) {
    const positionValueLabel = Number.isFinite(positionValueUsd)
      ? `${normalizeUsdcAmount(positionValueUsd)} USD`
      : 'the current LP value';
    return `Stable automation is holding the existing LP position because ${positionValueLabel} remains inside the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band and pool conditions remain healthy.`;
  }

  if (signalEligible && !buyEurcFromPool && suggestedRebalanceAmountEurc < minRebalanceEurc) {
    return `Stable automation saw a reverse-direction signal, but the wallet does not hold the minimum ${minRebalanceEurc} EURC needed for a rebalance.`;
  }

  if (suggestedLiquidityDeployUsdc < minLiquidityDeployUsdc) {
    return `No swap or rebalance qualified, and deployable USDC is below the minimum ${minLiquidityDeployUsdc} required to open or top up the LP toward the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band.`;
  }

  return 'No stable automation action qualified for this cycle.';
}

function buildSuccessReason({
  operationType,
  amount,
  assetSymbol,
  sizeClamped,
  requestedAmount,
  lpAction,
  targetLpMinUsd,
  targetLpMaxUsd,
} = {}) {
  if (operationType === 'add_liquidity') {
    const actionLabel = lpAction === 'top_up'
      ? `a Curve liquidity top-up for ${amount} ${assetSymbol} to move the LP back toward the ${targetLpMinUsd}-${targetLpMaxUsd} USD target band`
      : `a Curve liquidity add for ${amount} ${assetSymbol}`;
    return `Stable automation policy v1 approved ${actionLabel}${sizeClamped ? ` after clamping from ${requestedAmount} USDC` : ''}.`;
  }
  if (operationType === 'remove_liquidity') {
    if (lpAction === 'trim_to_target') {
      return `Stable automation policy v1 approved a partial Curve LP trim of ${amount} ${assetSymbol} to bring exposure back under the ${targetLpMaxUsd} USD target cap.`;
    }
    return `Stable automation policy v1 approved a defensive Curve LP exit for ${amount} ${assetSymbol}.`;
  }
  if (operationType === 'rebalance') {
    return `Stable automation policy v1 approved a ${assetSymbol} -> USDC rebalance for ${amount} ${assetSymbol}${sizeClamped ? ` after clamping from ${requestedAmount} EURC` : ''}.`;
  }

  return `Stable automation policy v1 approved the verified Curve USDC -> EURC route for ${amount} ${assetSymbol}${sizeClamped ? ` after clamping from ${requestedAmount} USDC` : ''}.`;
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
  const configuredTargetLpMinUsd = readPositiveNumberEnv(
    'STABLE_AUTOMATION_TARGET_LP_MIN_USD',
    DEFAULT_TARGET_LP_MIN_USD,
  );
  const configuredTargetLpMaxUsd = readPositiveNumberEnv(
    'STABLE_AUTOMATION_TARGET_LP_MAX_USD',
    DEFAULT_TARGET_LP_MAX_USD,
  );
  const minLiquidityDeployUsdc = readPositiveNumberEnv(
    'STABLE_AUTOMATION_MIN_LIQUIDITY_DEPLOY_USDC',
    DEFAULT_MIN_LIQUIDITY_DEPLOY_USDC,
  );
  const maxRebalanceEurc = readPositiveNumberEnv(
    'STABLE_AUTOMATION_MAX_REBALANCE_EURC',
    DEFAULT_MAX_REBALANCE_EURC,
  );
  const minRebalanceEurc = readPositiveNumberEnv(
    'STABLE_AUTOMATION_MIN_REBALANCE_EURC',
    DEFAULT_MIN_REBALANCE_EURC,
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
  const targetLpMinUsd = normalizeUsdcAmount(configuredTargetLpMinUsd);
  const targetLpMaxUsd = normalizeUsdcAmount(Math.max(configuredTargetLpMaxUsd, targetLpMinUsd));
  const suggestedRebalanceAmountEurc = normalizeUsdcAmount(Math.min(availableEurcBalance, maxRebalanceEurc));
  const positionLpBalance = toFiniteNumber(position?.lpToken?.balance) || 0;
  const positionPresent = positionLpBalance > 0;
  const positionValueUsd = normalizeUsdcAmount(toFiniteNumber(position?.valuation?.totalUsd));
  const positionBelowTargetBand = positionPresent && positionValueUsd > 0 && positionValueUsd < targetLpMinUsd;
  const positionAboveTargetBand = positionPresent && positionValueUsd > targetLpMaxUsd;
  const targetLiquidityGapUsdc = normalizeUsdcAmount(
    positionPresent
      ? Math.max(targetLpMaxUsd - positionValueUsd, 0)
      : targetLpMaxUsd,
  );
  const suggestedLiquidityDeployUsdc = normalizeUsdcAmount(
    Math.min(deployableUsdcBalance, configuredMaxLiquidityDeployUsdc, targetLiquidityGapUsdc),
  );
  const observedSwapPriceImpactPct = selectObservedPriceImpactPct(suggestedAmountUsdc, poolState?.priceImpact);
  const observedLiquidityDeployImpactPct = selectObservedPriceImpactPct(suggestedLiquidityDeployUsdc, poolState?.priceImpact);
  const observedRebalanceImpactPct = selectObservedPriceImpactPct(suggestedRebalanceAmountEurc, poolState?.priceImpact);
  const exitObservedPriceImpactPct = toFiniteNumber(poolState?.priceImpact?.swap1k);
  const minReservePerSide = readPositiveNumberEnv('STABLE_AUTOMATION_MIN_RESERVE_PER_SIDE', DEFAULT_MIN_RESERVE_PER_SIDE);
  const maxOracleDeviationPct = readPositiveNumberEnv('STABLE_AUTOMATION_MAX_ORACLE_DEVIATION_PCT', DEFAULT_MAX_ORACLE_DEVIATION_PCT);
  const maxPriceImpactPct = readPositiveNumberEnv('STABLE_AUTOMATION_MAX_PRICE_IMPACT_PCT', DEFAULT_MAX_PRICE_IMPACT_PCT);
  const allowFallbackForex = process.env.STABLE_AUTOMATION_ALLOW_FALLBACK_FOREX === 'true';
  const buyEurcFromPool = forexRateNumeric != null && poolRateNumeric != null && poolRateNumeric < forexRateNumeric;
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
  const liveForex = allowFallbackForex || forexRate?.isFallback !== true;
  const liquidityActive = String(poolState?.liquidityState || '').toLowerCase() === 'active';
  const reserveDepthHealthy = Number(poolState?.reserves?.token0 || 0) >= minReservePerSide
    && Number(poolState?.reserves?.token1 || 0) >= minReservePerSide;
  const oracleDeviationWithinBand = oracleDeviationPct != null && oracleDeviationPct <= maxOracleDeviationPct;
  const swapPriceImpactWithinBand = observedSwapPriceImpactPct != null && observedSwapPriceImpactPct <= maxPriceImpactPct;
  const addLiquidityPriceImpactWithinBand = observedLiquidityDeployImpactPct != null && observedLiquidityDeployImpactPct <= maxPriceImpactPct;
  const rebalancePriceImpactWithinBand = observedRebalanceImpactPct != null && observedRebalanceImpactPct <= maxPriceImpactPct;
  const hardExitRiskTriggered = positionPresent && (
    !liveForex
      || !liquidityActive
      || !reserveDepthHealthy
      || !oracleDeviationWithinBand
      || !(exitObservedPriceImpactPct != null && exitObservedPriceImpactPct <= maxPriceImpactPct)
  );
  const bandTrimTriggered = positionPresent && !hardExitRiskTriggered && positionAboveTargetBand;
  const exitRiskTriggered = hardExitRiskTriggered || bandTrimTriggered;
  const suggestedLpExitValueUsd = normalizeUsdcAmount(
    !positionPresent
      ? 0
      : hardExitRiskTriggered
        ? positionValueUsd
        : Math.max(positionValueUsd - targetLpMaxUsd, 0),
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
  } else if (!positionPresent && signalEligible && buyEurcFromPool) {
    operationType = 'swap';
  } else if (!positionPresent && !buyEurcFromPool && suggestedRebalanceAmountEurc >= minRebalanceEurc) {
    operationType = 'rebalance';
  } else if (!positionPresent && suggestedLiquidityDeployUsdc >= minLiquidityDeployUsdc) {
    operationType = 'add_liquidity';
  }

  const actionChecks = {
    swap: {
      routeVerified: buildCheck(
        routeVerified,
        'Only the verified Curve USDC -> EURC stable route is eligible for automation.',
      ),
      liveForex: buildCheck(
        liveForex,
        'Automation requires a live forex rate and does not trade on fallback FX data by default.',
      ),
      directionVerified: buildCheck(
        buyEurcFromPool,
        'Automation only buys EURC from the Curve pool. Reverse-direction trades stay manual.',
      ),
      signalEligible: buildCheck(
        signalEligible,
        'The deterministic signal must remain profitable with at least medium confidence.',
      ),
      liquidityActive: buildCheck(
        liquidityActive,
        'The stable pool must report active liquidity before automation can trade.',
      ),
      reserveDepth: buildCheck(
        reserveDepthHealthy,
        `Both stable reserves must stay above ${minReservePerSide} before automation can trade.`,
      ),
      sizePositive: buildCheck(
        suggestedAmountUsdc > 0,
        'The requested automation size must remain above zero after policy sizing caps.',
      ),
      oracleDeviation: buildCheck(
        oracleDeviationWithinBand,
        `Pool/forex deviation must stay within ${maxOracleDeviationPct}% to avoid stale or broken executions.`,
      ),
      priceImpact: buildCheck(
        swapPriceImpactWithinBand,
        `Observed Curve price impact must stay within ${maxPriceImpactPct}% for the sized trade.`,
      ),
    },
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
    rebalance: {
      routeVerified: buildCheck(
        routeVerified,
        'Only the verified Curve EURC -> USDC stable route is eligible for automated rebalances.',
      ),
      liveForex: buildCheck(
        liveForex,
        'Automation requires a live forex rate before rebalancing stable inventory.',
      ),
      noExistingPosition: buildCheck(
        !positionPresent,
        'Automation only rebalances wallet inventory when no stable LP position is open.',
      ),
      reverseDirection: buildCheck(
        !buyEurcFromPool,
        'Stable inventory rebalance only runs when Curve pricing favors rotating EURC back into USDC.',
      ),
      liquidityActive: buildCheck(
        liquidityActive,
        'The stable pool must report active liquidity before automation can rebalance inventory.',
      ),
      reserveDepth: buildCheck(
        reserveDepthHealthy,
        `Both stable reserves must stay above ${minReservePerSide} before automation can rebalance inventory.`,
      ),
      rebalanceSizePositive: buildCheck(
        suggestedRebalanceAmountEurc >= minRebalanceEurc,
        `Wallet EURC balance must stay above ${minRebalanceEurc} before automation can rebalance.`,
      ),
      oracleDeviation: buildCheck(
        oracleDeviationWithinBand,
        `Pool/forex deviation must stay within ${maxOracleDeviationPct}% before automation can rebalance inventory.`,
      ),
      priceImpact: buildCheck(
        rebalancePriceImpactWithinBand,
        `Observed Curve price impact must stay within ${maxPriceImpactPct}% for the proposed rebalance.`,
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
      lpExitSizePositive: buildCheck(
        Number(suggestedLpExitAmount) >= minLpExitAmount,
        `LP balance must stay above ${minLpExitAmount} before automation can remove liquidity.`,
      ),
    },
  };

  const operationChecks = operationType ? actionChecks[operationType] : null;
  const firstFailedCheck = operationChecks ? getFirstFailedCheck(operationChecks) : null;
  const execute = Boolean(operationType) && !firstFailedCheck;
  const sizeClamped = requestedAmount > suggestedAmountUsdc;
  const actionAmount = operationType === 'add_liquidity'
    ? suggestedLiquidityDeployUsdc
    : operationType === 'rebalance'
      ? suggestedRebalanceAmountEurc
      : operationType === 'remove_liquidity'
        ? suggestedLpExitAmount
        : suggestedAmountUsdc;
  const actionAssetSymbol = operationType === 'rebalance'
    ? 'EURC'
    : operationType === 'remove_liquidity'
      ? 'LP'
      : 'USDC';
  const actionParams = execute
    ? (operationType === 'add_liquidity'
      ? {
          tokenIn: 'USDC',
          amountIn: String(suggestedLiquidityDeployUsdc),
          lpAction,
          targetMinUsd: targetLpMinUsd,
          targetMaxUsd: targetLpMaxUsd,
        }
      : operationType === 'remove_liquidity'
        ? {
            lpAmount: suggestedLpExitAmount,
            mode: 'single',
            tokenOut: 'USDC',
            lpAction,
            expectedValueUsd: suggestedLpExitValueUsd,
            targetMaxUsd: targetLpMaxUsd,
          }
        : operationType === 'rebalance'
          ? {
              fromToken: 'EURC',
              toToken: 'USDC',
              amountIn: String(suggestedRebalanceAmountEurc),
            }
          : {
              fromToken: 'USDC',
              toToken: 'EURC',
              amountIn: String(suggestedAmountUsdc),
            })
    : null;

  return {
    policyId: POLICY_ID,
    verdict: {
      execute,
      operationType,
      reason: execute
        ? buildSuccessReason({
            operationType,
            amount: actionAmount,
            assetSymbol: actionAssetSymbol,
            sizeClamped,
            requestedAmount,
            lpAction,
            targetLpMinUsd,
            targetLpMaxUsd,
          })
        : operationChecks && firstFailedCheck
          ? `Stable automation policy v1 blocked execution: ${firstFailedCheck[1].detail}`
          : buildHoldReason({
              positionPresent,
              positionValueUsd,
              targetLpMinUsd,
              targetLpMaxUsd,
              positionBelowTargetBand,
              signalEligible,
              buyEurcFromPool,
              suggestedLiquidityDeployUsdc,
              minLiquidityDeployUsdc,
              suggestedRebalanceAmountEurc,
              minRebalanceEurc,
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
      suggestedRebalanceAmountEurc,
      suggestedLpExitAmount,
      suggestedLpExitValueUsd,
      suggestedLpExitFraction,
      targetLpMinUsd,
      targetLpMaxUsd,
      targetLiquidityGapUsdc,
      sizeClamped,
      effectiveMaxTradeUsdc,
      walletReserveUsdc,
      availableUsdcBalance,
      availableEurcBalance,
      deployableUsdcBalance,
      positionPresent,
      positionLpBalance,
      positionValueUsd,
      positionBelowTargetBand,
      positionAboveTargetBand,
      exitRiskTriggered,
      hardExitRiskTriggered,
      bandTrimTriggered,
      lpAction,
      oracleDeviationPct,
      observedSwapPriceImpactPct,
      observedLiquidityDeployImpactPct,
      observedRebalanceImpactPct,
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