'use strict';

const CARRY_POLICY_ID = 'carry_stable_lp_v1';
const CARRY_EXECUTION_LANE = 'carry_stable_lp';
const MIN_ACTION_USD = (() => {
  const numeric = Number(process.env.CARRY_AUTOMATION_MIN_ACTION_USD || '25');
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 25;
})();
const MIN_NET_APY_PCT = (() => {
  const numeric = Number(process.env.CARRY_AUTOMATION_MIN_NET_APY_PCT || '1.5');
  return Number.isFinite(numeric) ? numeric : 1.5;
})();
const TARGET_HEALTH_FACTOR = (() => {
  const numeric = Number(process.env.CARRY_AUTOMATION_TARGET_HF || '1.45');
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1.45;
})();
const UNWIND_HEALTH_FACTOR = (() => {
  const numeric = Number(process.env.CARRY_AUTOMATION_UNWIND_HF || '1.2');
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1.2;
})();
const MAX_AVAILABLE_BORROW_SHARE_PCT = (() => {
  const numeric = Number(process.env.CARRY_AUTOMATION_MAX_AVAILABLE_BORROW_SHARE_PCT || '35');
  if (!Number.isFinite(numeric)) return 35;
  return Math.min(Math.max(numeric, 1), 100);
})();
const MAX_POSITION_USD_DEFAULT = (() => {
  const numeric = Number(process.env.CARRY_AUTOMATION_MAX_POSITION_USD || '250');
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 250;
})();
const PREFERRED_OPEN_ASSET = String(process.env.CARRY_AUTOMATION_OPEN_ASSET || 'USDC').trim().toUpperCase() || 'USDC';

const LP_DAILY_TURNOVER_BASELINES = {
  curve: 0.22,
  constant_product: 0.06,
};

const LP_MAX_APR_PCT = {
  curve: 18,
  constant_product: 24,
};

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundMetric(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function normalizeUsdcAmount(value) {
  const numeric = toNumber(value, 0);
  if (!(numeric > 0)) return 0;
  return Math.floor(numeric * 1_000_000) / 1_000_000;
}

function buildCheck(passed, detail, blockedBy = null) {
  return {
    passed: passed === true,
    detail,
    blockedBy: passed === true ? null : blockedBy,
  };
}

function getTurnoverDepthModifier(priceImpact10kPct) {
  const numeric = Number(priceImpact10kPct);
  if (!Number.isFinite(numeric)) return 1;
  if (numeric <= 0.15) return 1.35;
  if (numeric <= 0.5) return 1.15;
  if (numeric <= 1.5) return 1;
  if (numeric <= 3) return 0.75;
  return 0.5;
}

function estimateStableLpYieldMetrics(poolState, totalValueUsd = 0) {
  const liquidityState = String(poolState?.liquidityState || '').toLowerCase();
  const feePct = Number(poolState?.fee ?? 0);
  const baselineTurnover = LP_DAILY_TURNOVER_BASELINES.curve || LP_DAILY_TURNOVER_BASELINES.constant_product;

  if (!Number.isFinite(feePct) || feePct <= 0 || liquidityState === 'empty') {
    return {
      aprPct: 0,
      apyPct: 0,
      dailyUsd: 0,
      yearlyUsd: 0,
      turnoverRatioPct: 0,
      poolFeePct: roundMetric(feePct, 4) || 0,
      priceImpact10kPct: roundMetric(poolState?.priceImpact?.swap10k, 4),
      liquidityState: liquidityState || 'unknown',
      source: 'live_pool_fee_depth_heuristic',
      note: 'LP fee estimate is unavailable until the stable pool shows non-zero fee data and live liquidity.',
    };
  }

  const turnoverRatio = baselineTurnover * getTurnoverDepthModifier(poolState?.priceImpact?.swap10k);
  const uncappedAprPct = feePct * turnoverRatio * 365;
  const aprPct = Math.min(uncappedAprPct, LP_MAX_APR_PCT.curve || LP_MAX_APR_PCT.constant_product);
  const apyPct = (((1 + ((aprPct / 100) / 365)) ** 365) - 1) * 100;
  const dailyUsd = totalValueUsd > 0 ? totalValueUsd * (aprPct / 100) / 365 : 0;

  return {
    aprPct: roundMetric(aprPct, 2) || 0,
    apyPct: roundMetric(apyPct, 2) || 0,
    dailyUsd: roundMetric(dailyUsd, 4) || 0,
    yearlyUsd: roundMetric(dailyUsd * 365) || 0,
    turnoverRatioPct: roundMetric(turnoverRatio * 100, 2) || 0,
    poolFeePct: roundMetric(feePct, 4) || 0,
    priceImpact10kPct: roundMetric(poolState?.priceImpact?.swap10k, 4),
    liquidityState: liquidityState || 'unknown',
    source: 'live_pool_fee_depth_heuristic',
    note: 'Approximate fee-only LP estimate from the current stable pool fee tier and live depth proxy. This excludes token price movement, incentives and impermanent loss.',
  };
}

function buildCandidateSnapshot(assetEntry, lpYieldMetrics, walletBalances, walletReserveUsdc) {
  const symbol = String(assetEntry?.symbol || '').toUpperCase();
  const walletBalanceAmount = symbol === 'EURC'
    ? toNumber(walletBalances?.eurc, toNumber(assetEntry?.wallet?.amount, 0))
    : toNumber(walletBalances?.usdc, toNumber(assetEntry?.wallet?.amount, 0));
  const walletDeployableUsd = normalizeUsdcAmount(Math.max(
    walletBalanceAmount - (symbol === 'USDC' ? toNumber(walletReserveUsdc, 0) : 0),
    0,
  ));
  const borrowApyPct = toNumber(assetEntry?.reserve?.borrowApyPct, 0);
  const netCarryApyPct = roundMetric(lpYieldMetrics.apyPct - borrowApyPct, 4) || 0;
  const hasMeaningfulBorrow = toNumber(assetEntry?.position?.borrowUsd, 0) >= MIN_ACTION_USD;

  return {
    symbol,
    borrowEnabled: assetEntry?.reserve?.borrowEnabled === true,
    reservePaused: assetEntry?.reserve?.paused === true,
    supported: assetEntry?.reserve?.supported === true,
    borrowAmount: toNumber(assetEntry?.position?.borrowAmount, 0),
    borrowUsd: toNumber(assetEntry?.position?.borrowUsd, 0),
    hasMeaningfulBorrow,
    walletAmount: roundMetric(walletBalanceAmount),
    walletDeployableUsd,
    priceUsd: toNumber(assetEntry?.price?.priceUsd, 1),
    borrowAprPct: toNumber(assetEntry?.reserve?.borrowAprPct, 0),
    borrowApyPct,
    supplyAprPct: toNumber(assetEntry?.reserve?.supplyAprPct, 0),
    supplyApyPct: toNumber(assetEntry?.reserve?.supplyApyPct, 0),
    utilizationPct: toNumber(assetEntry?.reserve?.utilizationPct, 0),
    netCarryAprPct: roundMetric(lpYieldMetrics.aprPct - toNumber(assetEntry?.reserve?.borrowAprPct, 0), 4) || 0,
    netCarryApyPct,
    positiveCarry: netCarryApyPct >= MIN_NET_APY_PCT,
  };
}

function selectCarryCandidate(candidates) {
  const activeDebtCandidate = candidates
    .filter((candidate) => candidate.hasMeaningfulBorrow)
    .sort((left, right) => right.borrowUsd - left.borrowUsd)[0];

  if (activeDebtCandidate) return activeDebtCandidate;

  return candidates.find((candidate) => candidate.symbol === PREFERRED_OPEN_ASSET) || null;
}

function buildCarryOpportunitySnapshot({
  lendingSurface,
  stablePoolState,
  stableCurvePosition = null,
  walletBalances = {},
  maxTradeUsdc = 0,
  walletReserveUsdc = 0,
} = {}) {
  const positionValueUsd = toNumber(stableCurvePosition?.valuation?.totalUsd, 0);
  const lpBalance = String(stableCurvePosition?.lpToken?.balance || '0');
  const hasStableLpPosition = positionValueUsd >= MIN_ACTION_USD;
  const lpYieldMetrics = estimateStableLpYieldMetrics(stablePoolState, positionValueUsd);
  const assets = Array.isArray(lendingSurface?.assets) ? lendingSurface.assets : [];
  const candidates = assets
    .filter((assetEntry) => assetEntry?.reserve?.supported === true)
    .map((assetEntry) => buildCandidateSnapshot(assetEntry, lpYieldMetrics, walletBalances, walletReserveUsdc))
    .filter((candidate) => candidate.supported && candidate.borrowEnabled && !candidate.reservePaused);
  const selectedCandidate = selectCarryCandidate(candidates);
  const availableBorrowUsd = toNumber(lendingSurface?.risk?.availableBorrowUsd, 0);
  const healthFactor = toNumber(lendingSurface?.risk?.healthFactor, NaN);
  const liquidationCapacityUsd = toNumber(lendingSurface?.risk?.liquidationCapacityUsd, 0);
  const maxPositionUsd = Math.min(
    Math.max(toNumber(maxTradeUsdc, 0), 0) || MAX_POSITION_USD_DEFAULT,
    MAX_POSITION_USD_DEFAULT,
  );
  const cappedBorrowCapacityUsd = normalizeUsdcAmount(availableBorrowUsd * (MAX_AVAILABLE_BORROW_SHARE_PCT / 100));
  const targetOpenUsd = normalizeUsdcAmount(Math.min(maxPositionUsd, cappedBorrowCapacityUsd));
  const projectedOpenHealthFactor = targetOpenUsd > 0
    ? roundMetric(liquidationCapacityUsd / targetOpenUsd, 4)
    : null;
  const manualStableLpConflict = hasStableLpPosition && selectedCandidate?.hasMeaningfulBorrow !== true;
  const currentCapitalUsd = normalizeUsdcAmount(
    selectedCandidate?.hasMeaningfulBorrow
      ? Math.min(selectedCandidate.borrowUsd, positionValueUsd > 0 ? positionValueUsd : selectedCandidate.borrowUsd)
      : 0,
  );
  const projectedCapitalUsd = currentCapitalUsd > 0 ? currentCapitalUsd : targetOpenUsd;
  const estimatedLpUsdPerYear = roundMetric(projectedCapitalUsd * (lpYieldMetrics.apyPct / 100));
  const estimatedBorrowCostUsdPerYear = roundMetric(projectedCapitalUsd * (toNumber(selectedCandidate?.borrowApyPct, 0) / 100));
  const estimatedNetUsdPerYear = roundMetric(estimatedLpUsdPerYear - estimatedBorrowCostUsdPerYear);
  const currentCarryModeActive = Boolean(selectedCandidate?.hasMeaningfulBorrow === true && hasStableLpPosition);
  const currentDebtIdle = Boolean(selectedCandidate?.hasMeaningfulBorrow === true && !hasStableLpPosition);
  const lpShortfallUsd = normalizeUsdcAmount(
    selectedCandidate?.hasMeaningfulBorrow === true
      ? Math.max(selectedCandidate.borrowUsd - positionValueUsd, 0)
      : 0,
  );
  const unwindSuggested = Boolean(
    selectedCandidate?.hasMeaningfulBorrow === true
      && (!selectedCandidate.positiveCarry || (Number.isFinite(healthFactor) && healthFactor <= UNWIND_HEALTH_FACTOR))
  );

  const checks = {
    executionReady: buildCheck(
      lendingSurface?.execution?.ready === true,
      'The Arc-native lending contract must be live before carry automation can open or close positions.',
      'execution_not_ready',
    ),
    poolReady: buildCheck(
      lpYieldMetrics.apyPct > 0 && lpYieldMetrics.liquidityState !== 'empty',
      'The stable LP lane needs live fee data and non-empty liquidity before carry can deploy.',
      'stable_pool_unavailable',
    ),
    positiveCarry: buildCheck(
      selectedCandidate?.positiveCarry === true,
      `Net carry must stay above ${MIN_NET_APY_PCT}% after borrow cost.`,
      'negative_net_carry',
    ),
    borrowCapacity: buildCheck(
      targetOpenUsd >= MIN_ACTION_USD,
      `Visible borrow capacity must allow at least $${MIN_ACTION_USD.toFixed(0)} of carry size.`,
      'borrow_capacity_too_small',
    ),
    projectedHealth: buildCheck(
      projectedOpenHealthFactor != null && projectedOpenHealthFactor >= TARGET_HEALTH_FACTOR,
      `Projected health factor after a new carry leg must stay above ${TARGET_HEALTH_FACTOR}.`,
      'health_factor_buffer_too_thin',
    ),
    currentHealth: buildCheck(
      selectedCandidate?.hasMeaningfulBorrow !== true
        || !Number.isFinite(healthFactor)
        || healthFactor > UNWIND_HEALTH_FACTOR,
      `Existing debt will unwind if health factor falls to ${UNWIND_HEALTH_FACTOR} or below.`,
      'health_factor_unwind',
    ),
    stableLpConflict: buildCheck(
      !manualStableLpConflict,
      'Carry mode will not take over an existing stable LP position that has no matching lending debt yet.',
      'manual_stable_lp_conflict',
    ),
    walletDeployable: buildCheck(
      toNumber(selectedCandidate?.walletDeployableUsd, 0) >= MIN_ACTION_USD,
      `At least $${MIN_ACTION_USD.toFixed(0)} of the carry asset must be sitting idle in the wallet to deploy or repay immediately.`,
      'wallet_balance_too_small',
    ),
  };

  const carryState = unwindSuggested
    ? 'unwind'
    : currentCarryModeActive
      ? 'active'
      : currentDebtIdle
        ? 'debt_idle'
        : manualStableLpConflict
          ? 'manual_lp_conflict'
          : 'inactive';

  return {
    policyId: CARRY_POLICY_ID,
    lane: CARRY_EXECUTION_LANE,
    exclusiveMode: true,
    preferredOpenAssetSymbol: PREFERRED_OPEN_ASSET,
    availableCandidateSymbols: candidates.map((candidate) => candidate.symbol),
    selectedAssetSymbol: selectedCandidate?.symbol || null,
    lpYield: lpYieldMetrics,
    selectedAsset: selectedCandidate,
    positionValueUsd: roundMetric(positionValueUsd),
    lpBalance,
    hasStableLpPosition,
    currentCarryModeActive,
    currentDebtIdle,
    lpShortfallUsd,
    manualStableLpConflict,
    carryState,
    availableBorrowUsd: roundMetric(availableBorrowUsd),
    targetOpenUsd,
    healthFactor: Number.isFinite(healthFactor) ? roundMetric(healthFactor, 4) : null,
    projectedOpenHealthFactor,
    estimatedLpUsdPerYear,
    estimatedBorrowCostUsdPerYear,
    estimatedNetUsdPerYear,
    checks,
  };
}

function buildHoldPolicy(snapshot, reason, blockedBy, summary) {
  return {
    policyId: CARRY_POLICY_ID,
    verdict: {
      execute: false,
      lane: CARRY_EXECUTION_LANE,
      operationType: null,
      reason: summary,
      suggestedAmountUsdc: 0,
      actionAssetSymbol: snapshot?.selectedAssetSymbol || null,
      actionParams: null,
      blockedBy,
    },
    metrics: {
      ...snapshot,
      holdReason: reason,
    },
    checks: snapshot?.checks || {},
  };
}

function evaluateCarryAutomationPolicy(options = {}) {
  const snapshot = buildCarryOpportunitySnapshot(options);
  const selectedAsset = snapshot.selectedAsset;

  if (!snapshot.checks.executionReady.passed) {
    return buildHoldPolicy(snapshot, 'execution_not_ready', snapshot.checks.executionReady.blockedBy, snapshot.checks.executionReady.detail);
  }

  if (!snapshot.checks.poolReady.passed) {
    return buildHoldPolicy(snapshot, 'stable_pool_unavailable', snapshot.checks.poolReady.blockedBy, snapshot.checks.poolReady.detail);
  }

  if (!selectedAsset) {
    if (Array.isArray(snapshot.availableCandidateSymbols) && snapshot.availableCandidateSymbols.length > 0) {
      return buildHoldPolicy(
        snapshot,
        'preferred_carry_asset_unavailable',
        'preferred_carry_asset_unavailable',
        `${snapshot.preferredOpenAssetSymbol || 'USDC'} is the default Auto Carry open asset on this lane. That borrow lane is not available right now, so no new carry leg will open here.`,
      );
    }

    return buildHoldPolicy(
      snapshot,
      'carry_asset_unavailable',
      'no_supported_borrow_asset',
      'No supported USDC or EURC borrow lane is visible for the stable carry policy yet.',
    );
  }

  if (!snapshot.checks.stableLpConflict.passed) {
    return buildHoldPolicy(snapshot, 'manual_stable_lp_conflict', snapshot.checks.stableLpConflict.blockedBy, snapshot.checks.stableLpConflict.detail);
  }

  if (selectedAsset?.hasMeaningfulBorrow === true) {
    if (!snapshot.checks.currentHealth.passed || !snapshot.checks.positiveCarry.passed) {
      if (snapshot.hasStableLpPosition && toNumber(snapshot.lpBalance, 0) > 0) {
        return {
          policyId: CARRY_POLICY_ID,
          verdict: {
            execute: true,
            lane: CARRY_EXECUTION_LANE,
            operationType: 'close_carry',
            reason: !snapshot.checks.currentHealth.passed
              ? `Carry will unwind because health factor is too close to the guardrail for ${selectedAsset.symbol}.`
              : `Carry will unwind because the stable LP fee estimate no longer clears the ${selectedAsset.symbol} borrow cost.`,
            suggestedAmountUsdc: snapshot.positionValueUsd || selectedAsset.borrowUsd,
            actionAssetSymbol: selectedAsset.symbol,
            actionParams: {
              stableToken: selectedAsset.symbol,
              lpAmount: snapshot.lpBalance,
              debtAmount: roundMetric(selectedAsset.borrowAmount),
              debtUsd: roundMetric(selectedAsset.borrowUsd),
              tokenOut: selectedAsset.symbol,
            },
            blockedBy: !snapshot.checks.currentHealth.passed
              ? snapshot.checks.currentHealth.blockedBy
              : snapshot.checks.positiveCarry.blockedBy,
          },
          metrics: snapshot,
          checks: snapshot.checks,
        };
      }

      if (snapshot.checks.walletDeployable.passed) {
        const repayUsd = Math.min(selectedAsset.walletDeployableUsd, selectedAsset.borrowUsd);
        return {
          policyId: CARRY_POLICY_ID,
          verdict: {
            execute: true,
            lane: CARRY_EXECUTION_LANE,
            operationType: 'repay_wallet_balance',
            reason: `Carry will trim ${selectedAsset.symbol} debt from idle wallet balance because the spread or health buffer no longer supports the current borrow.`,
            suggestedAmountUsdc: repayUsd,
            actionAssetSymbol: selectedAsset.symbol,
            actionParams: {
              asset: selectedAsset.symbol,
              amount: roundMetric(repayUsd / Math.max(selectedAsset.priceUsd, 1)),
            },
            blockedBy: !snapshot.checks.currentHealth.passed
              ? snapshot.checks.currentHealth.blockedBy
              : snapshot.checks.positiveCarry.blockedBy,
          },
          metrics: snapshot,
          checks: snapshot.checks,
        };
      }

      return buildHoldPolicy(
        snapshot,
        'carry_unwind_waiting_for_funds',
        'wallet_balance_too_small',
        `Carry is waiting for ${selectedAsset.symbol} to return to the wallet so the debt can be trimmed safely.`,
      );
    }

    if (snapshot.checks.walletDeployable.passed && snapshot.lpShortfallUsd >= MIN_ACTION_USD) {
      const deployUsd = Math.min(selectedAsset.walletDeployableUsd, snapshot.lpShortfallUsd);
      return {
        policyId: CARRY_POLICY_ID,
        verdict: {
          execute: true,
          lane: CARRY_EXECUTION_LANE,
          operationType: 'deploy_wallet_balance',
          reason: `Deploy idle ${selectedAsset.symbol} into the stable LP while carry stays positive.`,
          suggestedAmountUsdc: deployUsd,
          actionAssetSymbol: selectedAsset.symbol,
          actionParams: {
            stableToken: selectedAsset.symbol,
            amountIn: roundMetric(deployUsd / Math.max(selectedAsset.priceUsd, 1)),
          },
          blockedBy: null,
        },
        metrics: snapshot,
        checks: snapshot.checks,
      };
    }

    return buildHoldPolicy(
      snapshot,
      'carry_position_live',
      null,
      snapshot.hasStableLpPosition
        ? `Carry is active on ${selectedAsset.symbol}. The policy is holding because the spread stays positive and the current LP already covers the visible debt.`
        : `Carry is active on ${selectedAsset.symbol}. The policy is holding because the spread stays positive and no extra idle balance needs deployment.`,
    );
  }

  if (!snapshot.checks.positiveCarry.passed) {
    return buildHoldPolicy(snapshot, 'negative_net_carry', snapshot.checks.positiveCarry.blockedBy, snapshot.checks.positiveCarry.detail);
  }

  if (!snapshot.checks.borrowCapacity.passed) {
    return buildHoldPolicy(snapshot, 'borrow_capacity_too_small', snapshot.checks.borrowCapacity.blockedBy, snapshot.checks.borrowCapacity.detail);
  }

  if (!snapshot.checks.projectedHealth.passed) {
    return buildHoldPolicy(snapshot, 'health_factor_buffer_too_thin', snapshot.checks.projectedHealth.blockedBy, snapshot.checks.projectedHealth.detail);
  }

  const borrowAmount = roundMetric(snapshot.targetOpenUsd / Math.max(selectedAsset.priceUsd, 1));
  return {
    policyId: CARRY_POLICY_ID,
    verdict: {
      execute: true,
      lane: CARRY_EXECUTION_LANE,
      operationType: 'open_carry',
      reason: `Borrow ${selectedAsset.symbol} and deploy it into the stable LP because projected net carry stays positive with a buffered health factor.`,
      suggestedAmountUsdc: snapshot.targetOpenUsd,
      actionAssetSymbol: selectedAsset.symbol,
      actionParams: {
        stableToken: selectedAsset.symbol,
        borrowAmount,
        amountIn: borrowAmount,
      },
      blockedBy: null,
    },
    metrics: snapshot,
    checks: snapshot.checks,
  };
}

module.exports = {
  CARRY_EXECUTION_LANE,
  CARRY_POLICY_ID,
  buildCarryOpportunitySnapshot,
  estimateStableLpYieldMetrics,
  evaluateCarryAutomationPolicy,
};