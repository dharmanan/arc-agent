'use strict';
/**
 * GET  /api/tasks/featured          — today's 5 rotating featured tasks (no auth required)
 * GET  /api/tasks/catalog           — full task catalog with tier + fee info
 * GET  /api/tasks/pool-balance      — ArcRevenuePool on-chain balance
 * POST /api/agents/:id/tasks/run    — queue a free (Tier-1) or paid (Tier-2) task
 * GET  /api/agents/:id/tasks/results — last N task results for an agent
 */
const router          = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db              = require('../db');
const queue           = require('../queue/agentQueue');
const { ethers }      = require('ethers');
const oracle          = require('../services/oracle');
const protocols       = require('../services/protocols');
const { isDailyLimitBypassed } = require('../services/dailyLimitBypass');
const taskRunService = require('../services/taskRunService');
const nativeLendingRiskService = require('../services/nativeLendingRiskService');
const { getAgentWithKey } = require('../services/agentService');
const { assertAgentOperational } = require('../services/securityEventService');
const {
  buildCirclePaidHandoff,
  getCirclePaidCatalog,
  getCirclePaidItemById,
} = require('../services/circlePaidCatalogService');
const {
  getEventOddsCompare,
  getPredictionMarketPulse,
} = require('../services/predictionMarketService');
const {
  buildCirclePaidPricingSnapshot,
  buildPredictionMarketPreviewPayload,
  createCirclePaidPreviewSnapshot,
  getCirclePaidSnapshotForAgent,
  listCirclePaidSnapshots,
  unlockCirclePaidSnapshot,
} = require('../services/circlePaidSnapshotService');
const { getWalletAssetSnapshot } = require('../services/walletSnapshotService');

// ── Minimal ABI for ArcRevenuePool.getPoolBalance() ──────────────────────────
const _POOL_VIEW_ABI = ['function getPoolBalance() external view returns (uint256)'];
const DEFAULT_REVENUE_POOL_ADDRESS = '0x7E84fFFAA5f0524CD55b13B6AEC7eE0785c07e5e';

function _getPoolContract() {
  const addr = process.env.REVENUE_POOL_ADDRESS || DEFAULT_REVENUE_POOL_ADDRESS;
  const rpc  = process.env.ARC_TESTNET_RPC || 'https://rpc.arc-testnet.io';
  if (!addr) return null;
  const provider = new ethers.JsonRpcProvider(rpc);
  return new ethers.Contract(addr, _POOL_VIEW_ABI, provider);
}

const DAILY_PAID_TASK_CAP = parseInt(process.env.DAILY_PAID_TASK_CAP || '10', 10);
const DAILY_FREE_TASK_CAP = parseInt(process.env.DAILY_FREE_TASK_CAP || '5', 10);
const EXECUTION_TASK_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_CIRBTC_USDC_ZAP_IN',
  'EXEC_CIRBTC_EURC_ZAP_IN',
  'EXEC_CIRBTC_USDC_LP_REMOVE',
  'EXEC_CIRBTC_EURC_LP_REMOVE',
  'EXEC_LENDING_SUPPLY',
  'EXEC_LENDING_WITHDRAW',
  'EXEC_LENDING_BORROW',
  'EXEC_LENDING_REPAY',
  'EXEC_LENDING_COLLATERAL_TOP_UP',
  'EXEC_LENDING_SAFE_EXIT',
  'EXEC_LENDING_LIQUIDATE',
  'EXEC_CCTP_BRIDGE',
  'EXEC_SEPOLIA_GAS_FANOUT',
  'EXEC_ARB',
  'EXEC_REBALANCE',
]);
const AUTO_CARRY_TASK_IDS = new Set(['EXEC_AUTO_CARRY_START', 'EXEC_AUTO_CARRY_STOP']);

async function acquireAutoCarryTaskRunLock(agentId) {
  const client = await db.getClient();
  let released = false;

  const release = async (mode = 'rollback') => {
    if (released) return;
    released = true;

    try {
      if (mode === 'commit') await client.query('COMMIT');
      else await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  };

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      ['auto_carry_task_run', String(agentId || '')],
    );
    return { client, release };
  } catch (error) {
    await release('rollback').catch(() => {});
    throw error;
  }
}
const CURVE_POOL_TOKENS = new Set(['USDC', 'EURC']);
const DIRECT_PAIR_ZAP_LIMITS = {
  EXEC_CIRBTC_USDC_ZAP_IN: 20,
  EXEC_CIRBTC_EURC_ZAP_IN: 16,
};
const MANUAL_DEFI_CURVE_POOLS = new Set(['USDC-EURC', 'EURC-USDC']);
const MANUAL_DEFI_DIRECT_PAIR_STABLE_BY_POOL = {
  'USDC-CIRBTC': 'USDC',
  'CIRBTC-USDC': 'USDC',
  'EURC-CIRBTC': 'EURC',
  'CIRBTC-EURC': 'EURC',
};
const MANUAL_LENDING_ACTION_TASK_IDS = {
  supply: 'EXEC_MANUAL_LENDING_SUPPLY',
  withdraw: 'EXEC_MANUAL_LENDING_WITHDRAW',
  borrow: 'EXEC_MANUAL_LENDING_BORROW',
  repay: 'EXEC_MANUAL_LENDING_REPAY',
  collateral_top_up: 'EXEC_MANUAL_LENDING_COLLATERAL_TOP_UP',
  safe_exit: 'EXEC_MANUAL_LENDING_SAFE_EXIT',
  deleverage: 'EXEC_MANUAL_LENDING_DELEVERAGE',
  liquidate: 'EXEC_MANUAL_LENDING_LIQUIDATE',
};
const MANUAL_LENDING_ASSETS = new Set(['USDC', 'EURC']);
const CCTP_CHAIN_NAMES = new Set([
  'Arc Testnet',
  'Sepolia',
  'Base Sepolia',
  'Optimism Sepolia',
  'Arbitrum Sepolia',
]);
const REBALANCE_TOKENS = new Set(['USDC', 'EURC']);
const WALLET_ASSET_SNAPSHOT_ITEM_ID = 'ARC_WALLET_ASSET_SNAPSHOT';
const PREDICTION_MARKET_CHECK_ITEM_ID = 'ARC_PREDICTION_MARKET_CHECK';
const EVENT_ODDS_COMPARE_ITEM_ID = 'ARC_EVENT_ODDS_COMPARE';

function _isPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function _sendPermissionBlocked(res, permissionGuard) {
  return res.status(403).json({
    error: permissionGuard?.error || permissionGuard?.reason || 'permission_blocked',
    permission: permissionGuard?.permission || null,
    detail: permissionGuard?.stageDetail || permissionGuard?.errorSummary || 'Task is blocked by the current strategy preference.',
  });
}

function _isBinaryIndex(value) {
  return Number(value) === 0 || Number(value) === 1;
}

function _normalizeManualDefiParams(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function _resolveCurveSwapRoute(params) {
  const fromToken = String(params.fromToken || '').toUpperCase();
  const toToken = String(params.toToken || '').toUpperCase();

  if (fromToken === 'USDC' && toToken === 'EURC') {
    return { indexIn: 0, indexOut: 1, fromToken, toToken };
  }

  if (fromToken === 'EURC' && toToken === 'USDC') {
    return { indexIn: 1, indexOut: 0, fromToken, toToken };
  }

  return null;
}

function _resolveManualLendingExecution(body, params) {
  const action = String(body?.action || '').trim().toLowerCase();
  const asset = String(body?.asset || params?.asset || params?.symbol || '').trim().toUpperCase();
  const amount = params?.amount ?? body?.amount;

  if (!action) return { error: 'manual_lending_action_required' };
  if (!MANUAL_LENDING_ACTION_TASK_IDS[action]) return { error: 'manual_lending_action_invalid' };

  if (action === 'collateral_top_up' || action === 'safe_exit' || action === 'deleverage') {
    return {
      lane: 'lending',
      taskId: MANUAL_LENDING_ACTION_TASK_IDS[action],
      action,
      params: {
        action,
      },
    };
  }

  if (action === 'liquidate') {
    const borrower = String(params?.borrower || params?.borrowerAddress || body?.borrower || '').trim();
    const debtAsset = String(params?.debtAsset || asset || '').trim().toUpperCase();
    const collateralAsset = String(params?.collateralAsset || body?.collateralAsset || '').trim().toUpperCase();

    if (!borrower) return { error: 'lending_liquidation_borrower_required' };
    if (!MANUAL_LENDING_ASSETS.has(debtAsset)) return { error: 'manual_lending_asset_invalid' };
    if (!MANUAL_LENDING_ASSETS.has(collateralAsset)) return { error: 'lending_liquidation_collateral_asset_invalid' };
    if (!_isPositiveNumber(amount)) return { error: 'lending_liquidation_amount_required' };

    return {
      lane: 'lending',
      taskId: MANUAL_LENDING_ACTION_TASK_IDS[action],
      action,
      asset: debtAsset,
      params: {
        action,
        borrower,
        debtAsset,
        collateralAsset,
        amount: Number(amount),
      },
    };
  }

  if (!MANUAL_LENDING_ASSETS.has(asset)) return { error: 'manual_lending_asset_invalid' };
  if (!_isPositiveNumber(amount)) return { error: 'lending_amount_required' };

  return {
    lane: 'lending',
    taskId: MANUAL_LENDING_ACTION_TASK_IDS[action],
    action,
    asset,
    params: {
      action,
      asset,
      amount: Number(amount),
    },
  };
}

function _resolveManualDefiExecution(body) {
  const lane = String(body?.lane || body?.surface || body?.section || '').trim().toLowerCase();
  const poolKey = String(body?.poolKey || body?.pool || '').trim().toUpperCase();
  const venue = String(body?.venue || '').trim().toLowerCase();
  const action = String(body?.action || '').trim().toLowerCase();
  const params = _normalizeManualDefiParams(body?.params);

  if (lane === 'lending') {
    return _resolveManualLendingExecution(body, params);
  }

  if (!poolKey) return { error: 'manual_defi_pool_required' };
  if (!action) return { error: 'manual_defi_action_required' };

  if (MANUAL_DEFI_CURVE_POOLS.has(poolKey)) {
    if (venue && venue !== 'curve') return { error: 'manual_defi_curve_venue_invalid' };

    if (action === 'swap') {
      const route = _resolveCurveSwapRoute(params);
      if (!route) return { error: 'curve_swap_direction_required' };
      if (!_isPositiveNumber(params.amountIn)) return { error: 'curve_swap_amount_required' };

      return {
        taskId: 'EXEC_MANUAL_CURVE_SWAP',
        poolKey,
        action,
        params: {
          amountIn: Number(params.amountIn),
          indexIn: route.indexIn,
          indexOut: route.indexOut,
        },
      };
    }

    if (action === 'add_single') {
      const tokenIn = String(params.tokenIn || '').toUpperCase();
      if (!CURVE_POOL_TOKENS.has(tokenIn)) return { error: 'curve_liquidity_add_token_required' };
      if (!_isPositiveNumber(params.amountIn)) return { error: 'curve_liquidity_add_amount_required' };

      return {
        taskId: 'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_SINGLE',
        poolKey,
        action,
        params: {
          tokenIn,
          amountIn: Number(params.amountIn),
        },
      };
    }

    if (action === 'add_dual') {
      if (!_isPositiveNumber(params.amountUsdc) || !_isPositiveNumber(params.amountEurc)) {
        return { error: 'curve_liquidity_add_dual_amounts_required' };
      }

      return {
        taskId: 'EXEC_MANUAL_CURVE_LIQUIDITY_ADD_DUAL',
        poolKey,
        action,
        params: {
          amountUsdc: Number(params.amountUsdc),
          amountEurc: Number(params.amountEurc),
        },
      };
    }

    if (action === 'remove_single') {
      const tokenOut = String(params.tokenOut || '').toUpperCase();
      if (!CURVE_POOL_TOKENS.has(tokenOut)) return { error: 'curve_liquidity_remove_token_required' };
      if (!_isPositiveNumber(params.lpAmount)) return { error: 'curve_liquidity_remove_amount_required' };

      return {
        taskId: 'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_SINGLE',
        poolKey,
        action,
        params: {
          tokenOut,
          lpAmount: String(params.lpAmount).trim(),
        },
      };
    }

    if (action === 'remove_dual') {
      if (!_isPositiveNumber(params.lpAmount)) return { error: 'curve_liquidity_remove_amount_required' };

      return {
        taskId: 'EXEC_MANUAL_CURVE_LIQUIDITY_REMOVE_DUAL',
        poolKey,
        action,
        params: {
          lpAmount: String(params.lpAmount).trim(),
        },
      };
    }

    return { error: 'manual_defi_curve_action_invalid' };
  }

  const stableToken = MANUAL_DEFI_DIRECT_PAIR_STABLE_BY_POOL[poolKey];
  if (!stableToken) {
    return { error: 'manual_defi_pool_unsupported' };
  }

  if (venue && venue !== 'uniswap_v2_like') {
    return { error: 'manual_defi_direct_pair_venue_invalid' };
  }

  if (action === 'swap') {
    return { error: 'manual_defi_direct_pair_swap_disabled_use_swap_tab' };
  }

  if (action === 'add_single') {
    const inputToken = String(params.inputToken || stableToken).toUpperCase();
    if (!new Set([stableToken, 'CIRBTC']).has(inputToken)) return { error: 'direct_pair_input_token_invalid' };
    if (!_isPositiveNumber(params.amountIn)) return { error: 'pair_zap_amount_required' };

    return {
      taskId: 'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_ADD',
      poolKey,
      action,
      params: {
        stableToken,
        mode: 'single',
        inputToken,
        amountIn: Number(params.amountIn),
      },
    };
  }

  if (action === 'add_dual') {
    if (!_isPositiveNumber(params.amountStable) || !_isPositiveNumber(params.amountCirbtc)) {
      return { error: 'direct_pair_dual_amounts_required' };
    }

    return {
      taskId: 'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_ADD',
      poolKey,
      action,
      params: {
        stableToken,
        mode: 'dual',
        amountStable: Number(params.amountStable),
        amountCirbtc: Number(params.amountCirbtc),
      },
    };
  }

  if (action === 'remove_single') {
    const targetToken = String(params.targetToken || stableToken).toUpperCase();
    if (!new Set([stableToken, 'CIRBTC']).has(targetToken)) return { error: 'direct_pair_input_token_invalid' };
    if (!_isPositiveNumber(params.withdrawPct) || Number(params.withdrawPct) > 100) return { error: 'pair_exit_pct_invalid' };

    return {
      taskId: 'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_SINGLE',
      poolKey,
      action,
      params: {
        stableToken,
        targetToken,
        withdrawPct: Number(params.withdrawPct),
      },
    };
  }

  if (action === 'remove_dual' || action === 'exit') {
    if (!_isPositiveNumber(params.withdrawPct) || Number(params.withdrawPct) > 100) return { error: 'pair_exit_pct_invalid' };

    return {
      taskId: 'EXEC_MANUAL_DIRECT_PAIR_LIQUIDITY_REMOVE_DUAL',
      poolKey,
      action,
      params: {
        stableToken,
        withdrawPct: Number(params.withdrawPct),
      },
    };
  }

  return { error: 'manual_defi_direct_pair_action_invalid' };
}

function _resolveManualDefiQuote(body) {
  const poolKey = String(body?.poolKey || body?.pool || '').trim().toUpperCase();
  const venue = String(body?.venue || '').trim().toLowerCase();
  const action = String(body?.action || '').trim().toLowerCase();
  const params = _normalizeManualDefiParams(body?.params);

  if (!poolKey) return { error: 'manual_defi_pool_required' };
  if (!action) return { error: 'manual_defi_action_required' };

  if (MANUAL_DEFI_CURVE_POOLS.has(poolKey)) {
    if (venue && venue !== 'curve') return { error: 'manual_defi_curve_venue_invalid' };
    if (action !== 'swap') return { error: 'manual_defi_quote_unsupported' };

    const route = _resolveCurveSwapRoute(params);
    if (!route) return { error: 'curve_swap_direction_required' };
    if (!_isPositiveNumber(params.amountIn)) return { error: 'curve_swap_amount_required' };

    return {
      lane: 'curve',
      poolKey,
      action,
      params: {
        amountIn: Number(params.amountIn),
        fromToken: route.fromToken,
        toToken: route.toToken,
        indexIn: route.indexIn,
        indexOut: route.indexOut,
      },
    };
  }

  return { error: 'manual_defi_quote_unsupported' };
}

function _validateExecutionParams(taskId, params) {
  if (!EXECUTION_TASK_IDS.has(taskId)) return null;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params_required';

  switch (taskId) {
    case 'EXEC_CURVE_SWAP':
      if (!_isPositiveNumber(params.amountIn)) return 'curve_swap_amount_required';
      if (!_isBinaryIndex(params.indexIn) || !_isBinaryIndex(params.indexOut)) return 'curve_swap_direction_required';
      if (Number(params.indexIn) === Number(params.indexOut)) return 'curve_swap_direction_required';
      return null;

    case 'EXEC_CURVE_LIQUIDITY_ADD':
      if (!_isPositiveNumber(params.amountIn)) return 'curve_liquidity_add_amount_required';
      if (!CURVE_POOL_TOKENS.has(String(params.tokenIn || ''))) return 'curve_liquidity_add_token_required';
      return null;

    case 'EXEC_CURVE_LIQUIDITY_REMOVE':
      if (!_isPositiveNumber(params.lpAmount)) return 'curve_liquidity_remove_amount_required';
      if (!CURVE_POOL_TOKENS.has(String(params.tokenOut || ''))) return 'curve_liquidity_remove_token_required';
      return null;

    case 'EXEC_CIRBTC_USDC_ZAP_IN':
    case 'EXEC_CIRBTC_EURC_ZAP_IN':
      if (!_isPositiveNumber(params.amountIn)) return 'pair_zap_amount_required';
      if (Number(params.amountIn) > Number(DIRECT_PAIR_ZAP_LIMITS[taskId] || 0)) return 'pair_zap_amount_exceeds_max';
      return null;

    case 'EXEC_CIRBTC_USDC_LP_REMOVE':
    case 'EXEC_CIRBTC_EURC_LP_REMOVE':
      if (!_isPositiveNumber(params.withdrawPct)) return 'pair_exit_pct_invalid';
      if (Number(params.withdrawPct) > 100) return 'pair_exit_pct_invalid';
      return null;

    case 'EXEC_LENDING_SUPPLY':
    case 'EXEC_LENDING_WITHDRAW':
    case 'EXEC_LENDING_BORROW':
    case 'EXEC_LENDING_REPAY':
      if (!MANUAL_LENDING_ASSETS.has(String(params.asset || '').toUpperCase())) return 'manual_lending_asset_invalid';
      if (!_isPositiveNumber(params.amount)) return 'lending_amount_required';
      return null;

    case 'EXEC_LENDING_COLLATERAL_TOP_UP':
    case 'EXEC_LENDING_SAFE_EXIT':
      return null;

    case 'EXEC_LENDING_LIQUIDATE':
      if (!String(params.borrower || params.borrowerAddress || '').trim()) return 'lending_liquidation_borrower_required';
      if (!MANUAL_LENDING_ASSETS.has(String(params.debtAsset || params.asset || '').toUpperCase())) return 'manual_lending_asset_invalid';
      if (!MANUAL_LENDING_ASSETS.has(String(params.collateralAsset || '').toUpperCase())) return 'lending_liquidation_collateral_asset_invalid';
      if (!_isPositiveNumber(params.amount)) return 'lending_liquidation_amount_required';
      return null;

    case 'EXEC_CCTP_BRIDGE':
      if (!CCTP_CHAIN_NAMES.has(String(params.fromChain || ''))) return 'bridge_from_chain_required';
      if (!CCTP_CHAIN_NAMES.has(String(params.toChain || ''))) return 'bridge_to_chain_required';
      if (String(params.fromChain) === String(params.toChain)) return 'bridge_route_invalid';
      if (!_isPositiveNumber(params.amountUsdc)) return 'bridge_amount_required';
      return null;

    case 'EXEC_ARB':
      if (!_isPositiveNumber(params.amountIn)) return 'arb_amount_required';
      return null;

    case 'EXEC_REBALANCE':
      if (!_isPositiveNumber(params.amountIn)) return 'rebalance_amount_required';
      if (!REBALANCE_TOKENS.has(String(params.fromToken || ''))) return 'rebalance_from_token_required';
      if (!REBALANCE_TOKENS.has(String(params.toToken || ''))) return 'rebalance_to_token_required';
      if (String(params.fromToken) === String(params.toToken)) return 'rebalance_route_invalid';
      return null;

    default:
      return null;
  }
}

function _getInlineTaskFailureStatus(reason) {
  switch (reason) {
    case 'agent_not_found':
    case 'task_not_found':
      return 404;
    case 'daily_tasks_disabled':
    case 'oracle_disabled':
      return 403;
    case 'daily_task_cap_reached':
    case 'daily_paid_cap_reached':
    case 'daily_cap_reached':
      return 429;
    case 'oracle_fetch_error':
    case 'swap_error':
    case 'bridge_native_topup_error':
      return 502;
    case 'position_guard_unavailable':
    case 'manual_task_queue_unavailable':
    case 'lending_contract_not_configured':
    case 'lending_contract_scaffold_only':
    case 'lending_globally_paused':
      return 503;
    case 'swap_not_configured':
    case 'direct_pair_not_configured':
      return 503;
    case 'lp_position_not_found':
    case 'insufficient_lp_position':
    case 'lp_position_exit_required':
    case 'direct_pair_lp_not_found':
    case 'direct_pair_seed_required':
    case 'lending_reserve_not_supported':
    case 'lending_reserve_paused':
    case 'lending_reserve_borrow_disabled':
    case 'lending_wallet_balance_empty':
    case 'lending_wallet_balance_too_low':
    case 'lending_supply_position_required':
    case 'lending_borrow_position_required':
    case 'lending_supply_cap_reached':
    case 'lending_borrow_cap_reached':
    case 'lending_borrow_capacity_unavailable':
    case 'lending_borrow_capacity_exceeded':
    case 'lending_withdraw_amount_exceeds_supply':
    case 'lending_repay_amount_exceeds_debt':
    case 'lending_collateral_topup_not_required':
    case 'lending_collateral_topup_wallet_funds_required':
    case 'lending_deleverage_not_required':
    case 'lending_deleverage_wallet_funds_required':
    case 'lending_safe_exit_not_required':
    case 'lending_safe_exit_wallet_funds_required':
    case 'lending_liquidation_self_target_invalid':
    case 'lending_liquidation_target_healthy':
    case 'lending_liquidation_target_debt_missing':
    case 'lending_liquidation_target_collateral_missing':
    case 'lending_liquidation_amount_too_high':
    case 'lending_liquidation_health_unknown':
    case 'task_already_running':
      return 409;
    case 'curve_pool_not_configured':
    case 'pool_address_not_configured':
    case 'bridge_params_required':
    case 'wallet_not_configured':
    case 'no_private_key':
    case 'manual_lending_action_required':
    case 'manual_lending_action_invalid':
    case 'manual_lending_asset_invalid':
    case 'lending_amount_required':
    case 'lending_liquidation_borrower_required':
    case 'lending_liquidation_collateral_asset_invalid':
    case 'lending_liquidation_amount_required':
    default:
      return 400;
  }
}

function _normalizeCirclePaidParams(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function _normalizeCirclePaidPreviewId(value) {
  return String(value || '').trim();
}

async function _getCirclePaidLiveResult(itemId, params = {}, context = {}) {
  switch (itemId) {
    case WALLET_ASSET_SNAPSHOT_ITEM_ID:
      return getWalletAssetSnapshot({
        walletAddress: params.walletAddress || context.agent?.wallet_address || context.agent?.walletAddress,
      });
    case PREDICTION_MARKET_CHECK_ITEM_ID:
      return getPredictionMarketPulse({
        topic: params.topic,
        limit: params.limit,
      });
    case EVENT_ODDS_COMPARE_ITEM_ID:
      return getEventOddsCompare({
        primaryTopic: params.primaryTopic || params.topic,
        secondaryTopic: params.secondaryTopic,
        limit: params.limit,
      });
    default:
      return null;
  }
}

async function _getCirclePaidContext(agentId, userId, itemId) {
  const agent = await getAgentWithKey(agentId, userId);
  if (!agent) return { error: 'agent_not_found', status: 404 };

  const item = getCirclePaidItemById(itemId);
  if (!item) return { error: 'circle_paid_item_not_found', status: 404 };

  const linkedTaskIds = Array.isArray(item.linkedTaskIds) ? item.linkedTaskIds : [];
  const { rows: paidTasks } = linkedTaskIds.length
    ? await db.query(
      `SELECT id, title, description, fee_usdc
         FROM task_catalog
        WHERE id = ANY($1::text[])
          AND enabled = TRUE`,
      [linkedTaskIds],
    )
    : { rows: [] };

  return {
    agent,
    item,
    paidTasks,
    handoff: buildCirclePaidHandoff(item, paidTasks),
  };
}

function _findRecommendedCirclePaidTask(handoff, liveResult) {
  const recommendedTasks = Array.isArray(handoff?.recommendedTasks) ? handoff.recommendedTasks : [];
  return recommendedTasks.find(task => task.taskId === liveResult?.recommendedTaskId) || null;
}

function _buildCirclePaidPreviewResponse({ item, snapshot, liveResult, handoff, legacyAlias = false }) {
  return {
    previewId: snapshot.id,
    itemId: item.id,
    title: item.title,
    status: 'preview_ready',
    providerCallReady: true,
    chargeReady: true,
    preview: snapshot.preview_payload,
    pricing: snapshot.pricing,
    unlock: {
      expiresAt: snapshot.preview_expires_at,
    },
    note: liveResult.isFallback
      ? 'This preview is using a fallback snapshot because the provider did not respond cleanly. Unlock still never auto-runs the next Arc action.'
      : 'This preview is free. Unlock pays for the full result and saved snapshot only; any suggested Arc action still requires a separate explicit run in the Paid lane.',
    nextAction: {
      requiresExplicitConfirmation: true,
      hint: 'Unlock never auto-executes the recommended Arc action. The user must open the Paid lane and run that task separately.',
    },
    handoff: {
      whyItMatters: handoff?.whyItMatters || item.whyItMatters,
      whatYouGet: handoff?.whatYouGet || item.whatYouGet,
    },
    compatibility: legacyAlias
      ? { alias: 'circle-paid/run', mode: 'preview' }
      : null,
  };
}

function _buildCirclePaidUnlockResponse({ item, snapshot, handoff }) {
  const liveResult = snapshot.full_payload || {};
  const recommendedTask = _findRecommendedCirclePaidTask(handoff, liveResult);

  return {
    snapshotId: snapshot.id,
    itemId: item.id,
    title: item.title,
    status: 'unlocked',
    chargeReady: true,
    liveResult,
    economy: snapshot.economy || {},
    recommendedTask,
    note: 'Unlock paid for the information result and saved snapshot only. Any suggested Arc action still requires a separate explicit task run.',
    nextAction: {
      requiresExplicitConfirmation: true,
      taskId: recommendedTask?.taskId || null,
      hint: recommendedTask
        ? `Open the Paid lane and run ${recommendedTask.title} separately if you want to act on this result.`
        : 'Unlock does not auto-run any task. Review the Paid lane separately before executing anything on-chain.',
    },
    savedSnapshot: {
      createdAt: snapshot.created_at,
      unlockedAt: snapshot.unlocked_at,
    },
  };
}

function _serializeCirclePaidSnapshot(snapshot) {
  const item = getCirclePaidItemById(snapshot.item_id);
  const handoff = item ? buildCirclePaidHandoff(item) : null;
  const liveResult = snapshot.full_payload || {};
  const recommendedTask = _findRecommendedCirclePaidTask(handoff, liveResult);

  return {
    snapshotId: snapshot.id,
    itemId: snapshot.item_id,
    title: item?.title || snapshot.item_id,
    status: snapshot.status,
    preview: snapshot.preview_payload,
    pricing: snapshot.pricing,
    createdAt: snapshot.created_at,
    updatedAt: snapshot.updated_at,
    previewExpiresAt: snapshot.preview_expires_at,
    unlockedAt: snapshot.unlocked_at,
    fullResultAvailable: snapshot.status === 'unlocked',
    recommendedTask,
    economy: snapshot.status === 'unlocked' ? snapshot.economy : null,
  };
}

async function _handleCirclePaidPreview(req, res, next, { legacyAlias = false } = {}) {
  try {
    const agentId = req.params.id;
    const itemId = String(req.body?.itemId || '').trim().toUpperCase();
    const params = _normalizeCirclePaidParams(req.body?.params);

    if (!itemId) return res.status(400).json({ error: 'circle_paid_item_required' });

    const context = await _getCirclePaidContext(agentId, req.user.userId, itemId);
    if (context.error) return res.status(context.status).json({ error: context.error });

    const { item, handoff } = context;
    if (item.status !== 'live') {
      return res.json(handoff);
    }

    const liveResult = await _getCirclePaidLiveResult(item.id, params, { agent: context.agent });
    if (!liveResult) {
      return res.json(handoff);
    }

    const snapshot = await createCirclePaidPreviewSnapshot({
      agentId: context.agent.id,
      itemId: item.id,
      params,
      previewPayload: buildPredictionMarketPreviewPayload(liveResult),
      fullPayload: liveResult,
      pricing: buildCirclePaidPricingSnapshot(item),
    });

    return res.json(_buildCirclePaidPreviewResponse({
      item,
      snapshot,
      liveResult,
      handoff,
      legacyAlias,
    }));
  } catch (err) {
    return next(err);
  }
}

// ── GET /api/agents/:id/tasks/runs ───────────────────────────────────────────
// Returns recent task runs or only active ones for UI recovery and progress.
router.get('/agents/:id/tasks/runs', requireAuth, async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const status = String(req.query.status || 'recent').toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    const { rows: [agent] } = await db.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const runs = await taskRunService.listTaskRuns(agentId, { status, limit });
    res.json({ runs });
  } catch (err) { next(err); }
});

// ── GET /api/tasks/featured ───────────────────────────────────────────────────
// Returns today's 5 featured tasks, ordered deterministically by UTC date seed.
// Same 5 tasks for all users on the same UTC day; changes at 00:00 UTC.
router.get('/featured', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, description, tier, fee_usdc
       FROM task_catalog
       WHERE enabled = TRUE
       ORDER BY md5(id || CURRENT_DATE::text)
       LIMIT 5`,
    );
    res.json({ tasks: rows, rotatesAt: _nextMidnightUtc() });
  } catch (err) { next(err); }
});

// ── GET /api/tasks/catalog ────────────────────────────────────────────────────
// Full task catalog: all tiers, fee info. No auth required.
router.get('/catalog', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, description, tier, fee_usdc
       FROM task_catalog
       WHERE enabled = TRUE
       ORDER BY tier ASC, id ASC`,
    );
    res.json({ tasks: rows });
  } catch (err) { next(err); }
});

// ── GET /api/tasks/circle-paid/catalog ───────────────────────────────────────
// Circle Paid catalog with live cards plus preview cards, ordered by Arc Testnet action priority.
router.get('/circle-paid/catalog', async (_req, res, next) => {
  try {
    res.json(getCirclePaidCatalog());
  } catch (err) { next(err); }
});

// ── POST /api/tasks/agents/:id/circle-paid/preview ───────────────────────────
// Free preview for a Circle Paid card. Today only Prediction Market Check creates a live preview snapshot.
router.post('/agents/:id/circle-paid/preview', requireAuth, async (req, res, next) => {
  return _handleCirclePaidPreview(req, res, next);
});

// ── POST /api/tasks/agents/:id/circle-paid/run ───────────────────────────────
// Legacy alias kept during rollout. Behaves like the new preview endpoint.
router.post('/agents/:id/circle-paid/run', requireAuth, async (req, res, next) => {
  return _handleCirclePaidPreview(req, res, next, { legacyAlias: true });
});

// ── POST /api/tasks/agents/:id/circle-paid/unlock ────────────────────────────
// Paid unlock for a previously created preview. Unlock never auto-runs the next Arc action.
router.post('/agents/:id/circle-paid/unlock', requireAuth, async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const previewId = _normalizeCirclePaidPreviewId(req.body?.previewId);

    if (!previewId) return res.status(400).json({ error: 'preview_id_required' });

    const agent = await getAgentWithKey(agentId, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const previewSnapshot = await getCirclePaidSnapshotForAgent(agent.id, previewId);
    if (!previewSnapshot) return res.status(404).json({ error: 'preview_not_found' });

    const item = getCirclePaidItemById(previewSnapshot.item_id);
    if (!item) return res.status(404).json({ error: 'circle_paid_item_not_found' });

    const context = await _getCirclePaidContext(agentId, req.user.userId, item.id);
    if (context.error) return res.status(context.status).json({ error: context.error });

    try {
      const unlockedSnapshot = await unlockCirclePaidSnapshot({
        agent,
        snapshot: previewSnapshot,
      });

      return res.json(_buildCirclePaidUnlockResponse({
        item,
        snapshot: unlockedSnapshot,
        handoff: context.handoff,
      }));
    } catch (error) {
      if (error?.code) {
        return res.status(error.status || 400).json({
          error: error.code,
          details: error.details || {},
        });
      }

      throw error;
    }
  } catch (err) { next(err); }
});

// ── GET /api/tasks/agents/:id/circle-paid/snapshots ──────────────────────────
// Lists saved Circle Paid snapshots. Defaults to unlocked snapshots only.
router.get('/agents/:id/circle-paid/snapshots', requireAuth, async (req, res, next) => {
  try {
    const agent = await getAgentWithKey(req.params.id, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const snapshots = await listCirclePaidSnapshots(agent.id, {
      itemId: req.query.itemId,
      status: req.query.status,
      limit: req.query.limit,
    });

    return res.json({ snapshots: snapshots.map(_serializeCirclePaidSnapshot) });
  } catch (err) { next(err); }
});

// ── GET /api/tasks/agents/:id/circle-paid/snapshots/:snapshotId ──────────────
// Returns one snapshot. Preview snapshots expose preview only; unlocked ones expose the full result.
router.get('/agents/:id/circle-paid/snapshots/:snapshotId', requireAuth, async (req, res, next) => {
  try {
    const agent = await getAgentWithKey(req.params.id, req.user.userId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const snapshot = await getCirclePaidSnapshotForAgent(agent.id, req.params.snapshotId);
    if (!snapshot) return res.status(404).json({ error: 'snapshot_not_found' });

    const item = getCirclePaidItemById(snapshot.item_id);
    const handoff = item ? buildCirclePaidHandoff(item) : null;

    return res.json({
      snapshot: {
        ..._serializeCirclePaidSnapshot(snapshot),
        fullResult: snapshot.status === 'unlocked' ? snapshot.full_payload : null,
        note: snapshot.status === 'unlocked'
          ? 'This saved snapshot exposes the unlocked full result only. Running any suggested Arc action still requires a separate explicit task run.'
          : 'This is still a preview draft. Unlock is required before the full result becomes a saved snapshot.',
        nextAction: {
          requiresExplicitConfirmation: true,
          recommendedTaskId: snapshot.status === 'unlocked'
            ? _findRecommendedCirclePaidTask(handoff, snapshot.full_payload || {})?.taskId || null
            : null,
        },
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/tasks/pool-balance ───────────────────────────────────────────────
// On-chain ArcRevenuePool balance. No auth required (public transparency).
router.get('/pool-balance', async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const pool = _getPoolContract();
    if (!pool) return res.json({ balanceUsdc: null, note: 'REVENUE_POOL_ADDRESS not configured' });
    const raw  = await pool.getPoolBalance();
    const usdc = Number(raw) / 1_000_000;
    const address = process.env.REVENUE_POOL_ADDRESS || DEFAULT_REVENUE_POOL_ADDRESS;
    res.json({
      balanceUsdc: usdc,
      address,
      source: process.env.REVENUE_POOL_ADDRESS ? 'env' : 'verified_default',
    });
  } catch (err) { next(err); }
});

// ── POST /api/agents/:id/tasks/run ────────────────────────────────────────────
// Queues a Tier-1 (free) or Tier-2 (paid) task for the agent.
router.post('/agents/:id/tasks/run', requireAuth, async (req, res, next) => {
  let autoCarryLock = null;

  try {
    const agentId = req.params.id;
    const taskId  = String(req.body?.taskId || '').trim().toUpperCase();
    const params  = req.body?.params || {};  // optional task-specific params

    if (!taskId) return res.status(400).json({ error: 'taskId required' });

    if (AUTO_CARRY_TASK_IDS.has(taskId)) {
      autoCarryLock = await acquireAutoCarryTaskRunLock(agentId);
    }

    // Verify task exists
    const { rows: [task] } = await db.query(
      `SELECT id, tier, fee_usdc FROM task_catalog WHERE id = $1 AND enabled = TRUE`,
      [taskId],
    );
    if (!task) return res.status(404).json({ error: 'task_not_found' });

    const executionParamError = _validateExecutionParams(taskId, params);
    if (executionParamError) {
      return res.status(400).json({ error: executionParamError });
    }

    // Verify ownership
    const { rows: [agent] } = await db.query(
      `SELECT id, daily_tasks_enabled, daily_free_task_count, daily_paid_task_count,
              daily_limit_reset_at, wallet_address, status, is_active,
              security_frozen_at, security_freeze_reason
       FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const isBypass = isDailyLimitBypassed(agent);

    if (!isBypass && !agent.daily_tasks_enabled)
      return res.status(403).json({ error: 'daily_tasks_disabled' });

    const permissionGuard = await queue.guardTaskPermission(taskId, agentId);
    if (!permissionGuard.ok) {
      return _sendPermissionBlocked(res, permissionGuard);
    }

    if (!isBypass && task.tier === 1) {
      // Daily reset check
      if ((new Date() - new Date(agent.daily_limit_reset_at)) >= 86_400_000) {
        await db.query(
          `UPDATE agents SET daily_free_task_count = 0, daily_limit_reset_at = NOW() WHERE id = $1`,
          [agentId],
        );
        agent.daily_free_task_count = 0;
      }
      if (agent.daily_free_task_count >= DAILY_FREE_TASK_CAP) {
        return res.status(429).json({
          error:   'daily_task_cap_reached',
          cap:     DAILY_FREE_TASK_CAP,
          current: agent.daily_free_task_count,
        });
      }
    }

    if (!isBypass && task.tier === 2) {
      // Daily reset check
      if ((new Date() - new Date(agent.daily_limit_reset_at)) >= 86_400_000) {
        await db.query(
          `UPDATE agents SET daily_paid_task_count = 0, daily_limit_reset_at = NOW() WHERE id = $1`,
          [agentId],
        );
        agent.daily_paid_task_count = 0;
      }
      if (agent.daily_paid_task_count >= DAILY_PAID_TASK_CAP) {
        return res.status(429).json({
          error:   'daily_paid_cap_reached',
          cap:     DAILY_PAID_TASK_CAP,
          current: agent.daily_paid_task_count,
        });
      }
    }

    const existingRun = AUTO_CARRY_TASK_IDS.has(taskId)
      ? await taskRunService.findActiveTaskRunForTaskIds(agentId, Array.from(AUTO_CARRY_TASK_IDS))
      : await taskRunService.findActiveTaskRun(agentId, taskId);
    if (existingRun) {
      if (autoCarryLock) {
        await autoCarryLock.release('rollback');
        autoCarryLock = null;
      }
      return res.status(409).json({
        error: 'task_already_running',
        run: existingRun,
      });
    }

    const run = await taskRunService.createTaskRun({
      agentId,
      taskId,
      params,
      stageKey: 'queued',
      stageLabel: 'Queued',
      stageDetail: 'Task request accepted. This card will stay locked until the worker finishes or fails.',
    });

    if (autoCarryLock) {
      await autoCarryLock.release('commit');
      autoCarryLock = null;
    }

    try {
      await queue.queueManualTask(taskId, { agentId, params, taskRunId: run.id });
    } catch (err) {
      await taskRunService.failTaskRun(run.id, {
        error: err.code || err.message || 'manual_task_queue_unavailable',
        stageKey: 'queue_unavailable',
        stageLabel: 'Queue Unavailable',
        stageDetail: 'The task worker was not ready to accept this run request.',
      });

      return res.status(_getInlineTaskFailureStatus(err.code || err.message)).json({
        error: err.code || err.message || 'manual_task_queue_unavailable',
      });
    }

    res.status(202).json({
      queued:  true,
      inline:  false,
      taskId,
      tier:    task.tier,
      feeUsdc: task.tier === 2 ? Number(task.fee_usdc) : 0,
      run,
    });
  } catch (err) {
    if (autoCarryLock) {
      await autoCarryLock.release('rollback').catch(() => {});
    }
    next(err);
  }
});

// ── POST /api/tasks/agents/:id/defi/manual/execute ──────────────────────────
// Queues a manual DeFi pool action without depending on the Tasks switch or the public paid task catalog.
router.post('/agents/:id/defi/manual/quote', requireAuth, async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const resolution = _resolveManualDefiQuote(req.body || {});
    if (resolution.error) {
      return res.status(400).json({ error: resolution.error });
    }

    const { rows: [agent] } = await db.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const curvePool = oracle.resolveCurvePool(resolution.poolKey);
    if (!curvePool?.address) {
      return res.status(409).json({
        amountOut: null,
        quoteError: 'The selected Curve pool is not configured right now.',
      });
    }

    try {
      const quote = await protocols.getCurveQuote(
        curvePool.address,
        resolution.params.indexIn,
        resolution.params.indexOut,
        String(resolution.params.amountIn),
        curvePool.baseToken?.decimals || 6,
        curvePool.quoteToken?.decimals || 6,
      );

      return res.json({
        amountIn: String(resolution.params.amountIn),
        amountOut: quote.amountOut,
        quoteError: null,
        venue: 'curve',
        executionRail: 'curve_pool_quote',
        poolKey: resolution.poolKey,
        poolAddress: curvePool.address,
        poolSource: curvePool.source || 'verified_default',
        fromToken: resolution.params.fromToken,
        toToken: resolution.params.toToken,
      });
    } catch (_quoteError) {
      return res.json({
        amountIn: String(resolution.params.amountIn),
        amountOut: null,
        quoteError: 'Live Curve preview is unavailable right now.',
        venue: 'curve',
        executionRail: 'curve_pool_quote',
        poolKey: resolution.poolKey,
        poolAddress: curvePool.address,
        poolSource: curvePool.source || 'verified_default',
        fromToken: resolution.params.fromToken,
        toToken: resolution.params.toToken,
      });
    }
  } catch (err) { next(err); }
});

router.post('/agents/:id/defi/manual/execute', requireAuth, async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const resolution = _resolveManualDefiExecution(req.body || {});
    if (resolution.error) {
      return res.status(400).json({ error: resolution.error });
    }

    const { rows: [agent] } = await db.query(
      `SELECT id, wallet_address, status, is_active, security_frozen_at, security_freeze_reason
         FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });
    assertAgentOperational(agent);

    const permissionGuard = await queue.guardTaskPermission(resolution.taskId, agentId);
    if (!permissionGuard.ok) {
      return _sendPermissionBlocked(res, permissionGuard);
    }

    if (resolution.lane === 'lending') {
      let validation;

      if (resolution.action === 'collateral_top_up') {
        validation = await nativeLendingRiskService.guardAgentCollateralTopUp({ agent });
      } else if (resolution.action === 'safe_exit') {
        validation = await nativeLendingRiskService.guardAgentSafeExit({ agent });
      } else if (resolution.action === 'deleverage') {
        validation = await nativeLendingRiskService.guardAgentEmergencyDeleverage({ agent });
      } else if (resolution.action === 'liquidate') {
        validation = await nativeLendingRiskService.guardAgentLiquidationAction({
          agent,
          borrower: resolution.params.borrower,
          debtAsset: resolution.params.debtAsset,
          collateralAsset: resolution.params.collateralAsset,
          amount: resolution.params.amount,
        });
      } else {
        validation = await nativeLendingRiskService.guardAgentManualLendingAction({
          agent,
          action: resolution.action,
          asset: resolution.asset,
          amount: resolution.params.amount,
        });
      }

      if (!validation.ok) {
        return res.status(_getInlineTaskFailureStatus(validation.code)).json({
          error: validation.code,
          detail: validation.verdict?.detail || 'Manual lending action blocked by the current risk guard.',
          risk: validation.surface?.risk || validation.borrowerSurface?.risk || null,
          recovery: validation.surface?.recovery || null,
          collateralTopUp: validation.surface?.collateralTopUp || null,
          safeExit: validation.surface?.safeExit || null,
          liquidation: validation.borrowerSurface?.liquidation || validation.surface?.liquidation || null,
          actionGuard: validation.surface?.actionGuards?.[resolution.asset]?.[resolution.action] || null,
        });
      }
    }

    const { rows: [task] } = await db.query(
      `SELECT id, tier, fee_usdc FROM task_catalog WHERE id = $1`,
      [resolution.taskId],
    );
    if (!task) return res.status(404).json({ error: 'manual_defi_task_not_found' });

    const existingRun = await taskRunService.findActiveTaskRun(agentId, resolution.taskId);
    if (existingRun) {
      return res.status(409).json({
        error: 'task_already_running',
        run: existingRun,
      });
    }

    const run = await taskRunService.createTaskRun({
      agentId,
      taskId: resolution.taskId,
      params: resolution.params,
      stageKey: 'queued',
      stageLabel: 'Queued',
      stageDetail: 'Manual DeFi action accepted and waiting for worker pickup.',
    });

    try {
      await queue.queueManualTask(resolution.taskId, { agentId, params: resolution.params, taskRunId: run.id });
    } catch (err) {
      await taskRunService.failTaskRun(run.id, {
        error: err.code || err.message || 'manual_task_queue_unavailable',
        stageKey: 'queue_unavailable',
        stageLabel: 'Queue Unavailable',
        stageDetail: 'The manual DeFi worker was not ready to accept this action.',
      });

      return res.status(_getInlineTaskFailureStatus(err.code || err.message)).json({
        error: err.code || err.message || 'manual_task_queue_unavailable',
      });
    }

    return res.status(202).json({
      queued: true,
      inline: false,
      lane: resolution.lane || 'liquidity',
      poolKey: resolution.poolKey,
      action: resolution.action,
      asset: resolution.asset || null,
      borrower: resolution.params?.borrower || null,
      feeUsdc: Number(task.fee_usdc) || 0,
      run,
    });
  } catch (err) { next(err); }
});

// ── GET /api/agents/:id/tasks/results ─────────────────────────────────────────
// Returns the last 20 task results for the agent (most recent first).
router.get('/agents/:id/tasks/results', requireAuth, async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const limit   = Math.min(parseInt(req.query.limit || '20', 10), 100);

    // Verify ownership
    const { rows: [agent] } = await db.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const { rows } = await db.query(
      `SELECT r.id, r.task_id, r.payload, r.created_at,
              t.title, t.description
       FROM agent_task_results r
       JOIN task_catalog t ON t.id = r.task_id
       WHERE r.agent_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [agentId, limit],
    );

    res.json({ results: rows });
  } catch (err) { next(err); }
});

// ── Helper ────────────────────────────────────────────────────────────────────
function _nextMidnightUtc() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

module.exports = router;
