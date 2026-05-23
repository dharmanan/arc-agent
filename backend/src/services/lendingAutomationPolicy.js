'use strict';

const POLICY_ID = 'lending_autonomous_guard_v1';
const DEFAULT_HEALTH_FACTOR_TRIGGER = Number(process.env.LENDING_AUTOMATION_TRIGGER_HF || '1.2');
const DEFAULT_MAX_RESERVE_UTILIZATION_PCT = Number(process.env.LENDING_AUTOMATION_MAX_UTILIZATION_PCT || '85');
const DEFAULT_MIN_LP_REDUCTION_USD = Number(process.env.LENDING_AUTOMATION_MIN_LP_REDUCTION_USD || '5');

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundMetric(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function normalizePct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Number(numeric.toFixed(4));
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}

function buildHoldVerdict(detail, metrics = {}, checks = {}) {
  return {
    policyId: POLICY_ID,
    verdict: {
      execute: false,
      lane: 'lending_automation',
      operationType: null,
      reason: detail,
      suggestedAmountUsdc: 0,
      actionAssetSymbol: null,
      actionParams: null,
      blockedBy: null,
    },
    metrics,
    checks,
  };
}

function getReserveUtilizationPct(assetEntry) {
  const totalSupplied = toNumber(assetEntry?.reserve?.totalSupplied, 0);
  const totalBorrowed = toNumber(assetEntry?.reserve?.totalBorrowed, 0);
  if (!(totalSupplied > 0) || !(totalBorrowed > 0)) return 0;
  return normalizePct((totalBorrowed / totalSupplied) * 100);
}

function buildDebtAssetSnapshot(assetEntry, maxReserveUtilizationPct) {
  const priceUsd = toNumber(assetEntry?.price?.priceUsd, 0);
  const debtAmount = toNumber(assetEntry?.position?.borrowAmount, 0);
  const debtUsd = toNumber(assetEntry?.position?.borrowUsd, 0);
  const walletAmount = toNumber(assetEntry?.wallet?.amount, 0);
  const walletUsd = toNumber(assetEntry?.wallet?.amountUsd, 0);
  const reserveUtilizationPct = getReserveUtilizationPct(assetEntry);
  const reserveTotalSupplied = toNumber(assetEntry?.reserve?.totalSupplied, 0);
  const reserveTotalBorrowed = toNumber(assetEntry?.reserve?.totalBorrowed, 0);
  const utilizationExcessAmount = Math.max(
    reserveTotalBorrowed - (reserveTotalSupplied * (maxReserveUtilizationPct / 100)),
    0,
  );
  const utilizationRepayAmount = Math.min(debtAmount, utilizationExcessAmount);

  return {
    symbol: assetEntry?.symbol || null,
    priceUsd: roundMetric(priceUsd),
    debtAmount: roundMetric(debtAmount),
    debtUsd: roundMetric(debtUsd),
    walletAmount: roundMetric(walletAmount),
    walletUsd: roundMetric(walletUsd),
    reserveUtilizationPct,
    reserveTotalSupplied: roundMetric(reserveTotalSupplied),
    reserveTotalBorrowed: roundMetric(reserveTotalBorrowed),
    utilizationCapBreached: reserveUtilizationPct > maxReserveUtilizationPct,
    utilizationRepayAmount: roundMetric(utilizationRepayAmount),
    utilizationRepayUsd: roundMetric(utilizationRepayAmount * priceUsd),
  };
}

function buildUtilizationRepayPlan({ debtAssets }) {
  const steps = [];
  let plannedRepayUsd = 0;

  for (const asset of debtAssets) {
    if (!asset.utilizationCapBreached) continue;
    if (!(asset.utilizationRepayAmount > 0) || !(asset.priceUsd > 0)) continue;

    const repayAmount = Math.min(asset.walletAmount, asset.utilizationRepayAmount, asset.debtAmount);
    if (!(repayAmount > 0)) continue;

    const repayUsd = repayAmount * asset.priceUsd;
    steps.push({
      action: 'repay',
      asset: asset.symbol,
      amount: roundMetric(repayAmount),
      usdAmount: roundMetric(repayUsd),
      currentDebtAmount: asset.debtAmount,
      availableWalletAmount: asset.walletAmount,
      reserveUtilizationPct: asset.reserveUtilizationPct,
    });
    plannedRepayUsd += repayUsd;
  }

  const breachedAssets = debtAssets
    .filter((asset) => asset.utilizationCapBreached)
    .map((asset) => ({
      symbol: asset.symbol,
      reserveUtilizationPct: asset.reserveUtilizationPct,
      utilizationRepayUsd: asset.utilizationRepayUsd,
      walletUsd: asset.walletUsd,
      debtUsd: asset.debtUsd,
    }));

  return {
    steps,
    breachedAssets,
    plannedRepayUsd: roundMetric(plannedRepayUsd),
    requiredRepayUsd: roundMetric(
      debtAssets.reduce((sum, asset) => sum + toNumber(asset.utilizationRepayUsd, 0), 0),
    ),
  };
}

function getUnderlyingAsset(position, symbol) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  return (position?.underlying || []).find(
    (asset) => String(asset?.symbol || '').trim().toUpperCase() === normalizedSymbol,
  ) || null;
}

function buildStableCurveReductionCandidate({ position, targetAsset, neededUsd, minLpReductionUsd }) {
  const positionValueUsd = toNumber(position?.valuation?.totalUsd, 0);
  const lpBalance = toNumber(position?.lpToken?.balance, 0);
  const targetUnderlying = getUnderlyingAsset(position, targetAsset);
  const targetUnderlyingUsd = toNumber(targetUnderlying?.usdValue, 0);

  if (!(positionValueUsd > 0) || !(lpBalance > 0) || !(targetUnderlyingUsd > 0)) {
    return null;
  }

  const estimatedStableUsdReleased = Math.min(targetUnderlyingUsd, Math.max(neededUsd, minLpReductionUsd));
  if (!(estimatedStableUsdReleased >= minLpReductionUsd)) {
    return null;
  }

  const fraction = clampNumber(estimatedStableUsdReleased / positionValueUsd, 0.05, 1);
  const lpAmount = lpBalance * fraction;

  if (!(lpAmount > 0)) return null;

  return {
    lane: 'stable_curve_lp',
    operationType: 'remove_liquidity',
    assetSymbol: targetAsset,
    suggestedAmountUsdc: roundMetric(estimatedStableUsdReleased),
    actionParams: {
      lpAmount: String(roundMetric(lpAmount)),
      tokenOut: targetAsset,
    },
    reductionPlan: {
      source: 'stable_curve',
      poolKey: position?.poolKey || 'USDC-EURC',
      estimatedStableUsdReleased: roundMetric(estimatedStableUsdReleased),
      currentLpBalance: roundMetric(lpBalance),
      targetUnderlyingUsd: roundMetric(targetUnderlyingUsd),
      positionValueUsd: roundMetric(positionValueUsd),
    },
  };
}

function buildCirbtcReductionCandidate({ position, targetAsset, neededUsd, minLpReductionUsd }) {
  const targetUnderlying = getUnderlyingAsset(position, targetAsset);
  const targetUnderlyingUsd = toNumber(targetUnderlying?.usdValue, 0);

  if (!(targetUnderlyingUsd >= minLpReductionUsd)) {
    return null;
  }

  const estimatedStableUsdReleased = Math.min(targetUnderlyingUsd, Math.max(neededUsd, minLpReductionUsd));
  const withdrawPct = clampNumber((estimatedStableUsdReleased / targetUnderlyingUsd) * 100, 5, 100);

  return {
    lane: 'cirbtc_direct_pair_lp',
    operationType: 'remove_liquidity',
    assetSymbol: targetAsset,
    suggestedAmountUsdc: roundMetric(estimatedStableUsdReleased),
    actionParams: {
      stableToken: targetAsset,
      withdrawPct: String(roundMetric(withdrawPct, 4)),
    },
    reductionPlan: {
      source: 'cirbtc_direct_pair',
      poolKey: position?.poolKey || `${targetAsset}-CIRBTC`,
      estimatedStableUsdReleased: roundMetric(estimatedStableUsdReleased),
      targetUnderlyingUsd: roundMetric(targetUnderlyingUsd),
      withdrawPct: roundMetric(withdrawPct, 4),
    },
  };
}

function buildForcedLpReductionCandidate({
  targetAsset,
  neededUsd,
  stableCurvePosition,
  cirbtcPositionsByKey,
  minLpReductionUsd,
}) {
  if (!targetAsset || !(neededUsd >= minLpReductionUsd)) return null;

  const stableCurveCandidate = buildStableCurveReductionCandidate({
    position: stableCurvePosition,
    targetAsset,
    neededUsd,
    minLpReductionUsd,
  });
  if (stableCurveCandidate) {
    return stableCurveCandidate;
  }

  const directPairKey = `${String(targetAsset || '').toUpperCase()}-CIRBTC`;
  const directPairPosition = cirbtcPositionsByKey?.[directPairKey] || null;
  return buildCirbtcReductionCandidate({
    position: directPairPosition,
    targetAsset,
    neededUsd,
    minLpReductionUsd,
  });
}

function getHighestPriorityDebtAsset({ debtAssets, preferUtilizationBreach = false }) {
  const prioritized = [...debtAssets].sort((left, right) => {
    if (preferUtilizationBreach) {
      if (left.utilizationCapBreached !== right.utilizationCapBreached) {
        return left.utilizationCapBreached ? -1 : 1;
      }
      const utilizationGapLeft = left.reserveUtilizationPct - right.reserveUtilizationPct;
      if (utilizationGapLeft !== 0) return utilizationGapLeft > 0 ? -1 : 1;
    }

    return toNumber(right.debtUsd, 0) - toNumber(left.debtUsd, 0);
  });

  return prioritized[0] || null;
}

function evaluateLendingAutomationPolicy({
  lendingSurface,
  stableCurvePosition = null,
  cirbtcPositionsByKey = {},
} = {}) {
  const surface = lendingSurface && typeof lendingSurface === 'object' ? lendingSurface : null;
  if (!surface) {
    return buildHoldVerdict('Lending automation is waiting for a visible lending surface.', {
      healthFactor: null,
      totalBorrowUsd: 0,
      totalSuppliedUsd: 0,
      utilizationCapPct: roundMetric(DEFAULT_MAX_RESERVE_UTILIZATION_PCT, 2),
    }, {
      lendingSurfaceLoaded: false,
    });
  }

  const healthFactor = toNumber(surface?.risk?.healthFactor, NaN);
  const totalBorrowUsd = toNumber(surface?.risk?.totalBorrowUsd, 0);
  const totalSuppliedUsd = toNumber(surface?.risk?.totalSuppliedUsd, 0);
  const healthFactorTrigger = DEFAULT_HEALTH_FACTOR_TRIGGER;
  const maxReserveUtilizationPct = DEFAULT_MAX_RESERVE_UTILIZATION_PCT;
  const minLpReductionUsd = DEFAULT_MIN_LP_REDUCTION_USD;
  const debtAssets = (surface?.assets || [])
    .map((assetEntry) => buildDebtAssetSnapshot(assetEntry, maxReserveUtilizationPct))
    .filter((asset) => asset.debtAmount > 0)
    .sort((left, right) => toNumber(right.debtUsd, 0) - toNumber(left.debtUsd, 0));
  const utilizationPlan = buildUtilizationRepayPlan({ debtAssets });
  const healthFactorTriggered = totalBorrowUsd > 0 && Number.isFinite(healthFactor) && healthFactor <= healthFactorTrigger;
  const utilizationCapTriggered = utilizationPlan.breachedAssets.length > 0;

  const metrics = {
    healthFactor: roundMetric(healthFactor, 4),
    healthFactorTrigger: roundMetric(healthFactorTrigger, 4),
    totalBorrowUsd: roundMetric(totalBorrowUsd),
    totalSuppliedUsd: roundMetric(totalSuppliedUsd),
    utilizationCapPct: roundMetric(maxReserveUtilizationPct, 2),
    breachedAssets: utilizationPlan.breachedAssets,
    recoveryStatus: surface?.recovery?.status || 'idle',
    collateralTopUpStatus: surface?.collateralTopUp?.status || 'idle',
    safeExitStatus: surface?.safeExit?.status || 'idle',
  };
  const checks = {
    hasDebt: totalBorrowUsd > 0,
    healthFactorTriggered,
    utilizationCapTriggered,
    executionReady: surface?.execution?.ready === true,
  };

  if (!(totalBorrowUsd > 0)) {
    return buildHoldVerdict('Lending automation is idle because no debt position is visible.', metrics, checks);
  }

  if (!healthFactorTriggered && !utilizationCapTriggered) {
    return buildHoldVerdict('Lending automation is holding because health factor and reserve utilization both remain inside the current guardrails.', metrics, checks);
  }

  if (healthFactorTriggered && surface?.recovery?.execute === true && Array.isArray(surface.recovery.steps) && surface.recovery.steps.length > 0) {
    return {
      policyId: POLICY_ID,
      verdict: {
        execute: true,
        lane: 'lending_automation',
        operationType: 'deleverage',
        reason: 'Health factor moved into the recovery band, so lending automation is sending the deterministic auto-repay plan first.',
        suggestedAmountUsdc: roundMetric(surface.recovery.repayUsdPlanned),
        actionAssetSymbol: surface.recovery.steps[0]?.asset || null,
        actionParams: null,
        blockedBy: null,
      },
      metrics: {
        ...metrics,
        repayUsdNeeded: roundMetric(surface?.recovery?.repayUsdNeeded),
        repayUsdPlanned: roundMetric(surface?.recovery?.repayUsdPlanned),
        repayUsdShortfall: roundMetric(surface?.recovery?.repayUsdShortfall),
        plannedSteps: surface?.recovery?.steps || [],
      },
      checks,
    };
  }

  if (healthFactorTriggered && surface?.collateralTopUp?.execute === true && Array.isArray(surface.collateralTopUp.steps) && surface.collateralTopUp.steps.length > 0) {
    return {
      policyId: POLICY_ID,
      verdict: {
        execute: true,
        lane: 'lending_automation',
        operationType: 'collateral_top_up',
        reason: 'Health factor moved into the warning band and the visible wallet can restore collateral faster than a forced LP reduction.',
        suggestedAmountUsdc: roundMetric(surface.collateralTopUp.collateralUsdPlanned),
        actionAssetSymbol: surface.collateralTopUp.steps[0]?.asset || null,
        actionParams: null,
        blockedBy: null,
      },
      metrics: {
        ...metrics,
        collateralUsdNeeded: roundMetric(surface?.collateralTopUp?.collateralUsdNeeded),
        collateralUsdPlanned: roundMetric(surface?.collateralTopUp?.collateralUsdPlanned),
        collateralUsdShortfall: roundMetric(surface?.collateralTopUp?.collateralUsdShortfall),
        plannedSteps: surface?.collateralTopUp?.steps || [],
      },
      checks,
    };
  }

  if (utilizationPlan.steps.length > 0) {
    return {
      policyId: POLICY_ID,
      verdict: {
        execute: true,
        lane: 'lending_automation',
        operationType: 'utilization_repay',
        reason: 'Borrow-side reserve utilization moved above the current cap, so lending automation is reducing debt with visible wallet funds.',
        suggestedAmountUsdc: roundMetric(utilizationPlan.plannedRepayUsd),
        actionAssetSymbol: utilizationPlan.steps[0]?.asset || null,
        actionParams: {
          steps: utilizationPlan.steps,
        },
        blockedBy: null,
      },
      metrics: {
        ...metrics,
        repayUsdNeeded: utilizationPlan.requiredRepayUsd,
        repayUsdPlanned: utilizationPlan.plannedRepayUsd,
        plannedSteps: utilizationPlan.steps,
      },
      checks,
    };
  }

  const targetDebtAsset = getHighestPriorityDebtAsset({
    debtAssets,
    preferUtilizationBreach: utilizationCapTriggered,
  });
  const neededUsd = healthFactorTriggered
    ? Math.max(
        toNumber(surface?.recovery?.repayUsdShortfall, 0),
        toNumber(surface?.recovery?.repayUsdNeeded, 0),
        toNumber(surface?.collateralTopUp?.collateralUsdNeeded, 0),
      )
    : Math.max(utilizationPlan.requiredRepayUsd, 0);
  const forcedLpReduction = buildForcedLpReductionCandidate({
    targetAsset: targetDebtAsset?.symbol,
    neededUsd,
    stableCurvePosition,
    cirbtcPositionsByKey,
    minLpReductionUsd,
  });

  if (forcedLpReduction) {
    return {
      policyId: POLICY_ID,
      verdict: {
        execute: true,
        lane: 'lending_automation',
        operationType: 'forced_lp_reduce',
        reason: healthFactorTriggered
          ? 'Health factor is inside the lending recovery band, but wallet funds are short, so lending automation is forcing an LP reduction to free stable assets first.'
          : 'Borrow-side reserve utilization is above the cap and wallet funds are short, so lending automation is forcing an LP reduction to free stable assets first.',
        suggestedAmountUsdc: roundMetric(forcedLpReduction.suggestedAmountUsdc),
        actionAssetSymbol: forcedLpReduction.assetSymbol,
        actionParams: {
          ...forcedLpReduction.actionParams,
          sourceLane: forcedLpReduction.lane,
        },
        blockedBy: null,
      },
      metrics: {
        ...metrics,
        neededUsd: roundMetric(neededUsd),
        forcedLpReduction: forcedLpReduction.reductionPlan,
        targetDebtAsset: targetDebtAsset?.symbol || null,
      },
      checks,
    };
  }

  return buildHoldVerdict(
    'Lending automation sees the current guard trigger, but no deterministic auto-repay, collateral top-up, or LP reduction path is available from the visible wallet and LP positions yet.',
    {
      ...metrics,
      neededUsd: roundMetric(neededUsd),
      targetDebtAsset: targetDebtAsset?.symbol || null,
    },
    {
      ...checks,
      lpReductionAvailable: false,
    },
  );
}

module.exports = {
  evaluateLendingAutomationPolicy,
};