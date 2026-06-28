'use strict';

const { ethers } = require('ethers');

const db = require('../db');
const oracle = require('./oracle');
const positionsService = require('./positionsService');
const { safeArcRpcCall } = require('./arcProvider');

const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];
const TRACKED_TOKENS = Object.freeze([
  {
    symbol: 'USDC',
    address: process.env.USDC_ADDRESS_ARC || process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
    decimals: 6,
    priceSymbol: 'USDC',
    fallbackUsd: 1,
  },
  {
    symbol: 'EURC',
    address: process.env.EURC_ADDRESS_ARC || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6,
    priceSymbol: 'EURC',
    fallbackUsd: 1.08,
  },
  {
    symbol: 'cirBTC',
    address: process.env.CIRBTC_ADDRESS_ARC || '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
    decimals: 8,
    priceSymbol: 'BTC',
    fallbackUsd: null,
  },
]);

function roundTo(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const scale = 10 ** digits;
  return Math.round(numeric * scale) / scale;
}

function normalizeWalletAddress(walletAddress) {
  const normalized = String(walletAddress || '').trim();
  if (!normalized) {
    throw new Error('wallet_address_required');
  }

  try {
    return ethers.getAddress(normalized);
  } catch {
    throw new Error('wallet_address_invalid');
  }
}

function formatNumber(value, maximumFractionDigits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

function toInteger(value) {
  return parseInt(value || '0', 10) || 0;
}

function toAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? roundTo(numeric, 4) || 0 : 0;
}

function getYesterdayUtcWindow() {
  const now = new Date();
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  const start = new Date(end.getTime() - (24 * 60 * 60 * 1000));

  return {
    label: 'yesterday_utc',
    timezone: 'UTC',
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  };
}

function getActivityLabel(type) {
  const normalized = String(type || '').trim().toLowerCase();
  const labelMap = {
    swap: 'Swap',
    bridge: 'Bridge',
    rebalance: 'Rebalance',
    oracle_signal: 'Oracle Signal',
    defi_loop_dry: 'Automation Dry Run',
    curve_lp_add: 'Curve LP Add',
    curve_lp_remove: 'Curve LP Remove',
    direct_lp_add: 'Direct LP Add',
    direct_lp_remove: 'Direct LP Remove',
    task_arb: 'Arb Execution',
    lending_supply: 'Lending Supply',
    lending_withdraw: 'Lending Withdraw',
    lending_borrow: 'Lending Borrow',
    lending_repay: 'Lending Repay',
    lending_collateral_topup: 'Collateral Top-Up',
    lending_safe_exit: 'Lending Safe Exit',
    lending_deleverage: 'Lending Deleverage',
    lending_liquidation: 'Lending Liquidation',
    gas_topup: 'Gas Top-Up',
    receive: 'Receive',
  };

  return labelMap[normalized] || normalized || 'Activity';
}

function buildDailySummaryText(dailySummary) {
  if (dailySummary.status !== 'available') {
    return 'Yesterday summary is only available for indexed Arc agent wallets right now.';
  }

  const { counts, volumes } = dailySummary;
  const parts = [];

  if (counts.lpAdds > 0) {
    parts.push(`${counts.lpAdds} LP add${counts.lpAdds === 1 ? '' : 's'}`);
  }

  if (counts.lpRemoves > 0) {
    parts.push(`${counts.lpRemoves} LP remove${counts.lpRemoves === 1 ? '' : 's'}`);
  }

  if (counts.swaps > 0) {
    parts.push(`${counts.swaps} swap${counts.swaps === 1 ? '' : 's'} (${formatNumber(volumes.swapsUsd)} USD)`);
  }

  if (counts.rebalances > 0) {
    parts.push(`${counts.rebalances} rebalance${counts.rebalances === 1 ? '' : 's'}`);
  }

  if (counts.bridges > 0) {
    parts.push(`${counts.bridges} bridge${counts.bridges === 1 ? '' : 's'}`);
  }

  if (counts.lendingBorrows > 0) {
    parts.push(`${counts.lendingBorrows} borrow${counts.lendingBorrows === 1 ? '' : 's'} (${formatNumber(volumes.lendingBorrowUsd)} USD)`);
  }

  if (counts.lendingRepays > 0) {
    parts.push(`${counts.lendingRepays} repay${counts.lendingRepays === 1 ? '' : 's'}`);
  }

  if (counts.arbExecutions > 0) {
    parts.push(`${counts.arbExecutions} arb execution${counts.arbExecutions === 1 ? '' : 's'}`);
  }

  if (counts.arbSignalsFound > 0) {
    parts.push(`${counts.arbSignalsFound} arb signal${counts.arbSignalsFound === 1 ? '' : 's'} found${volumes.arbSignalExpectedProfitUsd > 0 ? ` (~${formatNumber(volumes.arbSignalExpectedProfitUsd)} USD modeled edge)` : ''}`);
  }

  if (!parts.length) {
    return 'No tracked wallet activity was recorded in yesterday\'s UTC window.';
  }

  const failureNote = counts.failedActivities > 0
    ? ` ${counts.failedActivities} failed attempt${counts.failedActivities === 1 ? '' : 's'} were also recorded.`
    : '';

  return `Yesterday (UTC) this wallet recorded ${parts.join(', ')}.${failureNote}`;
}

async function getWalletDailySummary(walletAddress) {
  const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
  const window = getYesterdayUtcWindow();

  const { rows: [agent] } = await db.query(
    `SELECT id
       FROM agents
      WHERE LOWER(wallet_address) = LOWER($1)
      ORDER BY created_at ASC
      LIMIT 1`,
    [normalizedWalletAddress],
  );

  if (!agent?.id) {
    return {
      status: 'unavailable',
      reason: 'wallet_not_indexed_as_agent',
      window,
      summary: 'Yesterday summary is only available for indexed Arc agent wallets right now.',
      counts: {
        totalActivities: 0,
        confirmedActivities: 0,
        failedActivities: 0,
        dryRunActivities: 0,
        skippedActivities: 0,
        swaps: 0,
        bridges: 0,
        rebalances: 0,
        lpAdds: 0,
        lpRemoves: 0,
        curveLpAdds: 0,
        curveLpRemoves: 0,
        directLpAdds: 0,
        directLpRemoves: 0,
        arbExecutions: 0,
        oracleSignals: 0,
        arbSignalsFound: 0,
        lendingSupplies: 0,
        lendingWithdraws: 0,
        lendingBorrows: 0,
        lendingRepays: 0,
        lendingCollateralTopUps: 0,
        lendingSafeExits: 0,
        lendingDeleverages: 0,
        lendingLiquidations: 0,
        taskResults: 0,
      },
      volumes: {
        totalConfirmedUsd: 0,
        swapsUsd: 0,
        bridgesUsd: 0,
        rebalancesUsd: 0,
        lpAddsUsd: 0,
        lpRemovesUsd: 0,
        arbExecutionUsd: 0,
        arbSignalExpectedProfitUsd: 0,
        lendingSupplyUsd: 0,
        lendingWithdrawUsd: 0,
        lendingBorrowUsd: 0,
        lendingRepayUsd: 0,
      },
      recent: [],
    };
  }

  const [txSummaryResult, taskSummaryResult, recentResult] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) AS total_count,
         COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
         COUNT(*) FILTER (WHERE status = 'dry_run') AS dry_run_count,
         COUNT(*) FILTER (WHERE status = 'skipped') AS skipped_count,
         COUNT(*) FILTER (WHERE type = 'swap') AS swap_count,
         COUNT(*) FILTER (WHERE type = 'bridge') AS bridge_count,
         COUNT(*) FILTER (WHERE type = 'rebalance') AS rebalance_count,
         COUNT(*) FILTER (WHERE type = 'curve_lp_add') AS curve_lp_add_count,
         COUNT(*) FILTER (WHERE type = 'curve_lp_remove') AS curve_lp_remove_count,
         COUNT(*) FILTER (WHERE type = 'direct_lp_add') AS direct_lp_add_count,
         COUNT(*) FILTER (WHERE type = 'direct_lp_remove') AS direct_lp_remove_count,
         COUNT(*) FILTER (WHERE type = 'task_arb') AS arb_execution_count,
         COUNT(*) FILTER (WHERE type = 'oracle_signal') AS oracle_signal_count,
         COUNT(*) FILTER (WHERE type = 'lending_supply') AS lending_supply_count,
         COUNT(*) FILTER (WHERE type = 'lending_withdraw') AS lending_withdraw_count,
         COUNT(*) FILTER (WHERE type = 'lending_borrow') AS lending_borrow_count,
         COUNT(*) FILTER (WHERE type = 'lending_repay') AS lending_repay_count,
         COUNT(*) FILTER (WHERE type = 'lending_collateral_topup') AS lending_collateral_topup_count,
         COUNT(*) FILTER (WHERE type = 'lending_safe_exit') AS lending_safe_exit_count,
         COUNT(*) FILTER (WHERE type = 'lending_deleverage') AS lending_deleverage_count,
         COUNT(*) FILTER (WHERE type = 'lending_liquidation') AS lending_liquidation_count,
         COALESCE(SUM(amount_usdc) FILTER (WHERE status = 'confirmed'), 0)::float AS total_confirmed_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'swap' AND status = 'confirmed'), 0)::float AS swap_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'bridge' AND status = 'confirmed'), 0)::float AS bridge_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'rebalance' AND status = 'confirmed'), 0)::float AS rebalance_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type IN ('curve_lp_add', 'direct_lp_add') AND status = 'confirmed'), 0)::float AS lp_add_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type IN ('curve_lp_remove', 'direct_lp_remove') AND status = 'confirmed'), 0)::float AS lp_remove_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'task_arb' AND status = 'confirmed'), 0)::float AS arb_execution_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'oracle_signal'), 0)::float AS oracle_signal_profit_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'lending_supply' AND status = 'confirmed'), 0)::float AS lending_supply_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'lending_withdraw' AND status = 'confirmed'), 0)::float AS lending_withdraw_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'lending_borrow' AND status = 'confirmed'), 0)::float AS lending_borrow_usd,
         COALESCE(SUM(amount_usdc) FILTER (WHERE type = 'lending_repay' AND status = 'confirmed'), 0)::float AS lending_repay_usd
       FROM transactions
      WHERE agent_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz`,
      [agent.id, window.startAt, window.endAt],
    ),
    db.query(
      `SELECT
         COUNT(*) AS task_result_count,
         COUNT(*) FILTER (WHERE task_id = 'DAILY_ARB_SCAN' AND payload->'signal' IS NOT NULL) AS arb_signal_count
       FROM agent_task_results
      WHERE agent_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz`,
      [agent.id, window.startAt, window.endAt],
    ),
    db.query(
      `SELECT type, status, token, amount_usdc, tx_hash, created_at
       FROM transactions
      WHERE agent_id = $1
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
      ORDER BY created_at DESC
      LIMIT 5`,
      [agent.id, window.startAt, window.endAt],
    ),
  ]);

  const txSummary = txSummaryResult.rows[0] || {};
  const taskSummary = taskSummaryResult.rows[0] || {};

  const counts = {
    totalActivities: toInteger(txSummary.total_count),
    confirmedActivities: toInteger(txSummary.confirmed_count),
    failedActivities: toInteger(txSummary.failed_count),
    dryRunActivities: toInteger(txSummary.dry_run_count),
    skippedActivities: toInteger(txSummary.skipped_count),
    swaps: toInteger(txSummary.swap_count),
    bridges: toInteger(txSummary.bridge_count),
    rebalances: toInteger(txSummary.rebalance_count),
    curveLpAdds: toInteger(txSummary.curve_lp_add_count),
    curveLpRemoves: toInteger(txSummary.curve_lp_remove_count),
    directLpAdds: toInteger(txSummary.direct_lp_add_count),
    directLpRemoves: toInteger(txSummary.direct_lp_remove_count),
    lpAdds: toInteger(txSummary.curve_lp_add_count) + toInteger(txSummary.direct_lp_add_count),
    lpRemoves: toInteger(txSummary.curve_lp_remove_count) + toInteger(txSummary.direct_lp_remove_count),
    arbExecutions: toInteger(txSummary.arb_execution_count),
    oracleSignals: toInteger(txSummary.oracle_signal_count),
    arbSignalsFound: toInteger(taskSummary.arb_signal_count) + toInteger(txSummary.oracle_signal_count),
    lendingSupplies: toInteger(txSummary.lending_supply_count),
    lendingWithdraws: toInteger(txSummary.lending_withdraw_count),
    lendingBorrows: toInteger(txSummary.lending_borrow_count),
    lendingRepays: toInteger(txSummary.lending_repay_count),
    lendingCollateralTopUps: toInteger(txSummary.lending_collateral_topup_count),
    lendingSafeExits: toInteger(txSummary.lending_safe_exit_count),
    lendingDeleverages: toInteger(txSummary.lending_deleverage_count),
    lendingLiquidations: toInteger(txSummary.lending_liquidation_count),
    taskResults: toInteger(taskSummary.task_result_count),
  };

  const volumes = {
    totalConfirmedUsd: toAmount(txSummary.total_confirmed_usd),
    swapsUsd: toAmount(txSummary.swap_usd),
    bridgesUsd: toAmount(txSummary.bridge_usd),
    rebalancesUsd: toAmount(txSummary.rebalance_usd),
    lpAddsUsd: toAmount(txSummary.lp_add_usd),
    lpRemovesUsd: toAmount(txSummary.lp_remove_usd),
    arbExecutionUsd: toAmount(txSummary.arb_execution_usd),
    arbSignalExpectedProfitUsd: toAmount(txSummary.oracle_signal_profit_usd),
    lendingSupplyUsd: toAmount(txSummary.lending_supply_usd),
    lendingWithdrawUsd: toAmount(txSummary.lending_withdraw_usd),
    lendingBorrowUsd: toAmount(txSummary.lending_borrow_usd),
    lendingRepayUsd: toAmount(txSummary.lending_repay_usd),
  };

  const dailySummary = {
    status: 'available',
    agentId: agent.id,
    window,
    counts,
    volumes,
    recent: recentResult.rows.map((row) => ({
      type: row.type,
      label: getActivityLabel(row.type),
      status: row.status,
      token: row.token,
      amountUsd: toAmount(row.amount_usdc),
      txHash: row.tx_hash || null,
      createdAt: row.created_at,
    })),
  };

  return {
    ...dailySummary,
    summary: buildDailySummaryText(dailySummary),
  };
}

function getPriceEntry(priceLookup, token) {
  return priceLookup?.[token.priceSymbol] || null;
}

function getUsdPrice(priceLookup, token) {
  const priceEntry = getPriceEntry(priceLookup, token);
  const usdPrice = Number(priceEntry?.usdPrice);

  if (Number.isFinite(usdPrice) && usdPrice > 0) {
    return {
      usdPrice,
      isFallback: Boolean(priceEntry?.isFallback),
      fallbackReason: priceEntry?.fallbackReason || null,
      source: priceEntry?.source || 'market_lookup',
    };
  }

  return {
    usdPrice: Number.isFinite(token.fallbackUsd) ? token.fallbackUsd : null,
    isFallback: true,
    fallbackReason: Number.isFinite(token.fallbackUsd)
      ? 'price_lookup_missing'
      : 'price_lookup_unavailable',
    source: Number.isFinite(token.fallbackUsd) ? 'fallback_price' : 'unpriced',
  };
}

async function readTrackedTokenBalance(walletAddress, token, priceLookup) {
  try {
    const rawBalance = await safeArcRpcCall(`wallet_snapshot_balance_${token.symbol}`, async (provider) => {
      const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, provider);
      return contract.balanceOf(walletAddress);
    }, null);

    if (rawBalance == null) {
      throw new Error('arc_rpc_unavailable');
    }

    const amount = Number(ethers.formatUnits(rawBalance, token.decimals));
    const priceMeta = getUsdPrice(priceLookup, token);
    const usdValue = Number.isFinite(amount) && Number.isFinite(priceMeta.usdPrice)
      ? amount * priceMeta.usdPrice
      : null;

    return {
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
      amount: roundTo(amount, token.symbol === 'cirBTC' ? 8 : 6),
      usdPrice: roundTo(priceMeta.usdPrice, 6),
      usdValue: roundTo(usdValue, 4),
      isFallback: Boolean(priceMeta.isFallback),
      fallbackReason: priceMeta.fallbackReason,
      source: priceMeta.source,
      readError: null,
    };
  } catch (error) {
    return {
      symbol: token.symbol,
      address: token.address,
      decimals: token.decimals,
      amount: null,
      usdPrice: null,
      usdValue: null,
      isFallback: true,
      fallbackReason: 'balance_read_failed',
      source: 'onchain_read_failed',
      readError: error?.message || 'balance_read_failed',
    };
  }
}

function summarizePositions(snapshot) {
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const summaries = positions.map((position) => ({
    poolKey: position.poolKey,
    protocol: position.protocol,
    poolAddress: position.poolAddress,
    liquidityState: position.liquidityState || position.analytics?.liquidityState || null,
    lpToken: position.lpToken?.symbol || null,
    sharePct: roundTo(position.sharePct, 2),
    totalUsd: roundTo(position.valuation?.totalUsd, 4),
    underlying: (position.underlying || []).map((asset) => ({
      symbol: asset.symbol,
      amount: roundTo(asset.amount, asset.symbol === 'cirBTC' ? 8 : 6),
      usdValue: roundTo(asset.usdValue, 4),
      exposurePct: roundTo(asset.exposurePct, 2),
    })),
  }));

  const totalPositionUsd = summaries.reduce((sum, position) => (
    sum + (Number.isFinite(position.totalUsd) ? Number(position.totalUsd) : 0)
  ), 0);

  return {
    summaries,
    totalPositionUsd: roundTo(totalPositionUsd, 4) || 0,
  };
}

function getLargestBalance(balances) {
  return balances
    .filter((item) => Number.isFinite(item.usdValue) && item.usdValue > 0)
    .sort((left, right) => right.usdValue - left.usdValue)[0] || null;
}

function pickRecommendedAction({ balances, positions }) {
  const largestBalance = getLargestBalance(balances);
  const usdcUsd = Number(balances.find((item) => item.symbol === 'USDC')?.usdValue || 0);
  const eurcUsd = Number(balances.find((item) => item.symbol === 'EURC')?.usdValue || 0);
  const stableUsd = usdcUsd + eurcUsd;
  const directPairPosition = positions.find((position) => String(position.poolKey || '').includes('CIRBTC')) || null;
  const lpPosition = positions.find((position) => position.protocol === 'curve') || null;

  if (directPairPosition) {
    const exitTaskId = String(directPairPosition.poolKey || '').startsWith('EURC')
      ? 'EXEC_CIRBTC_EURC_LP_REMOVE'
      : 'EXEC_CIRBTC_USDC_LP_REMOVE';
    return {
      recommendedTaskId: exitTaskId,
      summary: 'Wallet already holds a live direct-pair cirBTC LP position, so the next move should start from existing LP exposure instead of a fresh stable rotation.',
      actionHint: 'Review the current direct-pair LP before adding more risk or rotating stablecoins.',
      posture: 'lp_exposure_present',
    };
  }

  if (lpPosition) {
    return {
      recommendedTaskId: 'EXEC_CURVE_LIQUIDITY_REMOVE',
      summary: 'Wallet already holds stable LP exposure. Check the current pool position before paying for another liquidity or rotation step.',
      actionHint: 'Use the snapshot to decide whether the current LP should stay open or be simplified first.',
      posture: 'stable_lp_present',
    };
  }

  if (stableUsd >= 25 && usdcUsd > 5 && eurcUsd > 5) {
    const usdcPct = stableUsd > 0 ? (usdcUsd / stableUsd) * 100 : 0;
    const eurcPct = stableUsd > 0 ? (eurcUsd / stableUsd) * 100 : 0;
    if (Math.abs(usdcPct - eurcPct) <= 15) {
      return {
        recommendedTaskId: 'EXEC_CURVE_LIQUIDITY_ADD',
        summary: 'Wallet already holds a balanced stable mix, so idle capital may be more useful as live liquidity than another rotation.',
        actionHint: 'If the next move is yield on idle stables, add liquidity instead of swapping again.',
        posture: 'balanced_stable_idle',
      };
    }

    return {
      recommendedTaskId: 'EXEC_REBALANCE',
      summary: `Wallet is concentrated in ${usdcPct >= eurcPct ? 'USDC' : 'EURC'}, so a rebalance is cleaner than a blind one-leg rotation.`,
      actionHint: 'Use this snapshot before paying for a rebalance that brings the wallet back toward a healthier stable mix.',
      posture: 'stable_concentration',
    };
  }

  if (stableUsd >= 10 && largestBalance && (usdcUsd === 0 || eurcUsd === 0)) {
    return {
      recommendedTaskId: 'EXEC_CURVE_SWAP',
      summary: `Wallet mostly holds ${largestBalance.symbol}, so the cleanest next move may be a one-leg stable rotation rather than a broader portfolio change.`,
      actionHint: 'Use the snapshot first, then decide whether a direct stable swap is enough.',
      posture: 'single_asset_stable',
    };
  }

  return {
    recommendedTaskId: null,
    summary: 'Wallet snapshot is ready. Use it to confirm balances and live positions before paying for the next Arc action.',
    actionHint: 'This is a decision aid, not an auto-execution step.',
    posture: 'informational',
  };
}

async function getWalletAssetSnapshot({ walletAddress }) {
  const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
  const [priceLookup, positionSnapshot, dailySummary] = await Promise.all([
    oracle.getMultipleTokenPrices(['USDC', 'EURC', 'BTC']).catch(() => ({})),
    positionsService.getWalletPositions(normalizedWalletAddress),
    getWalletDailySummary(normalizedWalletAddress),
  ]);

  const balances = await Promise.all(TRACKED_TOKENS.map((token) => readTrackedTokenBalance(normalizedWalletAddress, token, priceLookup)));
  const liquidUsd = balances.reduce((sum, balance) => (
    sum + (Number.isFinite(balance.usdValue) ? Number(balance.usdValue) : 0)
  ), 0);
  const { summaries: positions, totalPositionUsd } = summarizePositions(positionSnapshot);
  const totalWalletUsd = liquidUsd + totalPositionUsd;
  const recommendation = pickRecommendedAction({ balances, positions });

  const balancesWithExposure = balances.map((balance) => ({
    ...balance,
    exposurePct: totalWalletUsd > 0 && Number.isFinite(balance.usdValue)
      ? roundTo((Number(balance.usdValue) / totalWalletUsd) * 100, 2)
      : null,
  }));

  return {
    walletAddress: normalizedWalletAddress,
    chain: 'Arc Testnet',
    status: 'live',
    summary: recommendation.summary,
    actionHint: recommendation.actionHint,
    recommendedTaskId: recommendation.recommendedTaskId,
    posture: recommendation.posture,
    metrics: {
      liquidUsd: roundTo(liquidUsd, 4) || 0,
      positionUsd: roundTo(totalPositionUsd, 4) || 0,
      totalWalletUsd: roundTo(totalWalletUsd, 4) || 0,
      positionCount: positions.length,
      warningCount: Array.isArray(positionSnapshot.warnings) ? positionSnapshot.warnings.length : 0,
    },
    balances: balancesWithExposure,
    positions,
    dailySummary,
    warnings: positionSnapshot.warnings || [],
    isFallback: balancesWithExposure.some((balance) => balance.isFallback) || (positionSnapshot.warnings || []).length > 0,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  getWalletAssetSnapshot,
  normalizeWalletAddress,
};