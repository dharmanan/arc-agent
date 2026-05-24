'use strict';

const { ethers } = require('ethers');

const agentService = require('./agentService');
const nativeLending = require('./protocols/nativeLending');
const oracle = require('./oracle');
const positionsService = require('./positionsService');
const { buildCarryOpportunitySnapshot } = require('./carryAutomationPolicy');
const { getLendingPriceSnapshot } = require('./lendingOracleService');

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];
const HEALTH_FACTOR_WARNING = 1.2;
const HEALTH_FACTOR_CRITICAL = 1.05;
const DELEVERAGE_TARGET_HEALTH_FACTOR = Number(process.env.LENDING_DELEVERAGE_TARGET_HF || '1.3');
const COLLATERAL_TOP_UP_TRIGGER_HEALTH_FACTOR = Number(process.env.LENDING_COLLATERAL_TOP_UP_TRIGGER_HF || String(HEALTH_FACTOR_WARNING));
const COLLATERAL_TOP_UP_TARGET_HEALTH_FACTOR = Number(process.env.LENDING_COLLATERAL_TOP_UP_TARGET_HF || String(DELEVERAGE_TARGET_HEALTH_FACTOR));
const LIQUIDATION_ELIGIBLE_HEALTH_FACTOR = Number(process.env.LENDING_LIQUIDATION_ELIGIBLE_HF || '1');
const BPS_SCALE = 10_000;
const RATE_KINK_BPS = Number(process.env.ARC_LENDING_RATE_KINK_BPS || '8000');
const BASE_BORROW_RATE_BPS = Number(process.env.ARC_LENDING_BASE_BORROW_RATE_BPS || '200');
const SLOPE_LOW_BPS = Number(process.env.ARC_LENDING_SLOPE_LOW_BPS || '800');
const SLOPE_HIGH_BPS = Number(process.env.ARC_LENDING_SLOPE_HIGH_BPS || '2200');
const MIN_AUTOMATION_ACTION_USD = (() => {
  const numeric = Number(process.env.LENDING_AUTOMATION_MIN_ACTION_USD || '1');
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
})();

function _getArcRpcUrl() {
  return process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
}

function _toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function _roundMetric(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function _normalizeAction(value) {
  return String(value || '').trim().toLowerCase();
}

function _normalizeAssetSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function _clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function _aprPctFromBps(value) {
  return _roundMetric(_toNumber(value, 0) / 100, 4) || 0;
}

function _apyPctFromAprPct(value) {
  const aprPct = _toNumber(value, 0);
  if (!(aprPct > 0)) return 0;
  return _roundMetric((((1 + ((aprPct / 100) / 365)) ** 365) - 1) * 100, 4) || 0;
}

function _computeBorrowRateBps(utilizationBps) {
  const normalizedUtilizationBps = _clamp(_toNumber(utilizationBps, 0), 0, BPS_SCALE);

  if (normalizedUtilizationBps <= RATE_KINK_BPS) {
    return BASE_BORROW_RATE_BPS + ((normalizedUtilizationBps * SLOPE_LOW_BPS) / RATE_KINK_BPS);
  }

  const aboveKinkBps = normalizedUtilizationBps - RATE_KINK_BPS;
  const maxAboveKinkBps = Math.max(BPS_SCALE - RATE_KINK_BPS, 1);
  return BASE_BORROW_RATE_BPS + SLOPE_LOW_BPS + ((aboveKinkBps * SLOPE_HIGH_BPS) / maxAboveKinkBps);
}

function _computeReserveRateSnapshot(reserve) {
  const totalSupplied = _toNumber(reserve?.totalSupplied, 0);
  const totalBorrowed = _toNumber(reserve?.totalBorrowed, 0);
  const reserveFactorBps = _clamp(_toNumber(reserve?.reserveFactorBps, 0), 0, BPS_SCALE);
  const utilizationBps = totalSupplied > 0
    ? _clamp((totalBorrowed / totalSupplied) * BPS_SCALE, 0, BPS_SCALE)
    : 0;
  const borrowRateBps = _computeBorrowRateBps(utilizationBps);
  const supplyRateBps = (borrowRateBps * utilizationBps * (BPS_SCALE - reserveFactorBps)) / (BPS_SCALE * BPS_SCALE);
  const borrowAprPct = _aprPctFromBps(borrowRateBps);
  const supplyAprPct = _aprPctFromBps(supplyRateBps);

  return {
    utilizationPct: _roundMetric((utilizationBps / BPS_SCALE) * 100, 4) || 0,
    borrowAprPct,
    borrowApyPct: _apyPctFromAprPct(borrowAprPct),
    supplyAprPct,
    supplyApyPct: _apyPctFromAprPct(supplyAprPct),
  };
}

function _computeLendingYieldSummary(assetEntries) {
  const totals = assetEntries.reduce((summary, assetEntry) => {
    const suppliedUsd = _toNumber(assetEntry?.position?.suppliedUsd, 0);
    const borrowUsd = _toNumber(assetEntry?.position?.borrowUsd, 0);
    const supplyApyPct = _toNumber(assetEntry?.reserve?.supplyApyPct, 0);
    const borrowApyPct = _toNumber(assetEntry?.reserve?.borrowApyPct, 0);

    summary.grossSupplyUsdPerYear += suppliedUsd * (supplyApyPct / 100);
    summary.grossBorrowCostUsdPerYear += borrowUsd * (borrowApyPct / 100);
    return summary;
  }, {
    grossSupplyUsdPerYear: 0,
    grossBorrowCostUsdPerYear: 0,
  });

  return {
    grossSupplyUsdPerYear: _roundMetric(totals.grossSupplyUsdPerYear),
    grossBorrowCostUsdPerYear: _roundMetric(totals.grossBorrowCostUsdPerYear),
    netLendingUsdPerYear: _roundMetric(totals.grossSupplyUsdPerYear - totals.grossBorrowCostUsdPerYear),
  };
}

function _getSupportedAssets() {
  return Object.values(nativeLending.SUPPORTED_LENDING_ASSETS || {}).map((asset) => ({ ...asset }));
}

function _buildPriceMap(priceSnapshot) {
  const map = new Map();
  for (const asset of priceSnapshot?.assets || []) {
    map.set(_normalizeAssetSymbol(asset.symbol), asset);
  }
  return map;
}

function _getExecutionReadinessFailure(surface) {
  if (!surface?.execution?.contractAddress) {
    return {
      execute: false,
      reason: 'lending_contract_not_configured',
      detail: 'The Arc lending contract address is not configured yet.',
    };
  }

  if (surface.execution.buildState === 'scaffold_only') {
    return {
      execute: false,
      reason: 'lending_contract_scaffold_only',
      detail: 'The Arc lending contract is still in scaffold mode, so live writes stay blocked.',
    };
  }

  if (surface.execution.globalPaused) {
    return {
      execute: false,
      reason: 'lending_globally_paused',
      detail: 'The Arc lending lane is globally paused right now.',
    };
  }

  return null;
}

async function _readWalletBalance(provider, walletAddress, asset) {
  if (!walletAddress || !asset?.address) {
    return {
      amount: null,
      amountUsd: null,
      readError: 'wallet_or_asset_missing',
    };
  }

  try {
    const contract = new ethers.Contract(asset.address, ERC20_BALANCE_ABI, provider);
    const rawBalance = await contract.balanceOf(walletAddress);
    const amount = _toNumber(ethers.formatUnits(rawBalance, Number(asset.decimals || 6)), null);
    return {
      amount,
      amountUsd: null,
      readError: null,
    };
  } catch (error) {
    return {
      amount: null,
      amountUsd: null,
      readError: error?.message || 'wallet_balance_unavailable',
    };
  }
}

function _computeRiskSummary(assetEntries, liquidity) {
  const collateralEntries = assetEntries.filter((entry) => entry.position.useAsCollateral && entry.position.suppliedAmount > 0);
  const totalSuppliedUsd = assetEntries.reduce((sum, entry) => sum + entry.position.suppliedUsd, 0);
  const totalBorrowUsd = assetEntries.reduce((sum, entry) => sum + entry.position.borrowUsd, 0);
  const collateralSuppliedUsd = collateralEntries.reduce((sum, entry) => sum + entry.position.suppliedUsd, 0);
  const collateralCapacityUsd = collateralEntries.reduce(
    (sum, entry) => sum + ((entry.position.suppliedUsd * entry.reserve.collateralFactorBps) / 10_000),
    0,
  );
  const liquidationCapacityUsd = collateralEntries.reduce(
    (sum, entry) => sum + ((entry.position.suppliedUsd * entry.reserve.liquidationThresholdBps) / 10_000),
    0,
  );
  const availableBorrowUsd = liquidity
    ? _toNumber(liquidity.availableBorrowUsd18, 0)
    : Math.max(collateralCapacityUsd - totalBorrowUsd, 0);
  const ltvPct = collateralSuppliedUsd > 0
    ? (totalBorrowUsd / collateralSuppliedUsd) * 100
    : 0;
  const healthFactor = totalBorrowUsd > 0
    ? liquidationCapacityUsd / totalBorrowUsd
    : null;

  let band = 'idle';
  let label = 'No debt';
  let detail = 'This wallet has no active lending debt, so liquidation risk is inactive.';

  if (totalBorrowUsd > 0 && Number.isFinite(healthFactor)) {
    if (healthFactor <= HEALTH_FACTOR_CRITICAL) {
      band = 'critical';
      label = 'Critical';
      detail = 'Debt is too close to the liquidation threshold. Do not add more borrow without adding collateral or repaying first.';
    } else if (healthFactor <= HEALTH_FACTOR_WARNING) {
      band = 'warning';
      label = 'Watch closely';
      detail = 'Debt is still above the liquidation line, but the remaining collateral buffer is thin.';
    } else {
      band = 'healthy';
      label = 'Buffered';
      detail = 'Collateral buffer is above the current warning threshold.';
    }
  }

  return {
    totalSuppliedUsd: _roundMetric(totalSuppliedUsd),
    totalBorrowUsd: _roundMetric(totalBorrowUsd),
    collateralSuppliedUsd: _roundMetric(collateralSuppliedUsd),
    collateralCapacityUsd: _roundMetric(collateralCapacityUsd),
    liquidationCapacityUsd: _roundMetric(liquidationCapacityUsd),
    availableBorrowUsd: _roundMetric(availableBorrowUsd),
    ltvPct: _roundMetric(ltvPct, 2),
    healthFactor: _roundMetric(healthFactor, 4),
    band,
    label,
    detail,
  };
}

function _getBaseActionGuard(surface, assetEntry, action) {
  const executionFailure = _getExecutionReadinessFailure(surface);
  if (executionFailure) {
    return executionFailure;
  }

  if (!assetEntry?.reserve.supported) {
    return {
      execute: false,
      reason: 'lending_reserve_not_supported',
      detail: 'This reserve is not configured in the Arc lending pool yet.',
    };
  }

  if (assetEntry.reserve.paused) {
    return {
      execute: false,
      reason: 'lending_reserve_paused',
      detail: 'This reserve is paused right now.',
    };
  }

  if (action === 'borrow' && !assetEntry.reserve.borrowEnabled) {
    return {
      execute: false,
      reason: 'lending_reserve_borrow_disabled',
      detail: 'Borrow is not enabled for this reserve.',
    };
  }

  return {
    execute: true,
    reason: null,
    detail: 'Ready for additional amount checks.',
  };
}

function _buildActionGuard(surface, assetEntry, action) {
  const baseGuard = _getBaseActionGuard(surface, assetEntry, action);
  if (baseGuard.execute !== true) {
    return baseGuard;
  }

  if (action === 'supply') {
    const walletAmount = _toNumber(assetEntry.wallet.amount, 0);
    if (!(walletAmount > 0)) {
      return {
        execute: false,
        reason: 'lending_wallet_balance_empty',
        detail: `No ${assetEntry.symbol} balance is available in the wallet for a supply action.`,
      };
    }

    if (assetEntry.reserve.supplyCapRemaining !== null && assetEntry.reserve.supplyCapRemaining <= 0) {
      return {
        execute: false,
        reason: 'lending_supply_cap_reached',
        detail: 'This reserve has no visible supply capacity left.',
      };
    }
  }

  if (action === 'withdraw' && !(assetEntry.position.suppliedAmount > 0)) {
    return {
      execute: false,
      reason: 'lending_supply_position_required',
      detail: `There is no supplied ${assetEntry.symbol} balance to withdraw yet.`,
    };
  }

  if (action === 'borrow') {
    if (!(surface.risk.availableBorrowUsd > 0)) {
      return {
        execute: false,
        reason: 'lending_borrow_capacity_unavailable',
        detail: 'No borrow capacity is available yet. Supply collateral first.',
      };
    }

    if (assetEntry.reserve.borrowCapRemaining !== null && assetEntry.reserve.borrowCapRemaining <= 0) {
      return {
        execute: false,
        reason: 'lending_borrow_cap_reached',
        detail: 'This reserve has no visible borrow capacity left.',
      };
    }
  }

  if (action === 'repay') {
    if (!(assetEntry.position.borrowAmount > 0)) {
      return {
        execute: false,
        reason: 'lending_borrow_position_required',
        detail: `There is no active ${assetEntry.symbol} debt to repay.`,
      };
    }

    const walletAmount = _toNumber(assetEntry.wallet.amount, 0);
    if (!(walletAmount > 0)) {
      return {
        execute: false,
        reason: 'lending_wallet_balance_empty',
        detail: `No ${assetEntry.symbol} balance is available in the wallet for a repay action.`,
      };
    }
  }

  return {
    execute: true,
    reason: null,
    detail: `Manual ${action} can be queued for ${assetEntry.symbol}.`,
  };
}

function evaluateEmergencyDeleverage(surface) {
  const currentHealthFactor = _toNumber(surface?.risk?.healthFactor, NaN);
  const totalBorrowUsd = _toNumber(surface?.risk?.totalBorrowUsd, 0);
  const liquidationCapacityUsd = _toNumber(surface?.risk?.liquidationCapacityUsd, 0);

  if (!(totalBorrowUsd > 0)) {
    return {
      execute: false,
      status: 'idle',
      reason: 'lending_deleverage_not_required',
      detail: 'There is no lending debt to deleverage.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: null,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      repayUsdNeeded: 0,
      repayUsdPlanned: 0,
      repayUsdShortfall: 0,
      steps: [],
    };
  }

  if (Number.isFinite(currentHealthFactor) && currentHealthFactor > HEALTH_FACTOR_WARNING) {
    return {
      execute: false,
      status: 'not_required',
      reason: 'lending_deleverage_not_required',
      detail: 'The current health factor is still above the emergency deleverage trigger.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: DELEVERAGE_TARGET_HEALTH_FACTOR,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      repayUsdNeeded: 0,
      repayUsdPlanned: 0,
      repayUsdShortfall: 0,
      steps: [],
    };
  }

  const repayUsdNeeded = Math.max(totalBorrowUsd - (liquidationCapacityUsd / DELEVERAGE_TARGET_HEALTH_FACTOR), 0);
  if (repayUsdNeeded > 0 && repayUsdNeeded < MIN_AUTOMATION_ACTION_USD) {
    return {
      execute: false,
      status: 'dust_guarded',
      reason: 'lending_deleverage_below_min_action_usd',
      detail: 'Emergency deleverage is skipped because the visible repay need stays below the minimum automatic lending action size.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: DELEVERAGE_TARGET_HEALTH_FACTOR,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      repayUsdNeeded: _roundMetric(repayUsdNeeded),
      repayUsdPlanned: 0,
      repayUsdShortfall: _roundMetric(repayUsdNeeded),
      steps: [],
    };
  }

  let remainingRepayUsd = repayUsdNeeded;
  const debtAssets = (surface?.assets || [])
    .filter((assetEntry) => _toNumber(assetEntry.position.borrowUsd, 0) > 0)
    .sort((left, right) => _toNumber(right.position.borrowUsd, 0) - _toNumber(left.position.borrowUsd, 0));

  const steps = [];

  for (const assetEntry of debtAssets) {
    if (!(remainingRepayUsd > 0)) break;

    const walletUsd = _toNumber(assetEntry.wallet.amountUsd, 0);
    const borrowUsd = _toNumber(assetEntry.position.borrowUsd, 0);
    const priceUsd = _toNumber(assetEntry.price.priceUsd, 0);
    if (!(walletUsd > 0) || !(borrowUsd > 0) || !(priceUsd > 0)) continue;

    const repayUsd = Math.min(walletUsd, borrowUsd, remainingRepayUsd);
    if (!(repayUsd >= MIN_AUTOMATION_ACTION_USD)) continue;

    const amount = repayUsd / priceUsd;
    steps.push({
      action: 'repay',
      asset: assetEntry.symbol,
      amount: _roundMetric(amount),
      usdAmount: _roundMetric(repayUsd),
      availableWalletAmount: assetEntry.wallet.amount,
      currentDebtAmount: assetEntry.position.borrowAmount,
    });
    remainingRepayUsd = Math.max(remainingRepayUsd - repayUsd, 0);
  }

  const repayUsdPlanned = Math.max(repayUsdNeeded - remainingRepayUsd, 0);
  const projectedBorrowUsd = Math.max(totalBorrowUsd - repayUsdPlanned, 0);
  const projectedHealthFactor = projectedBorrowUsd > 0
    ? _roundMetric(liquidationCapacityUsd / projectedBorrowUsd, 4)
    : null;
  const repayUsdShortfall = _roundMetric(remainingRepayUsd);

  if (steps.length === 0) {
    return {
      execute: false,
      status: 'needs_funding',
      reason: 'lending_deleverage_wallet_funds_required',
      detail: 'Emergency deleverage needs wallet funds in the same debt asset before any repay step can be sent.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: DELEVERAGE_TARGET_HEALTH_FACTOR,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      repayUsdNeeded: _roundMetric(repayUsdNeeded),
      repayUsdPlanned: 0,
      repayUsdShortfall,
      steps: [],
    };
  }

  const status = remainingRepayUsd > 0 ? 'partial' : 'ready';
  const detail = remainingRepayUsd > 0
    ? 'Available wallet funds can reduce debt, but more same-asset funds are still needed to fully restore the target health factor.'
    : 'Available wallet funds are sufficient to run the emergency deleverage plan to the current target health factor.';

  return {
    execute: true,
    status,
    reason: null,
    detail,
    currentHealthFactor: surface?.risk?.healthFactor ?? null,
    targetHealthFactor: DELEVERAGE_TARGET_HEALTH_FACTOR,
    projectedHealthFactor,
    repayUsdNeeded: _roundMetric(repayUsdNeeded),
    repayUsdPlanned: _roundMetric(repayUsdPlanned),
    repayUsdShortfall,
    steps,
  };
}

function evaluateCollateralTopUp(surface) {
  const currentHealthFactor = _toNumber(surface?.risk?.healthFactor, NaN);
  const totalBorrowUsd = _toNumber(surface?.risk?.totalBorrowUsd, 0);
  const liquidationCapacityUsd = _toNumber(surface?.risk?.liquidationCapacityUsd, 0);

  if (!(totalBorrowUsd > 0)) {
    return {
      execute: false,
      status: 'idle',
      reason: 'lending_collateral_topup_not_required',
      detail: 'There is no active lending debt, so collateral top-up is not needed.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: null,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      collateralUsdNeeded: 0,
      collateralUsdPlanned: 0,
      collateralUsdShortfall: 0,
      steps: [],
    };
  }

  if (Number.isFinite(currentHealthFactor) && currentHealthFactor > COLLATERAL_TOP_UP_TRIGGER_HEALTH_FACTOR) {
    return {
      execute: false,
      status: 'not_required',
      reason: 'lending_collateral_topup_not_required',
      detail: 'The current health factor is still above the collateral top-up trigger.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: COLLATERAL_TOP_UP_TARGET_HEALTH_FACTOR,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      collateralUsdNeeded: 0,
      collateralUsdPlanned: 0,
      collateralUsdShortfall: 0,
      steps: [],
    };
  }

  const liquidationCapacityShortfallUsd = Math.max(
    (totalBorrowUsd * COLLATERAL_TOP_UP_TARGET_HEALTH_FACTOR) - liquidationCapacityUsd,
    0,
  );

  if (liquidationCapacityShortfallUsd > 0 && liquidationCapacityShortfallUsd < MIN_AUTOMATION_ACTION_USD) {
    return {
      execute: false,
      status: 'dust_guarded',
      reason: 'lending_collateral_topup_below_min_action_usd',
      detail: 'Collateral top-up is skipped because the visible top-up need stays below the minimum automatic lending action size.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: COLLATERAL_TOP_UP_TARGET_HEALTH_FACTOR,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      collateralUsdNeeded: _roundMetric(liquidationCapacityShortfallUsd),
      collateralUsdPlanned: 0,
      collateralUsdShortfall: _roundMetric(liquidationCapacityShortfallUsd),
      steps: [],
    };
  }

  if (!(liquidationCapacityShortfallUsd > 0)) {
    return {
      execute: false,
      status: 'not_required',
      reason: 'lending_collateral_topup_not_required',
      detail: 'Visible collateral capacity is already sufficient for the current top-up target.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: COLLATERAL_TOP_UP_TARGET_HEALTH_FACTOR,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      collateralUsdNeeded: 0,
      collateralUsdPlanned: 0,
      collateralUsdShortfall: 0,
      steps: [],
    };
  }

  let remainingCapacityShortfallUsd = liquidationCapacityShortfallUsd;
  const supplyAssets = (surface?.assets || [])
    .filter((assetEntry) => (
      assetEntry?.reserve?.supported === true
        && assetEntry?.reserve?.paused !== true
        && assetEntry?.reserve?.collateralEnabled !== false
        && _toNumber(assetEntry?.wallet?.amount, 0) > 0
        && _toNumber(assetEntry?.wallet?.amountUsd, 0) > 0
        && _toNumber(assetEntry?.price?.priceUsd, 0) > 0
        && _toNumber(assetEntry?.reserve?.liquidationThresholdBps, 0) > 0
    ))
    .sort((left, right) => (
      _toNumber(right?.wallet?.amountUsd, 0) - _toNumber(left?.wallet?.amountUsd, 0)
        || _toNumber(right?.reserve?.liquidationThresholdBps, 0) - _toNumber(left?.reserve?.liquidationThresholdBps, 0)
    ));

  const steps = [];

  for (const assetEntry of supplyAssets) {
    if (!(remainingCapacityShortfallUsd > 0)) break;

    const priceUsd = _toNumber(assetEntry.price?.priceUsd, 0);
    const walletUsd = _toNumber(assetEntry.wallet?.amountUsd, 0);
    const walletAmount = _toNumber(assetEntry.wallet?.amount, 0);
    const liquidationFactor = _toNumber(assetEntry.reserve?.liquidationThresholdBps, 0) / 10_000;

    if (!(priceUsd > 0) || !(walletUsd > 0) || !(walletAmount > 0) || !(liquidationFactor > 0)) {
      continue;
    }

    const neededSupplyUsd = remainingCapacityShortfallUsd / liquidationFactor;
    const supplyUsd = Math.min(walletUsd, neededSupplyUsd);
    const supplyAmount = supplyUsd / priceUsd;
    const liquidationCapacityAddedUsd = supplyUsd * liquidationFactor;

    if (!(supplyUsd >= MIN_AUTOMATION_ACTION_USD) || !(supplyAmount > 0) || !(liquidationCapacityAddedUsd > 0)) {
      continue;
    }

    steps.push({
      action: 'supply',
      asset: assetEntry.symbol,
      amount: _roundMetric(supplyAmount),
      usdAmount: _roundMetric(supplyUsd),
      availableWalletAmount: assetEntry.wallet.amount,
      availableWalletUsd: _roundMetric(walletUsd),
      liquidationThresholdBps: assetEntry.reserve.liquidationThresholdBps,
      liquidationCapacityAddedUsd: _roundMetric(liquidationCapacityAddedUsd),
    });

    remainingCapacityShortfallUsd = Math.max(remainingCapacityShortfallUsd - liquidationCapacityAddedUsd, 0);
  }

  const collateralUsdPlanned = steps.reduce((sum, step) => sum + _toNumber(step.usdAmount, 0), 0);
  const liquidationCapacityAddedUsd = steps.reduce((sum, step) => sum + _toNumber(step.liquidationCapacityAddedUsd, 0), 0);
  const projectedHealthFactor = totalBorrowUsd > 0
    ? _roundMetric((liquidationCapacityUsd + liquidationCapacityAddedUsd) / totalBorrowUsd, 4)
    : null;
  const collateralUsdShortfall = _roundMetric(remainingCapacityShortfallUsd);

  if (steps.length === 0) {
    return {
      execute: false,
      status: 'needs_funding',
      reason: 'lending_collateral_topup_wallet_funds_required',
      detail: 'Collateral top-up needs wallet funds in a supported collateral asset before any supply step can run.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      targetHealthFactor: COLLATERAL_TOP_UP_TARGET_HEALTH_FACTOR,
      projectedHealthFactor: surface?.risk?.healthFactor ?? null,
      collateralUsdNeeded: _roundMetric(liquidationCapacityShortfallUsd),
      collateralUsdPlanned: 0,
      collateralUsdShortfall: _roundMetric(liquidationCapacityShortfallUsd),
      steps: [],
    };
  }

  return {
    execute: true,
    status: remainingCapacityShortfallUsd > 0 ? 'partial' : 'ready',
    reason: null,
    detail: remainingCapacityShortfallUsd > 0
      ? 'Visible wallet collateral can improve the health factor, but more wallet funds are still needed to reach the current top-up target.'
      : 'Visible wallet collateral is sufficient to top the lending account back to the current target health factor.',
    currentHealthFactor: surface?.risk?.healthFactor ?? null,
    targetHealthFactor: COLLATERAL_TOP_UP_TARGET_HEALTH_FACTOR,
    projectedHealthFactor,
    collateralUsdNeeded: _roundMetric(liquidationCapacityShortfallUsd),
    collateralUsdPlanned: _roundMetric(collateralUsdPlanned),
    collateralUsdShortfall,
    steps,
  };
}

function evaluateSafeExit(surface) {
  const totalBorrowUsd = _toNumber(surface?.risk?.totalBorrowUsd, 0);
  const totalSuppliedUsd = _toNumber(surface?.risk?.totalSuppliedUsd, 0);

  if (!(totalBorrowUsd > 0) && !(totalSuppliedUsd > 0)) {
    return {
      execute: false,
      status: 'idle',
      reason: 'lending_safe_exit_not_required',
      detail: 'There is no active supplied or borrowed lending position to close.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      repayUsdNeeded: 0,
      repayUsdPlanned: 0,
      repayUsdShortfall: 0,
      withdrawUsdPlanned: 0,
      steps: [],
    };
  }

  const debtAssets = (surface?.assets || [])
    .filter((assetEntry) => _toNumber(assetEntry?.position?.borrowUsd, 0) > 0)
    .sort((left, right) => _toNumber(right?.position?.borrowUsd, 0) - _toNumber(left?.position?.borrowUsd, 0));
  const repaySteps = [];
  let repayUsdPlanned = 0;
  let repayUsdShortfall = 0;

  for (const assetEntry of debtAssets) {
    const borrowAmount = _toNumber(assetEntry.position?.borrowAmount, 0);
    const borrowUsd = _toNumber(assetEntry.position?.borrowUsd, 0);
    const walletAmount = _toNumber(assetEntry.wallet?.amount, 0);
    const walletUsd = _toNumber(assetEntry.wallet?.amountUsd, 0);
    const priceUsd = _toNumber(assetEntry.price?.priceUsd, 0);

    if (!(borrowAmount > 0) || !(borrowUsd > 0)) continue;

    if (!(walletAmount > 0) || !(walletUsd > 0) || !(priceUsd > 0)) {
      repayUsdShortfall += borrowUsd;
      continue;
    }

    const repayAmount = Math.min(walletAmount, borrowAmount);
    const plannedRepayUsd = Math.min(walletUsd, borrowUsd, repayAmount * priceUsd);

    if (!(repayAmount > 0) || !(plannedRepayUsd > 0)) {
      repayUsdShortfall += borrowUsd;
      continue;
    }

    repaySteps.push({
      action: 'repay',
      asset: assetEntry.symbol,
      amount: _roundMetric(repayAmount),
      usdAmount: _roundMetric(plannedRepayUsd),
      availableWalletAmount: assetEntry.wallet.amount,
      currentDebtAmount: assetEntry.position.borrowAmount,
    });

    repayUsdPlanned += plannedRepayUsd;
    repayUsdShortfall += Math.max(borrowUsd - plannedRepayUsd, 0);
  }

  if (totalBorrowUsd > 0 && repayUsdShortfall > 0) {
    return {
      execute: false,
      status: 'needs_funding',
      reason: 'lending_safe_exit_wallet_funds_required',
      detail: 'Safe exit needs enough wallet funds to fully repay every active lending debt before collateral can be withdrawn.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      repayUsdNeeded: _roundMetric(totalBorrowUsd),
      repayUsdPlanned: _roundMetric(repayUsdPlanned),
      repayUsdShortfall: _roundMetric(repayUsdShortfall),
      withdrawUsdPlanned: 0,
      steps: repaySteps,
    };
  }

  const withdrawSteps = (surface?.assets || [])
    .filter((assetEntry) => _toNumber(assetEntry?.position?.suppliedAmount, 0) > 0)
    .sort((left, right) => _toNumber(right?.position?.suppliedUsd, 0) - _toNumber(left?.position?.suppliedUsd, 0))
    .map((assetEntry) => ({
      action: 'withdraw',
      asset: assetEntry.symbol,
      amount: _roundMetric(_toNumber(assetEntry.position?.suppliedAmount, 0)),
      usdAmount: _roundMetric(_toNumber(assetEntry.position?.suppliedUsd, 0)),
      currentSuppliedAmount: assetEntry.position.suppliedAmount,
    }))
    .filter((step) => _toNumber(step.amount, 0) > 0);

  const withdrawUsdPlanned = withdrawSteps.reduce((sum, step) => sum + _toNumber(step.usdAmount, 0), 0);
  const steps = [...repaySteps, ...withdrawSteps];

  if (steps.length === 0) {
    return {
      execute: false,
      status: 'idle',
      reason: 'lending_safe_exit_not_required',
      detail: 'There is no active lending position left to close safely.',
      currentHealthFactor: surface?.risk?.healthFactor ?? null,
      repayUsdNeeded: 0,
      repayUsdPlanned: 0,
      repayUsdShortfall: 0,
      withdrawUsdPlanned: 0,
      steps: [],
    };
  }

  return {
    execute: true,
    status: 'ready',
    reason: null,
    detail: totalBorrowUsd > 0
      ? 'Wallet funds can fully repay the visible debt and withdraw the remaining supplied collateral in one safe exit flow.'
      : 'No debt is active. Safe exit can withdraw the remaining supplied collateral.',
    currentHealthFactor: surface?.risk?.healthFactor ?? null,
    repayUsdNeeded: _roundMetric(totalBorrowUsd),
    repayUsdPlanned: _roundMetric(repayUsdPlanned),
    repayUsdShortfall: 0,
    withdrawUsdPlanned: _roundMetric(withdrawUsdPlanned),
    steps,
  };
}

function evaluateSelfLiquidationStatus(surface) {
  const totalBorrowUsd = _toNumber(surface?.risk?.totalBorrowUsd, 0);
  const healthFactor = _toNumber(surface?.risk?.healthFactor, NaN);

  if (!(totalBorrowUsd > 0)) {
    return {
      liquidatable: false,
      status: 'idle',
      reason: null,
      detail: 'No debt is active, so liquidation is not relevant for this account.',
      healthFactor: surface?.risk?.healthFactor ?? null,
    };
  }

  if (!Number.isFinite(healthFactor)) {
    return {
      liquidatable: false,
      status: 'unknown',
      reason: 'lending_liquidation_health_unknown',
      detail: 'Liquidation status cannot be determined until a valid health factor is available.',
      healthFactor: surface?.risk?.healthFactor ?? null,
    };
  }

  if (healthFactor < LIQUIDATION_ELIGIBLE_HEALTH_FACTOR) {
    return {
      liquidatable: true,
      status: 'liquidatable',
      reason: 'lending_liquidation_eligible',
      detail: 'This account is below the liquidation threshold and can be targeted by a liquidation executor.',
      healthFactor: surface?.risk?.healthFactor ?? null,
    };
  }

  if (healthFactor <= HEALTH_FACTOR_CRITICAL) {
    return {
      liquidatable: false,
      status: 'critical',
      reason: 'lending_liquidation_close',
      detail: 'This account is still above the liquidation line, but it is within the critical recovery band.',
      healthFactor: surface?.risk?.healthFactor ?? null,
    };
  }

  return {
    liquidatable: false,
    status: 'safe',
    reason: null,
    detail: 'This account is not currently liquidatable.',
    healthFactor: surface?.risk?.healthFactor ?? null,
  };
}

function evaluateLiquidationOpportunity({ liquidatorSurface, borrowerSurface, debtAsset, collateralAsset, amount }) {
  const normalizedDebtAsset = _normalizeAssetSymbol(debtAsset);
  const normalizedCollateralAsset = _normalizeAssetSymbol(collateralAsset);
  const numericAmount = _toNumber(amount, NaN);
  const executionFailure = _getExecutionReadinessFailure(liquidatorSurface);

  if (executionFailure) {
    return executionFailure;
  }

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return {
      execute: false,
      reason: 'lending_liquidation_amount_required',
      detail: 'Enter a positive repay amount before submitting a liquidation.',
    };
  }

  if (!borrowerSurface?.walletAddress) {
    return {
      execute: false,
      reason: 'lending_liquidation_borrower_required',
      detail: 'A borrower address is required for liquidation.',
    };
  }

  if (String(borrowerSurface.walletAddress).toLowerCase() === String(liquidatorSurface?.walletAddress || '').toLowerCase()) {
    return {
      execute: false,
      reason: 'lending_liquidation_self_target_invalid',
      detail: 'Liquidation must target another account, not the liquidator wallet itself.',
    };
  }

  if (!borrowerSurface?.liquidation?.liquidatable) {
    return {
      execute: false,
      reason: 'lending_liquidation_target_healthy',
      detail: 'The target account is not below the liquidation threshold right now.',
    };
  }

  const borrowerDebtEntry = (borrowerSurface.assets || []).find((assetEntry) => assetEntry.symbol === normalizedDebtAsset);
  if (!borrowerDebtEntry || !(_toNumber(borrowerDebtEntry.position.borrowAmount, 0) > 0)) {
    return {
      execute: false,
      reason: 'lending_liquidation_target_debt_missing',
      detail: `The target account does not have an active ${normalizedDebtAsset} debt position.`,
    };
  }

  const borrowerCollateralEntry = (borrowerSurface.assets || []).find((assetEntry) => assetEntry.symbol === normalizedCollateralAsset);
  if (!borrowerCollateralEntry || !(_toNumber(borrowerCollateralEntry.position.suppliedAmount, 0) > 0) || borrowerCollateralEntry.position.useAsCollateral !== true) {
    return {
      execute: false,
      reason: 'lending_liquidation_target_collateral_missing',
      detail: `The target account does not have an active ${normalizedCollateralAsset} collateral position.`,
    };
  }

  const liquidatorDebtEntry = (liquidatorSurface.assets || []).find((assetEntry) => assetEntry.symbol === normalizedDebtAsset);
  const walletAmount = _toNumber(liquidatorDebtEntry?.wallet?.amount, 0);
  if (!(walletAmount > 0)) {
    return {
      execute: false,
      reason: 'lending_wallet_balance_empty',
      detail: `No ${normalizedDebtAsset} balance is available in the liquidator wallet.`,
    };
  }

  const maxLiquidationAmount = Math.min(walletAmount, _toNumber(borrowerDebtEntry.position.borrowAmount, 0));
  if (numericAmount > maxLiquidationAmount) {
    return {
      execute: false,
      reason: 'lending_liquidation_amount_too_high',
      detail: `Requested liquidation amount is above the visible ${normalizedDebtAsset} wallet balance or target debt balance.`,
    };
  }

  return {
    execute: true,
    reason: null,
    detail: `Liquidation can be attempted against ${borrowerSurface.walletAddress} using ${normalizedDebtAsset} debt repayment into ${normalizedCollateralAsset} collateral.`,
    amount: numericAmount,
    liquidatorDebtEntry,
    borrowerDebtEntry,
    borrowerCollateralEntry,
  };
}

async function buildLendingSurfaceForWallet(walletAddress) {
  const supportedAssets = _getSupportedAssets();
  const provider = new ethers.JsonRpcProvider(_getArcRpcUrl());

  const [overview, accountOverview, priceSnapshot, walletBalances] = await Promise.all([
    nativeLending.getNativeLendingOverview(),
    nativeLending.getNativeLendingAccountOverview(walletAddress),
    getLendingPriceSnapshot(supportedAssets.map((asset) => asset.symbol)),
    Promise.all(supportedAssets.map((asset) => _readWalletBalance(provider, walletAddress, asset))),
  ]);

  const priceMap = _buildPriceMap(priceSnapshot);
  const reserveMap = new Map((overview?.reserves || []).map((reserve) => [_normalizeAssetSymbol(reserve.symbol), reserve]));
  const positionMap = new Map((accountOverview?.positions || []).map((position) => [_normalizeAssetSymbol(position.symbol), position]));

  const assets = supportedAssets.map((asset, index) => {
    const reserve = reserveMap.get(asset.symbol) || null;
    const position = positionMap.get(asset.symbol) || null;
    const price = priceMap.get(asset.symbol) || {
      symbol: asset.symbol,
      priceUsd: 1,
      source: 'stable_par_fallback',
      isFallback: true,
      fallbackReason: 'price_missing',
    };
    const wallet = walletBalances[index] || { amount: null, amountUsd: null, readError: 'wallet_balance_unavailable' };
    const suppliedAmount = _toNumber(position?.suppliedPrincipal, 0);
    const borrowAmount = _toNumber(position?.borrowPrincipal, 0);
    const priceUsd = _toNumber(price.priceUsd, 1);
    const totalSupplied = _toNumber(reserve?.totalSupplied, 0);
    const totalBorrowed = _toNumber(reserve?.totalBorrowed, 0);
    const supplyCap = reserve?.supplyCap == null ? null : _toNumber(reserve.supplyCap, null);
    const borrowCap = reserve?.borrowCap == null ? null : _toNumber(reserve.borrowCap, null);
    const rateSnapshot = _computeReserveRateSnapshot(reserve);

    return {
      symbol: asset.symbol,
      assetAddress: asset.address,
      decimals: Number(asset.decimals || reserve?.decimals || 6),
      price: {
        priceUsd,
        source: price.source,
        isFallback: Boolean(price.isFallback),
        fallbackReason: price.fallbackReason || null,
      },
      wallet: {
        amount: wallet.amount,
        amountUsd: wallet.amount === null ? null : _roundMetric(wallet.amount * priceUsd),
        readError: wallet.readError,
      },
      reserve: {
        supported: Boolean(reserve),
        paused: Boolean(reserve?.paused),
        collateralEnabled: Boolean(reserve?.collateralEnabled),
        borrowEnabled: Boolean(reserve?.borrowEnabled),
        collateralFactorBps: Number(reserve?.collateralFactorBps || 0),
        liquidationThresholdBps: Number(reserve?.liquidationThresholdBps || 0),
        liquidationBonusBps: Number(reserve?.liquidationBonusBps || 0),
        reserveFactorBps: Number(reserve?.reserveFactorBps || 0),
        totalSupplied: reserve?.totalSupplied || null,
        totalBorrowed: reserve?.totalBorrowed || null,
        supplyCap: reserve?.supplyCap || null,
        borrowCap: reserve?.borrowCap || null,
        supplyCapRemaining: supplyCap === null ? null : _roundMetric(Math.max(supplyCap - totalSupplied, 0)),
        borrowCapRemaining: borrowCap === null ? null : _roundMetric(Math.max(borrowCap - totalBorrowed, 0)),
        lastAccrualTimestamp: reserve?.lastAccrualTimestamp || null,
        utilizationPct: rateSnapshot.utilizationPct,
        borrowAprPct: rateSnapshot.borrowAprPct,
        borrowApyPct: rateSnapshot.borrowApyPct,
        supplyAprPct: rateSnapshot.supplyAprPct,
        supplyApyPct: rateSnapshot.supplyApyPct,
      },
      position: {
        suppliedAmount: _roundMetric(suppliedAmount),
        suppliedUsd: _roundMetric(suppliedAmount * priceUsd) || 0,
        borrowAmount: _roundMetric(borrowAmount),
        borrowUsd: _roundMetric(borrowAmount * priceUsd) || 0,
        useAsCollateral: Boolean(position?.useAsCollateral),
      },
    };
  });

  const risk = _computeRiskSummary(assets, accountOverview?.liquidity || null);
  const yieldSummary = _computeLendingYieldSummary(assets);
  const actionGuards = Object.fromEntries(assets.map((assetEntry) => [
    assetEntry.symbol,
    {
      supply: _buildActionGuard({ execution: overview, risk }, assetEntry, 'supply'),
      withdraw: _buildActionGuard({ execution: overview, risk }, assetEntry, 'withdraw'),
      borrow: _buildActionGuard({ execution: overview, risk }, assetEntry, 'borrow'),
      repay: _buildActionGuard({ execution: overview, risk }, assetEntry, 'repay'),
    },
  ]));

  const baseSurface = {
    walletAddress,
    execution: {
      source: overview?.source || 'arc_native_scaffold',
      contractAddress: overview?.contractAddress || null,
      buildState: overview?.buildState || 'scaffold_only',
      globalPaused: Boolean(overview?.globalPaused),
      ready: Boolean(overview?.contractAddress) && overview?.buildState !== 'scaffold_only' && overview?.globalPaused !== true,
      notes: Array.isArray(overview?.notes) ? overview.notes : [],
      live: Boolean(overview?.live),
      actions: Array.isArray(overview?.actions) ? overview.actions : ['supply', 'withdraw', 'borrow', 'repay'],
    },
    prices: priceSnapshot,
    account: {
      liquidity: accountOverview?.liquidity || null,
      positions: assets.filter((assetEntry) => assetEntry.position.suppliedAmount > 0 || assetEntry.position.borrowAmount > 0),
    },
    assets,
    risk,
    yield: yieldSummary,
    actionGuards,
  };

  return {
    ...baseSurface,
    recovery: evaluateEmergencyDeleverage(baseSurface),
    collateralTopUp: evaluateCollateralTopUp(baseSurface),
    safeExit: evaluateSafeExit(baseSurface),
    liquidation: evaluateSelfLiquidationStatus(baseSurface),
  };
}

function evaluateManualLendingAction({ surface, action, asset, amount }) {
  const normalizedAction = _normalizeAction(action);
  const normalizedAsset = _normalizeAssetSymbol(asset);
  const numericAmount = _toNumber(amount, NaN);

  if (!['supply', 'withdraw', 'borrow', 'repay'].includes(normalizedAction)) {
    return {
      execute: false,
      reason: 'manual_lending_action_invalid',
      detail: 'Only supply, withdraw, borrow, and repay are supported for manual lending.',
    };
  }

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return {
      execute: false,
      reason: 'lending_amount_required',
      detail: 'Enter a positive amount before submitting a manual lending action.',
    };
  }

  const assetEntry = surface.assets.find((entry) => entry.symbol === normalizedAsset);
  if (!assetEntry) {
    return {
      execute: false,
      reason: 'lending_reserve_not_supported',
      detail: 'This lending asset is not part of the current v1 scope.',
    };
  }

  const baseGuard = surface.actionGuards?.[normalizedAsset]?.[normalizedAction] || _buildActionGuard(surface, assetEntry, normalizedAction);
  if (baseGuard.execute !== true) {
    return {
      ...baseGuard,
      asset: assetEntry,
    };
  }

  if (normalizedAction === 'supply' || normalizedAction === 'repay') {
    const walletAmount = _toNumber(assetEntry.wallet.amount, 0);
    if (numericAmount > walletAmount) {
      return {
        execute: false,
        reason: 'lending_wallet_balance_too_low',
        detail: `Requested amount is above the visible ${assetEntry.symbol} wallet balance.`,
        asset: assetEntry,
      };
    }
  }

  if (normalizedAction === 'withdraw' && numericAmount > _toNumber(assetEntry.position.suppliedAmount, 0)) {
    return {
      execute: false,
      reason: 'lending_withdraw_amount_exceeds_supply',
      detail: `Requested amount is above the visible supplied ${assetEntry.symbol} balance.`,
      asset: assetEntry,
    };
  }

  if (normalizedAction === 'borrow') {
    const maxBorrowAmount = assetEntry.price.priceUsd > 0
      ? _toNumber(surface.risk.availableBorrowUsd, 0) / assetEntry.price.priceUsd
      : 0;
    if (numericAmount > maxBorrowAmount) {
      return {
        execute: false,
        reason: 'lending_borrow_capacity_exceeded',
        detail: `Requested amount is above the visible ${assetEntry.symbol} borrow capacity.`,
        asset: assetEntry,
      };
    }
  }

  if (normalizedAction === 'repay' && numericAmount > _toNumber(assetEntry.position.borrowAmount, 0)) {
    return {
      execute: false,
      reason: 'lending_repay_amount_exceeds_debt',
      detail: `Requested amount is above the visible ${assetEntry.symbol} debt balance.`,
      asset: assetEntry,
    };
  }

  return {
    execute: true,
    reason: null,
    detail: `Manual ${normalizedAction} is within the current visible guardrails for ${assetEntry.symbol}.`,
    asset: assetEntry,
  };
}

async function guardAgentManualLendingAction({ agent, action, asset, amount }) {
  const walletAddress = agent?.wallet_address || agent?.walletAddress || null;
  if (!walletAddress) {
    return {
      ok: false,
      code: 'wallet_not_configured',
      verdict: {
        execute: false,
        reason: 'wallet_not_configured',
        detail: 'This agent does not have a wallet address configured.',
      },
      surface: null,
    };
  }

  const surface = await buildLendingSurfaceForWallet(walletAddress);
  const verdict = evaluateManualLendingAction({ surface, action, asset, amount });
  if (verdict.execute !== true) {
    return {
      ok: false,
      code: verdict.reason || 'native_lending_action_blocked',
      verdict,
      surface,
    };
  }

  return {
    ok: true,
    verdict,
    surface,
    asset: verdict.asset,
  };
}

async function guardAgentEmergencyDeleverage({ agent }) {
  const walletAddress = agent?.wallet_address || agent?.walletAddress || null;
  if (!walletAddress) {
    return {
      ok: false,
      code: 'wallet_not_configured',
      verdict: {
        execute: false,
        reason: 'wallet_not_configured',
        detail: 'This agent does not have a wallet address configured.',
      },
      surface: null,
    };
  }

  const surface = await buildLendingSurfaceForWallet(walletAddress);
  const recovery = surface.recovery || evaluateEmergencyDeleverage(surface);
  if (recovery.execute !== true) {
    return {
      ok: false,
      code: recovery.reason || 'lending_deleverage_not_available',
      verdict: recovery,
      surface,
    };
  }

  const executionFailure = _getExecutionReadinessFailure(surface);
  if (executionFailure) {
    return {
      ok: false,
      code: executionFailure.reason,
      verdict: executionFailure,
      surface,
    };
  }

  for (const step of recovery.steps) {
    const verdict = evaluateManualLendingAction({
      surface,
      action: step.action,
      asset: step.asset,
      amount: step.amount,
    });

    if (verdict.execute !== true) {
      return {
        ok: false,
        code: verdict.reason || 'lending_deleverage_step_blocked',
        verdict,
        surface,
      };
    }
  }

  return {
    ok: true,
    verdict: recovery,
    surface,
  };
}

async function guardAgentCollateralTopUp({ agent }) {
  const walletAddress = agent?.wallet_address || agent?.walletAddress || null;
  if (!walletAddress) {
    return {
      ok: false,
      code: 'wallet_not_configured',
      verdict: {
        execute: false,
        reason: 'wallet_not_configured',
        detail: 'This agent does not have a wallet address configured.',
      },
      surface: null,
    };
  }

  const surface = await buildLendingSurfaceForWallet(walletAddress);
  const topUp = surface.collateralTopUp || evaluateCollateralTopUp(surface);
  if (topUp.execute !== true) {
    return {
      ok: false,
      code: topUp.reason || 'lending_collateral_topup_not_available',
      verdict: topUp,
      surface,
    };
  }

  const executionFailure = _getExecutionReadinessFailure(surface);
  if (executionFailure) {
    return {
      ok: false,
      code: executionFailure.reason,
      verdict: executionFailure,
      surface,
    };
  }

  for (const step of topUp.steps) {
    const verdict = evaluateManualLendingAction({
      surface,
      action: step.action,
      asset: step.asset,
      amount: step.amount,
    });

    if (verdict.execute !== true) {
      return {
        ok: false,
        code: verdict.reason || 'lending_collateral_topup_step_blocked',
        verdict,
        surface,
      };
    }
  }

  return {
    ok: true,
    verdict: topUp,
    surface,
  };
}

async function guardAgentSafeExit({ agent }) {
  const walletAddress = agent?.wallet_address || agent?.walletAddress || null;
  if (!walletAddress) {
    return {
      ok: false,
      code: 'wallet_not_configured',
      verdict: {
        execute: false,
        reason: 'wallet_not_configured',
        detail: 'This agent does not have a wallet address configured.',
      },
      surface: null,
    };
  }

  const surface = await buildLendingSurfaceForWallet(walletAddress);
  const safeExit = surface.safeExit || evaluateSafeExit(surface);
  if (safeExit.execute !== true) {
    return {
      ok: false,
      code: safeExit.reason || 'lending_safe_exit_not_available',
      verdict: safeExit,
      surface,
    };
  }

  const executionFailure = _getExecutionReadinessFailure(surface);
  if (executionFailure) {
    return {
      ok: false,
      code: executionFailure.reason,
      verdict: executionFailure,
      surface,
    };
  }

  for (const step of safeExit.steps) {
    const verdict = evaluateManualLendingAction({
      surface,
      action: step.action,
      asset: step.asset,
      amount: step.amount,
    });

    if (verdict.execute !== true) {
      return {
        ok: false,
        code: verdict.reason || 'lending_safe_exit_step_blocked',
        verdict,
        surface,
      };
    }
  }

  return {
    ok: true,
    verdict: safeExit,
    surface,
  };
}

async function guardAgentLiquidationAction({ agent, borrower, debtAsset, collateralAsset, amount }) {
  const walletAddress = agent?.wallet_address || agent?.walletAddress || null;
  if (!walletAddress) {
    return {
      ok: false,
      code: 'wallet_not_configured',
      verdict: {
        execute: false,
        reason: 'wallet_not_configured',
        detail: 'This agent does not have a wallet address configured.',
      },
      liquidatorSurface: null,
      borrowerSurface: null,
    };
  }

  const [liquidatorSurface, borrowerSurface] = await Promise.all([
    buildLendingSurfaceForWallet(walletAddress),
    buildLendingSurfaceForWallet(borrower),
  ]);

  const verdict = evaluateLiquidationOpportunity({
    liquidatorSurface,
    borrowerSurface,
    debtAsset,
    collateralAsset,
    amount,
  });

  if (verdict.execute !== true) {
    return {
      ok: false,
      code: verdict.reason || 'lending_liquidation_not_available',
      verdict,
      liquidatorSurface,
      borrowerSurface,
    };
  }

  return {
    ok: true,
    verdict,
    liquidatorSurface,
    borrowerSurface,
  };
}

async function getAgentLendingSurface(agentId, userId) {
  const agent = await agentService.getAgent(agentId, userId);
  if (!agent) return null;

  const surface = await buildLendingSurfaceForWallet(agent.walletAddress);
  let carry = null;

  try {
    const stablePool = oracle.resolveCurvePool('USDC-EURC');
    const stablePricingPool = oracle.resolveCurvePool('EURC-USDC');
    const [forexRate, positionSnapshot] = await Promise.all([
      oracle.getForexRate('EURC', 'USDC'),
      positionsService.getWalletPositions(agent.walletAddress, {
        poolKeys: [stablePool?.key].filter(Boolean),
      }),
    ]);
    const stablePosition = Array.isArray(positionSnapshot?.positions)
      ? positionSnapshot.positions.find(
          (item) => String(item.poolAddress || '').toLowerCase() === String(stablePool?.address || '').toLowerCase(),
        ) || null
      : null;
    const stablePoolState = stablePricingPool?.address
      ? await oracle.getCurvePoolState(stablePricingPool)
      : oracle.getMockPoolState('EURC-USDC', forexRate.rate);
    const assetMap = new Map((surface.assets || []).map((assetEntry) => [String(assetEntry.symbol || '').toUpperCase(), assetEntry]));

    carry = buildCarryOpportunitySnapshot({
      lendingSurface: surface,
      stablePoolState,
      stableCurvePosition: stablePosition,
      walletBalances: {
        usdc: assetMap.get('USDC')?.wallet?.amount ?? 0,
        eurc: assetMap.get('EURC')?.wallet?.amount ?? 0,
      },
      maxTradeUsdc: agent.settings?.maxTradeUsdc || 0,
      walletReserveUsdc: agent.settings?.defiWalletReserveUsdc || 0,
    });
  } catch (error) {
    carry = {
      lane: 'carry_stable_lp',
      policyId: 'carry_stable_lp_v1',
      carryState: 'unavailable',
      exclusiveMode: true,
      error: error.message,
    };
  }

  return {
    agentId: agent.id,
    ...surface,
    carry,
    automation: {
      carryEnabled: agent.features?.carryAutomationEnabled === true,
    },
  };
}

module.exports = {
  buildLendingSurfaceForWallet,
  evaluateCollateralTopUp,
  evaluateEmergencyDeleverage,
  evaluateLiquidationOpportunity,
  evaluateManualLendingAction,
  evaluateSafeExit,
  guardAgentCollateralTopUp,
  guardAgentEmergencyDeleverage,
  guardAgentLiquidationAction,
  guardAgentManualLendingAction,
  guardAgentSafeExit,
  getAgentLendingSurface,
};