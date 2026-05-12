'use strict';
/**
 * GET  /api/tasks/featured          — today's 5 rotating featured tasks (no auth required)
 * POST /api/agents/:id/tasks/run    — queue a free task for an agent
 * GET  /api/agents/:id/tasks/results — last N task results for an agent
 */
const router          = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db              = require('../db');
const queue           = require('../queue/agentQueue');

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

// ── POST /api/agents/:id/tasks/run ────────────────────────────────────────────
// Queues a single free task job for the agent.
router.post('/agents/:id/tasks/run', requireAuth, async (req, res, next) => {
  try {
    const agentId = req.params.id;
    const taskId  = String(req.body?.taskId || '').trim().toUpperCase();

    if (!taskId) return res.status(400).json({ error: 'taskId required' });

    // Verify task exists and is free tier
    const { rows: [task] } = await db.query(
      `SELECT id, tier FROM task_catalog WHERE id = $1 AND enabled = TRUE`,
      [taskId],
    );
    if (!task)          return res.status(404).json({ error: 'task_not_found' });
    if (task.tier !== 1) return res.status(403).json({ error: 'paid_task_requires_payment_flow' });

    // Verify ownership
    const { rows: [agent] } = await db.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, req.user.userId],
    );
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const job = await queue.add(taskId, { agentId }, {
      jobId:            `${taskId.toLowerCase()}-${agentId}-${Date.now()}`,
      removeOnComplete: 200,
    });

    res.status(202).json({ queued: true, jobId: job.id, taskId });
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
