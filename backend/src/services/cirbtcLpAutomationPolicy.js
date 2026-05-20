'use strict';

const POLICY_ID = 'cirbtc_direct_pair_lp_v1';
const DEFAULT_BOOTSTRAP_MAX_PRICE_IMPACT_PCT = 2.5;
const DEFAULT_EXIT_MAX_PRICE_IMPACT_PCT = 5;

const PAIR_DEFAULTS = {
  USDC: {
    poolKey: 'USDC-CIRBTC',
    minBootstrapAmount: 12,
    maxBootstrapAmount: 20,
    targetLpMaxUsd: 20,
  },
  EURC: {
    poolKey: 'EURC-CIRBTC',
    minBootstrapAmount: 10,
    maxBootstrapAmount: 16,
    targetLpMaxUsd: 16,
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

function buildBootstrapChecks(context, anyPositionPresent) {
  return {
    routeVerified: buildCheck(
      context.routeVerified,
      `Only the verified ${context.poolKey} direct pair is eligible for cirBTC LP automation.`,
    ),
    noExistingPosition: buildCheck(
      !anyPositionPresent,
      'cirBTC LP automation only bootstraps a new direct-pair position when no direct-pair LP is already open.',
    ),
    liquidityActive: buildCheck(
      context.liquidityActive,
      `${context.poolKey} must report active liquidity before cirBTC LP automation can bootstrap it.`,
    ),
    priceImpact: buildCheck(
      context.bootstrapPriceImpactWithinBand,
      `${context.poolKey} price impact must stay within ${context.maxBootstrapPriceImpactPct}% before cirBTC LP automation can bootstrap it.`,
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
  if (anyPositionPresent && selectedContext) {
    return `cirBTC LP automation is holding ${selectedContext.poolKey} because the current position remains inside the risk band and below the ${selectedContext.targetLpMaxUsd} USD target cap.`;
  }

  if (selectedContext && blockedBy === 'sizePositive') {
    return `cirBTC LP automation did not bootstrap ${selectedContext.poolKey} because wallet ${selectedContext.stableToken} is below the minimum ${selectedContext.minBootstrapAmount} required for a direct-pair LP bootstrap.`;
  }

  if (selectedContext && blockedBy === 'priceImpact') {
    return `cirBTC LP automation did not bootstrap ${selectedContext.poolKey} because its current price impact proxy is above the ${selectedContext.maxBootstrapPriceImpactPct}% bootstrap band.`;
  }

  if (selectedContext && blockedBy === 'liquidityActive') {
    return `cirBTC LP automation did not bootstrap ${selectedContext.poolKey} because the pair does not currently report active liquidity.`;
  }

  return 'No verified cirBTC direct-pair LP action qualified for this cycle.';
}

function buildSuccessReason(context, operationType, lpAction) {
  if (operationType === 'add_liquidity') {
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
  const bootstrapPriceImpactWithinBand = observedPriceImpactPct > 0 && observedPriceImpactPct <= maxBootstrapPriceImpactPct;
  const exitPriceImpactWithinBand = observedPriceImpactPct > 0 && observedPriceImpactPct <= maxExitPriceImpactPct;
  const hardExitRiskTriggered = positionPresent && (!liquidityActive || !exitPriceImpactWithinBand);
  const positionAboveTargetBand = positionPresent && positionValueUsd > config.targetLpMaxUsd;
  const suggestedBootstrapAmount = normalizeAmount(Math.min(walletStableBalance, config.maxBootstrapAmount));
  const suggestedExitValueUsd = normalizeAmount(
    hardExitRiskTriggered
      ? positionValueUsd
      : Math.max(positionValueUsd - config.targetLpMaxUsd, 0),
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
    positionPresent,
    positionValueUsd,
    observedPriceImpactPct,
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
    .filter(context => context.positionPresent && (context.hardExitRiskTriggered || context.positionAboveTargetBand))
    .sort((left, right) => {
      const leftSeverity = left.hardExitRiskTriggered ? 0 : 1;
      const rightSeverity = right.hardExitRiskTriggered ? 0 : 1;
      if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
      return Number(right.suggestedExitValueUsd || 0) - Number(left.suggestedExitValueUsd || 0);
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
  } else if (!anyPositionPresent) {
    const bootstrapCandidates = contexts
      .filter(context => {
        const candidateChecks = buildBootstrapChecks(context, anyPositionPresent);
        return !getFirstFailedCheck(candidateChecks);
      })
      .sort((left, right) => {
        const leftImpact = toFiniteNumber(left.observedPriceImpactPct) ?? Number.MAX_SAFE_INTEGER;
        const rightImpact = toFiniteNumber(right.observedPriceImpactPct) ?? Number.MAX_SAFE_INTEGER;
        if (leftImpact !== rightImpact) return leftImpact - rightImpact;
        return Number(right.walletStableBalance || 0) - Number(left.walletStableBalance || 0);
      });

    if (bootstrapCandidates.length > 0) {
      selectedContext = bootstrapCandidates[0];
      operationType = 'add_liquidity';
      lpAction = 'bootstrap';
      checks = buildBootstrapChecks(selectedContext, anyPositionPresent);
    } else {
      selectedContext = contexts
        .slice()
        .sort((left, right) => Number(right.walletStableBalance || 0) - Number(left.walletStableBalance || 0))[0] || null;
      checks = selectedContext ? buildBootstrapChecks(selectedContext, anyPositionPresent) : {};
    }
  } else {
    selectedContext = contexts.find(context => context.positionPresent) || null;
  }

  const firstFailedCheck = getFirstFailedCheck(checks);
  const execute = Boolean(operationType) && !firstFailedCheck;
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
      positionPresent: selectedContext?.positionPresent || false,
      positionValueUsd: selectedContext?.positionValueUsd || 0,
      observedPriceImpactPct: selectedContext?.observedPriceImpactPct || 0,
      liquidityActive: selectedContext?.liquidityActive || false,
      suggestedBootstrapAmount: selectedContext?.suggestedBootstrapAmount || 0,
      suggestedExitValueUsd: selectedContext?.suggestedExitValueUsd || 0,
      withdrawPct: selectedContext?.withdrawPct || 0,
      hardExitRiskTriggered: selectedContext?.hardExitRiskTriggered || false,
      positionAboveTargetBand: selectedContext?.positionAboveTargetBand || false,
    },
    checks,
  };
}

module.exports = {
  evaluateCirbtcLpAutomationPolicy,
};