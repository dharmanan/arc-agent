'use strict';

const POLICY_ID = 'cirbtc_direct_pair_lp_v1';
const DEFAULT_BOOTSTRAP_MAX_PRICE_IMPACT_PCT = 2.5;
const DEFAULT_EXIT_MAX_PRICE_IMPACT_PCT = 5;
const DEFAULT_MIN_POOL_LIQUIDITY_STABLE_EQ = 10_000;
const DEFAULT_GROWTH_TARGET_LP_MAX_USD = 250;
const DEFAULT_GROWTH_MAX_ADDS_PER_DAY = 2;
const DEFAULT_GROWTH_MIN_INTERVAL_HOURS = 8;

const PAIR_DEFAULTS = {
  USDC: {
    poolKey: 'USDC-CIRBTC',
    minBootstrapAmount: 12,
    maxBootstrapAmount: 20,
    targetLpMaxUsd: 20,
    growthTargetLpMaxUsd: 250,
  },
  EURC: {
    poolKey: 'EURC-CIRBTC',
    minBootstrapAmount: 10,
    maxBootstrapAmount: 16,
    targetLpMaxUsd: 16,
    growthTargetLpMaxUsd: 200,
  },
};

function readPositiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function normalizePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(100, Math.floor(numeric * 1000) / 1000);
}

function normalizeCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.floor(numeric));
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

function buildPairSummary(context, {
  anyPositionPresent = false,
  selectedPoolKey = null,
  execute = false,
  operationType = null,
  lpAction = null,
} = {}) {
  const isSelected = selectedPoolKey === context.poolKey;

  if (context.positionPresent && !context.poolBelowMinLiquidity && (context.hardExitRiskTriggered || context.positionAboveTargetBand)) {
    return {
      poolKey: context.poolKey,
      stableToken: context.stableToken,
      selected: isSelected,
      status: isSelected && execute ? 'executed' : 'exit_ready',
      blockedBy: null,
      walletStableBalance: context.walletStableBalance,
      minBootstrapAmount: context.minBootstrapAmount,
      positionPresent: context.positionPresent,
      positionValueUsd: context.positionValueUsd,
      summary: isSelected && execute && operationType === 'remove_liquidity'
        ? buildSuccessReason(context, operationType, lpAction)
        : context.hardExitRiskTriggered
          ? `${context.poolKey} has an LP position that now needs a full exit review.`
          : `${context.poolKey} has an LP position that is above the target size and may need a trim.`,
    };
  }

  const allowExistingPosition = context.positionPresent;
  const addChecks = buildAddChecks(context, { allowExistingPosition });
  const firstFailedCheck = getFirstFailedCheck(addChecks);

  if (isSelected && execute && operationType === 'add_liquidity') {
    return {
      poolKey: context.poolKey,
      stableToken: context.stableToken,
      selected: true,
      status: 'executed',
      blockedBy: null,
      walletStableBalance: context.walletStableBalance,
      minBootstrapAmount: context.minBootstrapAmount,
      positionPresent: context.positionPresent,
      positionValueUsd: context.positionValueUsd,
      summary: buildSuccessReason(context, operationType, lpAction),
    };
  }

  if (!firstFailedCheck) {
    return {
      poolKey: context.poolKey,
      stableToken: context.stableToken,
      selected: isSelected,
      status: isSelected ? 'ready' : 'eligible',
      blockedBy: null,
      walletStableBalance: context.walletStableBalance,
      minBootstrapAmount: context.minBootstrapAmount,
      positionPresent: context.positionPresent,
      positionValueUsd: context.positionValueUsd,
      summary: isSelected
        ? `${context.poolKey} is ready for the next LP move.`
        : `${context.poolKey} is eligible for the next cirBTC LP add cycle.`,
    };
  }

  const [blockedBy, failedCheck] = firstFailedCheck;
  let status = 'blocked';
  let summary = failedCheck.detail;

  if (blockedBy === 'sizePositive') {
    status = 'needs_funds';
    summary = `${context.poolKey} needs at least ${context.minBootstrapAmount} ${context.stableToken}. Current available balance is ${context.walletStableBalance} ${context.stableToken}.`;
  } else if (blockedBy === 'growthCadence') {
    status = 'cooldown';
    summary = context.growthAddsToday >= context.maxGrowthAddsPerDay
      ? `${context.poolKey} already used ${context.growthAddsToday}/${context.maxGrowthAddsPerDay} growth adds today.`
      : `${context.poolKey} is waiting for the next growth window before another autonomous add.`;
  } else if (blockedBy === 'existingPositionCompatible') {
    status = anyPositionPresent ? 'position_open' : 'blocked';
    summary = allowExistingPosition
      ? `${context.poolKey} already has ${context.positionValueUsd} USD in LP and is not below the add target right now.`
      : `${context.poolKey} already has an LP position, so this cycle does not start a new bootstrap there.`;
  } else if (blockedBy === 'liquidityActive') {
    status = 'pool_inactive';
    summary = `${context.poolKey} is not reporting active liquidity right now.`;
  } else if (blockedBy === 'priceImpact') {
    status = 'impact_guard';
    summary = `${context.poolKey} add impact is ${context.bootstrapPriceImpactPct}% while the mature-pool limit is ${context.maxBootstrapPriceImpactPct}%.`;
  }

  return {
    poolKey: context.poolKey,
    stableToken: context.stableToken,
    selected: isSelected,
    status,
    blockedBy,
    walletStableBalance: context.walletStableBalance,
    minBootstrapAmount: context.minBootstrapAmount,
    positionPresent: context.positionPresent,
    positionValueUsd: context.positionValueUsd,
    summary,
  };
}

function getPairPolicyConfig(stableToken = 'USDC') {
  const normalizedStableToken = String(stableToken || 'USDC').trim().toUpperCase();
  const defaults = PAIR_DEFAULTS[normalizedStableToken] || PAIR_DEFAULTS.USDC;

  return {
    stableToken: normalizedStableToken,
    poolKey: defaults.poolKey,
    minBootstrapAmount: readPositiveNumberEnv(
      `CIRBTC_AUTOMATION_${normalizedStableToken}_MIN_BOOTSTRAP`,
      defaults.minBootstrapAmount,
    ),
    maxBootstrapAmount: readPositiveNumberEnv(
      `CIRBTC_AUTOMATION_${normalizedStableToken}_MAX_BOOTSTRAP`,
      defaults.maxBootstrapAmount,
    ),
    targetLpMaxUsd: readPositiveNumberEnv(
      `CIRBTC_AUTOMATION_${normalizedStableToken}_TARGET_LP_MAX_USD`,
      defaults.targetLpMaxUsd,
    ),
    growthTargetLpMaxUsd: readPositiveNumberEnv(
      `CIRBTC_AUTOMATION_${normalizedStableToken}_GROWTH_TARGET_LP_MAX_USD`,
      readPositiveNumberEnv(
        'CIRBTC_AUTOMATION_GROWTH_TARGET_LP_MAX_USD',
        defaults.growthTargetLpMaxUsd || DEFAULT_GROWTH_TARGET_LP_MAX_USD,
      ),
    ),
    minPoolLiquidityStableEq: readPositiveNumberEnv(
      `CIRBTC_AUTOMATION_${normalizedStableToken}_MIN_POOL_LIQUIDITY_STABLE_EQ`,
      readPositiveNumberEnv(
        'CIRBTC_AUTOMATION_MIN_POOL_LIQUIDITY_STABLE_EQ',
        DEFAULT_MIN_POOL_LIQUIDITY_STABLE_EQ,
      ),
    ),
    maxGrowthAddsPerDay: normalizeCount(readPositiveNumberEnv(
      `CIRBTC_AUTOMATION_${normalizedStableToken}_GROWTH_MAX_ADDS_PER_DAY`,
      readPositiveNumberEnv(
        'CIRBTC_AUTOMATION_GROWTH_MAX_ADDS_PER_DAY',
        DEFAULT_GROWTH_MAX_ADDS_PER_DAY,
      ),
    )),
    minGrowthAddIntervalHours: readPositiveNumberEnv(
      `CIRBTC_AUTOMATION_${normalizedStableToken}_GROWTH_MIN_INTERVAL_HOURS`,
      readPositiveNumberEnv(
        'CIRBTC_AUTOMATION_GROWTH_MIN_INTERVAL_HOURS',
        DEFAULT_GROWTH_MIN_INTERVAL_HOURS,
      ),
    ),
  };
}

function isVerifiedDirectPair(pool, stableToken) {
  const normalizedStableToken = String(stableToken || 'USDC').trim().toUpperCase();
  const normalizedPoolKey = String(pool?.key || '').trim().toUpperCase();
  const baseSymbol = String(pool?.baseToken?.symbol || '').trim().toUpperCase();
  const quoteSymbol = String(pool?.quoteToken?.symbol || '').trim().toUpperCase();

  return Boolean(
    pool?.protocol === 'uniswap_v2_like'
      && pool?.poolModel === 'constant_product'
      && normalizedPoolKey === `${normalizedStableToken}-CIRBTC`
      && baseSymbol === normalizedStableToken
      && quoteSymbol === 'CIRBTC'
      && pool?.address,
  );
}

function estimateConstantProductPriceImpactPct({ reserveIn, reserveOut, amountIn, feePct = 0.3 } = {}) {
  const normalizedReserveIn = Number(reserveIn);
  const normalizedReserveOut = Number(reserveOut);
  const normalizedAmountIn = Number(amountIn);
  const feeFactor = Math.max(0, 1 - (Number(feePct || 0) / 100));

  if (!(normalizedReserveIn > 0) || !(normalizedReserveOut > 0) || !(normalizedAmountIn > 0)) {
    return null;
  }

  const spotRate = normalizedReserveOut / normalizedReserveIn;
  if (!(spotRate > 0)) {
    return null;
  }

  const amountInWithFee = normalizedAmountIn * feeFactor;
  const amountOut = (normalizedReserveOut * amountInWithFee) / (normalizedReserveIn + amountInWithFee);
  const idealOut = normalizedAmountIn * spotRate;
  if (!(idealOut > 0)) {
    return null;
  }

  return normalizeAmount(Math.abs((idealOut - amountOut) / idealOut) * 100);
}

function buildAddChecks(context, { allowExistingPosition = false } = {}) {
  return {
    routeVerified: buildCheck(
      context.routeVerified,
      `Only the verified ${context.poolKey} direct pair is eligible for cirBTC LP automation.`,
    ),
    existingPositionCompatible: buildCheck(
      allowExistingPosition ? context.positionBelowTargetBand : !context.positionPresent,
      allowExistingPosition
        ? `cirBTC LP automation only tops up ${context.poolKey} while the live position stays below the ${context.effectiveTargetLpMaxUsd} USD target cap.`
        : `cirBTC LP automation only bootstraps ${context.poolKey} when this same pair does not already have an LP position.`,
    ),
    growthCadence: buildCheck(
      context.growthWindowOpen,
      context.growthAddsToday >= context.maxGrowthAddsPerDay
        ? `cirBTC LP growth mode already used ${context.growthAddsToday}/${context.maxGrowthAddsPerDay} autonomous add slots today.`
        : `${context.poolKey} is still in growth mode, so cirBTC LP automation waits at least ${context.minGrowthAddIntervalHours} hours between autonomous add cycles.`,
    ),
    liquidityActive: buildCheck(
      context.liquidityActive,
      `${context.poolKey} must report active liquidity before cirBTC LP automation can bootstrap it.`,
    ),
    priceImpact: buildCheck(
      context.bootstrapPriceImpactWithinBand,
      `${context.poolKey} estimated add impact at the current autonomous size must stay within ${context.maxBootstrapPriceImpactPct}% once the pair has reached the ${context.minPoolLiquidityStableEq} ${context.stableToken}-equivalent maturity threshold.`,
    ),
    sizePositive: buildCheck(
      context.suggestedBootstrapAmount >= context.minBootstrapAmount,
      `Wallet ${context.stableToken} balance must stay above ${context.minBootstrapAmount} before cirBTC LP automation can bootstrap ${context.poolKey}.`,
    ),
  };
}

function buildRemoveChecks(context, lpAction) {
  return {
    routeVerified: buildCheck(
      context.routeVerified,
      `Only the verified ${context.poolKey} direct pair is eligible for cirBTC LP automation exits.`,
    ),
    positionPresent: buildCheck(
      context.positionPresent,
      `A live ${context.poolKey} LP position must exist before cirBTC LP automation can remove liquidity.`,
    ),
    exitRequired: buildCheck(
      context.hardExitRiskTriggered || context.positionAboveTargetBand,
      `cirBTC LP automation only removes liquidity when ${context.poolKey} breaches the risk guard or grows above the ${context.targetLpMaxUsd} USD target cap.`,
    ),
    trimDepthHealthy: buildCheck(
      lpAction === 'full_exit' || context.exitPriceImpactWithinBand,
      `${context.poolKey} depth proxy must stay within ${context.maxExitPriceImpactPct}% for a partial trim; otherwise the policy escalates to a full exit.`,
    ),
    exitPctPositive: buildCheck(
      context.withdrawPct > 0,
      'The policy could not size a positive LP withdrawal percentage for this cirBTC position.',
    ),
  };
}

function buildHoldReason({ anyPositionPresent, selectedContext, blockedBy } = {}) {
  if (anyPositionPresent && selectedContext?.poolBelowMinLiquidity) {
    return `cirBTC LP automation is holding ${selectedContext.poolKey} because estimated pool liquidity is still below the ${selectedContext.minPoolLiquidityStableEq} ${selectedContext.stableToken}-equivalent maturity threshold. Automated exits stay off until the pair grows deeper.`;
  }

  if (anyPositionPresent && selectedContext) {
    return `cirBTC LP automation is holding ${selectedContext.poolKey} because the current position remains inside the risk band and below the ${selectedContext.effectiveTargetLpMaxUsd} USD target cap.`;
  }

  if (selectedContext && blockedBy === 'growthCadence') {
    if (selectedContext.growthAddsToday >= selectedContext.maxGrowthAddsPerDay) {
      return `cirBTC LP automation is holding ${selectedContext.poolKey} because the daily growth budget is already used (${selectedContext.growthAddsToday}/${selectedContext.maxGrowthAddsPerDay} adds today).`;
    }

    return `cirBTC LP automation is holding ${selectedContext.poolKey} until the next growth window opens. Growth-mode adds wait at least ${selectedContext.minGrowthAddIntervalHours} hours between cycles.`;
  }

  if (selectedContext && blockedBy === 'sizePositive') {
    return `cirBTC LP automation did not bootstrap ${selectedContext.poolKey} because wallet ${selectedContext.stableToken} is below the minimum ${selectedContext.minBootstrapAmount} required for a direct-pair LP bootstrap.`;
  }

  if (selectedContext && blockedBy === 'priceImpact') {
    return `cirBTC LP automation did not add to ${selectedContext.poolKey} because the pair is already above the ${selectedContext.minPoolLiquidityStableEq} ${selectedContext.stableToken}-equivalent maturity threshold and the estimated impact for the current autonomous size is ${selectedContext.bootstrapPriceImpactPct}% while the allowed band is ${selectedContext.maxBootstrapPriceImpactPct}%.`;
  }

  if (selectedContext && blockedBy === 'liquidityActive') {
    return `cirBTC LP automation did not bootstrap ${selectedContext.poolKey} because the pair does not currently report active liquidity.`;
  }

  return 'No verified cirBTC direct-pair LP action qualified for this cycle.';
}

function buildSuccessReason(context, operationType, lpAction) {
  if (operationType === 'add_liquidity') {
    if (lpAction === 'top_up_for_liquidity') {
      return `cirBTC LP automation v1 approved a ${context.poolKey} top-up using ${context.suggestedBootstrapAmount} ${context.stableToken} while the pool remains below the ${context.minPoolLiquidityStableEq} ${context.stableToken}-equivalent exit threshold.`;
    }

    return `cirBTC LP automation v1 approved a ${context.poolKey} bootstrap using ${context.suggestedBootstrapAmount} ${context.stableToken}.`;
  }

  if (lpAction === 'trim_to_target') {
    return `cirBTC LP automation v1 approved a partial ${context.poolKey} trim of ${context.withdrawPct}% to bring the position back under the ${context.targetLpMaxUsd} USD cap.`;
  }

  return `cirBTC LP automation v1 approved a full ${context.poolKey} exit because the direct-pair risk guard was triggered.`;
}

function normalizePairContext(rawContext = {}) {
  const config = getPairPolicyConfig(rawContext.stableToken);
  const pool = rawContext.pool || null;
  const poolState = rawContext.poolState || null;
  const position = rawContext.position || null;
  const walletStableBalance = normalizeAmount(rawContext.walletStableBalance);
  const positionValueUsd = normalizeAmount(position?.valuation?.totalUsd);
  const observedPriceImpactPct = normalizeAmount(poolState?.priceImpact?.swap1k);
  const impliedRate = toFiniteNumber(poolState?.impliedRate);
  const stableReserve = normalizeAmount(poolState?.reserves?.token0);
  const volatileReserve = normalizeAmount(poolState?.reserves?.token1);
  const feePct = toFiniteNumber(poolState?.fee) ?? toFiniteNumber(pool?.feePct) ?? 0.3;
  const maxBootstrapPriceImpactPct = readPositiveNumberEnv(
    'CIRBTC_AUTOMATION_MAX_BOOTSTRAP_PRICE_IMPACT_PCT',
    DEFAULT_BOOTSTRAP_MAX_PRICE_IMPACT_PCT,
  );
  const maxExitPriceImpactPct = readPositiveNumberEnv(
    'CIRBTC_AUTOMATION_MAX_EXIT_PRICE_IMPACT_PCT',
    DEFAULT_EXIT_MAX_PRICE_IMPACT_PCT,
  );
  const positionPresent = Number(position?.lpToken?.balance || 0) > 0;
  const routeVerified = isVerifiedDirectPair(pool, config.stableToken);
  const liquidityActive = String(poolState?.liquidityState || pool?.liquidityState || '').toLowerCase() === 'active';
  const poolLiquidityStableEq = normalizeAmount(
    stableReserve + (impliedRate > 0 && volatileReserve > 0 ? (volatileReserve / impliedRate) : 0),
  );
  const poolBelowMinLiquidity = poolLiquidityStableEq > 0 && poolLiquidityStableEq < config.minPoolLiquidityStableEq;
  const bootstrapPriceImpactGuardActive = !poolBelowMinLiquidity;
  const suggestedBootstrapAmount = normalizeAmount(Math.min(walletStableBalance, config.maxBootstrapAmount));
  const estimatedBootstrapSwapAmount = normalizeAmount(suggestedBootstrapAmount / 2);
  const bootstrapPriceImpactPct = estimateConstantProductPriceImpactPct({
    reserveIn: stableReserve,
    reserveOut: volatileReserve,
    amountIn: estimatedBootstrapSwapAmount,
    feePct,
  }) ?? observedPriceImpactPct;
  const bootstrapPriceImpactWithinBand = !bootstrapPriceImpactGuardActive || (
    bootstrapPriceImpactPct > 0 && bootstrapPriceImpactPct <= maxBootstrapPriceImpactPct
  );
  const exitPriceImpactWithinBand = observedPriceImpactPct > 0 && observedPriceImpactPct <= maxExitPriceImpactPct;
  const effectiveTargetLpMaxUsd = poolBelowMinLiquidity
    ? normalizeAmount(Math.max(config.targetLpMaxUsd, config.growthTargetLpMaxUsd))
    : config.targetLpMaxUsd;
  const growthAddsToday = normalizeCount(rawContext.growthHistory?.totalAddsToday);
  const lastGrowthAddAt = rawContext.growthHistory?.lastAddAt || null;
  const lastGrowthAddAtMs = lastGrowthAddAt ? new Date(lastGrowthAddAt).getTime() : null;
  const growthIntervalMs = Math.max(config.minGrowthAddIntervalHours, 1) * 60 * 60 * 1000;
  const growthCadencePassed = !poolBelowMinLiquidity || (
    growthAddsToday < config.maxGrowthAddsPerDay
      && (!Number.isFinite(lastGrowthAddAtMs) || (Date.now() - lastGrowthAddAtMs) >= growthIntervalMs)
  );
  const hardExitRiskTriggered = positionPresent && !poolBelowMinLiquidity && (!liquidityActive || !exitPriceImpactWithinBand);
  const positionAboveTargetBand = positionPresent && !poolBelowMinLiquidity && positionValueUsd > effectiveTargetLpMaxUsd;
  const positionBelowTargetBand = positionPresent && positionValueUsd < effectiveTargetLpMaxUsd;
  const suggestedExitValueUsd = normalizeAmount(
    hardExitRiskTriggered
      ? positionValueUsd
      : Math.max(positionValueUsd - effectiveTargetLpMaxUsd, 0),
  );
  const withdrawPct = normalizePercent(
    hardExitRiskTriggered
      ? 100
      : positionValueUsd > 0
        ? (suggestedExitValueUsd / positionValueUsd) * 100
        : 0,
  );

  return {
    stableToken: config.stableToken,
    poolKey: config.poolKey,
    pool,
    poolState,
    position,
    routeVerified,
    liquidityActive,
    walletStableBalance,
    minBootstrapAmount: config.minBootstrapAmount,
    maxBootstrapAmount: config.maxBootstrapAmount,
    targetLpMaxUsd: config.targetLpMaxUsd,
    growthTargetLpMaxUsd: config.growthTargetLpMaxUsd,
    effectiveTargetLpMaxUsd,
    minPoolLiquidityStableEq: config.minPoolLiquidityStableEq,
    maxGrowthAddsPerDay: config.maxGrowthAddsPerDay,
    minGrowthAddIntervalHours: config.minGrowthAddIntervalHours,
    growthAddsToday,
    lastGrowthAddAt,
    growthWindowOpen: growthCadencePassed,
    positionPresent,
    positionValueUsd,
    positionBelowTargetBand,
    observedPriceImpactPct,
    bootstrapPriceImpactPct,
    poolLiquidityStableEq,
    poolBelowMinLiquidity,
    bootstrapPriceImpactGuardActive,
    maxBootstrapPriceImpactPct,
    maxExitPriceImpactPct,
    bootstrapPriceImpactWithinBand,
    exitPriceImpactWithinBand,
    hardExitRiskTriggered,
    positionAboveTargetBand,
    suggestedBootstrapAmount,
    suggestedExitValueUsd,
    withdrawPct,
  };
}

function evaluateCirbtcLpAutomationPolicy({ pairContexts = [] } = {}) {
  const contexts = Array.isArray(pairContexts)
    ? pairContexts.map(normalizePairContext)
    : [];
  const anyPositionPresent = contexts.some(context => context.positionPresent);

  const removeCandidates = contexts
    .filter(context => context.positionPresent && !context.poolBelowMinLiquidity && (context.hardExitRiskTriggered || context.positionAboveTargetBand))
    .sort((left, right) => {
      const leftSeverity = left.hardExitRiskTriggered ? 0 : 1;
      const rightSeverity = right.hardExitRiskTriggered ? 0 : 1;
      if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
      return Number(right.suggestedExitValueUsd || 0) - Number(left.suggestedExitValueUsd || 0);
    });

  const addCandidates = contexts
    .filter((context) => {
      const allowExistingPosition = context.positionPresent;
      const candidateChecks = buildAddChecks(context, { allowExistingPosition });
      return !getFirstFailedCheck(candidateChecks);
    })
    .sort((left, right) => {
      const preferFreshBootstrap = anyPositionPresent;
      const leftPriority = preferFreshBootstrap
        ? (left.positionPresent ? 1 : 0)
        : (left.positionPresent ? 0 : 1);
      const rightPriority = preferFreshBootstrap
        ? (right.positionPresent ? 1 : 0)
        : (right.positionPresent ? 0 : 1);
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;

      const leftImpact = toFiniteNumber(left.observedPriceImpactPct) ?? Number.MAX_SAFE_INTEGER;
      const rightImpact = toFiniteNumber(right.observedPriceImpactPct) ?? Number.MAX_SAFE_INTEGER;
      if (leftImpact !== rightImpact) return leftImpact - rightImpact;
      return Number(right.walletStableBalance || 0) - Number(left.walletStableBalance || 0);
    });

  let selectedContext = null;
  let operationType = null;
  let lpAction = null;
  let checks = {};

  if (removeCandidates.length > 0) {
    selectedContext = removeCandidates[0];
    operationType = 'remove_liquidity';
    lpAction = selectedContext.hardExitRiskTriggered ? 'full_exit' : 'trim_to_target';
    checks = buildRemoveChecks(selectedContext, lpAction);
  } else if (addCandidates.length > 0) {
    selectedContext = addCandidates[0];
    operationType = 'add_liquidity';
    lpAction = selectedContext.positionPresent ? 'top_up_for_liquidity' : 'bootstrap';
    checks = buildAddChecks(selectedContext, {
      allowExistingPosition: selectedContext.positionPresent,
    });
  } else if (!anyPositionPresent || contexts.some(context => context.positionPresent && context.positionBelowTargetBand)) {
    const fallbackAddContexts = contexts
      .filter(context => !anyPositionPresent || (context.positionPresent && context.positionBelowTargetBand) || !context.positionPresent)
      .sort((left, right) => Number(right.walletStableBalance || 0) - Number(left.walletStableBalance || 0));

    if (fallbackAddContexts.length > 0) {
      selectedContext = fallbackAddContexts[0];
      checks = buildAddChecks(selectedContext, {
        allowExistingPosition: selectedContext.positionPresent,
      });
    }
  } else {
    selectedContext = contexts.find(context => context.positionPresent) || null;
  }

  const firstFailedCheck = getFirstFailedCheck(checks);
  const execute = Boolean(operationType) && !firstFailedCheck;
  const pairSummaries = contexts.map((context) => buildPairSummary(context, {
    anyPositionPresent,
    selectedPoolKey: selectedContext?.poolKey || null,
    execute,
    operationType,
    lpAction,
  }));
  const actionParams = execute
    ? operationType === 'add_liquidity'
      ? {
          stableToken: selectedContext.stableToken,
          amountIn: String(selectedContext.suggestedBootstrapAmount),
          poolKey: selectedContext.poolKey,
          lpAction,
        }
      : {
          stableToken: selectedContext.stableToken,
          withdrawPct: selectedContext.withdrawPct,
          poolKey: selectedContext.poolKey,
          lpAction,
        }
    : null;

  return {
    policyId: POLICY_ID,
    verdict: {
      execute,
      lane: 'cirbtc_direct_pair_lp',
      operationType,
      reason: execute
        ? buildSuccessReason(selectedContext, operationType, lpAction)
        : firstFailedCheck
          ? `cirBTC LP automation v1 blocked execution: ${firstFailedCheck[1].detail}`
          : buildHoldReason({
              anyPositionPresent,
              selectedContext,
              blockedBy: firstFailedCheck?.[0] || null,
            }),
      suggestedAmountUsdc: execute
        ? operationType === 'remove_liquidity'
          ? selectedContext.suggestedExitValueUsd
          : selectedContext.suggestedBootstrapAmount
        : 0,
      actionAssetSymbol: operationType === 'remove_liquidity' ? 'LP' : selectedContext?.stableToken || 'USDC',
      actionParams,
      blockedBy: execute ? null : (firstFailedCheck?.[0] || 'no_action'),
    },
    metrics: {
      anyPositionPresent,
      selectedPoolKey: selectedContext?.poolKey || null,
      selectedStableToken: selectedContext?.stableToken || null,
      lpAction,
      walletStableBalance: selectedContext?.walletStableBalance || 0,
      minBootstrapAmount: selectedContext?.minBootstrapAmount || 0,
      maxBootstrapAmount: selectedContext?.maxBootstrapAmount || 0,
      targetLpMaxUsd: selectedContext?.targetLpMaxUsd || 0,
      growthTargetLpMaxUsd: selectedContext?.growthTargetLpMaxUsd || 0,
      effectiveTargetLpMaxUsd: selectedContext?.effectiveTargetLpMaxUsd || 0,
      minPoolLiquidityStableEq: selectedContext?.minPoolLiquidityStableEq || 0,
      maxGrowthAddsPerDay: selectedContext?.maxGrowthAddsPerDay || 0,
      minGrowthAddIntervalHours: selectedContext?.minGrowthAddIntervalHours || 0,
      growthAddsToday: selectedContext?.growthAddsToday || 0,
      lastGrowthAddAt: selectedContext?.lastGrowthAddAt || null,
      growthWindowOpen: selectedContext?.growthWindowOpen || false,
      poolLiquidityStableEq: selectedContext?.poolLiquidityStableEq || 0,
      poolBelowMinLiquidity: selectedContext?.poolBelowMinLiquidity || false,
      bootstrapPriceImpactGuardActive: selectedContext?.bootstrapPriceImpactGuardActive || false,
      positionPresent: selectedContext?.positionPresent || false,
      positionValueUsd: selectedContext?.positionValueUsd || 0,
      observedPriceImpactPct: selectedContext?.observedPriceImpactPct || 0,
      bootstrapPriceImpactPct: selectedContext?.bootstrapPriceImpactPct || 0,
      liquidityActive: selectedContext?.liquidityActive || false,
      suggestedBootstrapAmount: selectedContext?.suggestedBootstrapAmount || 0,
      suggestedExitValueUsd: selectedContext?.suggestedExitValueUsd || 0,
      withdrawPct: selectedContext?.withdrawPct || 0,
      hardExitRiskTriggered: selectedContext?.hardExitRiskTriggered || false,
      positionAboveTargetBand: selectedContext?.positionAboveTargetBand || false,
      pairSummaries,
    },
    checks,
  };
}

module.exports = {
  evaluateCirbtcLpAutomationPolicy,
};