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
const { isDailyLimitBypassed } = require('../services/dailyLimitBypass');
const taskRunService = require('../services/taskRunService');

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

const DAILY_PAID_TASK_CAP = parseInt(process.env.DAILY_PAID_TASK_CAP || '5', 10);
const DAILY_FREE_TASK_CAP = parseInt(process.env.DAILY_FREE_TASK_CAP || '5', 10);
const EXECUTION_TASK_IDS = new Set([
  'EXEC_CURVE_SWAP',
  'EXEC_CURVE_LIQUIDITY_ADD',
  'EXEC_CURVE_LIQUIDITY_REMOVE',
  'EXEC_CIRBTC_USDC_ZAP_IN',
  'EXEC_CIRBTC_EURC_ZAP_IN',
  'EXEC_CIRBTC_USDC_LP_REMOVE',
  'EXEC_CIRBTC_EURC_LP_REMOVE',
  'EXEC_CCTP_BRIDGE',
  'EXEC_SEPOLIA_GAS_FANOUT',
  'EXEC_ARB',
  'EXEC_REBALANCE',
]);
const CURVE_POOL_TOKENS = new Set(['USDC', 'EURC']);
const DIRECT_PAIR_ZAP_LIMITS = {
  EXEC_CIRBTC_USDC_ZAP_IN: 20,
  EXEC_CIRBTC_EURC_ZAP_IN: 16,
};
const CCTP_CHAIN_NAMES = new Set([
  'Arc Testnet',
  'Sepolia',
  'Base Sepolia',
  'Optimism Sepolia',
  'Arbitrum Sepolia',
]);
const REBALANCE_TOKENS = new Set(['USDC', 'EURC']);

function _isPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function _isBinaryIndex(value) {
  return Number(value) === 0 || Number(value) === 1;
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
      return 503;
    case 'swap_not_configured':
    case 'direct_pair_not_configured':
      return 503;
    case 'lp_position_not_found':
    case 'insufficient_lp_position':
    case 'lp_position_exit_required':
    case 'direct_pair_lp_not_found':
    case 'direct_pair_seed_required':
    case 'task_already_running':
      return 409;
    case 'curve_pool_not_configured':
    case 'pool_address_not_configured':
    case 'bridge_params_required':
    case 'wallet_not_configured':
    case 'no_private_key':
    default:
      return 400;
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
  try {
    const agentId = req.params.id;
    const taskId  = String(req.body?.taskId || '').trim().toUpperCase();
    const params  = req.body?.params || {};  // optional task-specific params

    if (!taskId) return res.status(400).json({ error: 'taskId required' });

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
              daily_limit_reset_at, wallet_address
       FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const isBypass = isDailyLimitBypassed(agent);

    if (!isBypass && !agent.daily_tasks_enabled)
      return res.status(403).json({ error: 'daily_tasks_disabled' });

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

    const existingRun = await taskRunService.findActiveTaskRun(agentId, taskId);
    if (existingRun) {
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
