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

// ── Minimal ABI for ArcRevenuePool.getPoolBalance() ──────────────────────────
const _POOL_VIEW_ABI = ['function getPoolBalance() external view returns (uint256)'];

function _getPoolContract() {
  const addr = process.env.REVENUE_POOL_ADDRESS;
  const rpc  = process.env.ARC_TESTNET_RPC || 'https://rpc.arc-testnet.io';
  if (!addr) return null;
  const provider = new ethers.JsonRpcProvider(rpc);
  return new ethers.Contract(addr, _POOL_VIEW_ABI, provider);
}

const DAILY_PAID_TASK_CAP = parseInt(process.env.DAILY_PAID_TASK_CAP || '5', 10);

// Dev-only: wallet addresses that bypass all daily task limits
const DEV_BYPASS_ADDRS = new Set(
  (process.env.DEV_BYPASS_AGENT_ADDRESSES || '')
    .split(',').map(a => a.trim().toLowerCase()).filter(Boolean),
);

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
    const pool = _getPoolContract();
    if (!pool) return res.json({ balanceUsdc: null, note: 'REVENUE_POOL_ADDRESS not configured' });
    const raw  = await pool.getPoolBalance();
    const usdc = Number(raw) / 1_000_000;
    res.json({ balanceUsdc: usdc, address: process.env.REVENUE_POOL_ADDRESS });
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

    // Verify ownership
    const { rows: [agent] } = await db.query(
      `SELECT id, daily_tasks_enabled, daily_free_task_count, daily_paid_task_count,
              daily_limit_reset_at, wallet_address
       FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const isBypass = DEV_BYPASS_ADDRS.size > 0 &&
      DEV_BYPASS_ADDRS.has((agent.wallet_address || '').toLowerCase());

    if (!isBypass && !agent.daily_tasks_enabled)
      return res.status(403).json({ error: 'daily_tasks_disabled' });

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

    const job = await queue.add(taskId, { agentId, params }, {
      jobId:            `${taskId.toLowerCase()}-${agentId}-${Date.now()}`,
      removeOnComplete: 200,
    });

    res.status(202).json({
      queued:  true,
      jobId:   job.id,
      taskId,
      tier:    task.tier,
      feeUsdc: task.tier === 2 ? Number(task.fee_usdc) : 0,
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
