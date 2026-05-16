'use strict';

const db = require('../db');

const ACTIVE_TASK_RUN_STATUSES = ['queued', 'running'];

function normalizeLimit(limit, fallback = 20) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

async function createTaskRun({
  agentId,
  taskId,
  params = {},
  stageKey = 'queued',
  stageLabel = 'Queued',
  stageDetail = 'Task request accepted and waiting for worker pickup.',
}) {
  const { rows: [row] } = await db.query(
    `INSERT INTO agent_task_runs (
       agent_id,
       task_id,
       status,
       stage_key,
       stage_label,
       stage_detail,
       params
     ) VALUES ($1, $2, 'queued', $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [agentId, taskId, stageKey, stageLabel, stageDetail, JSON.stringify(params || {})],
  );

  return row;
}

async function findActiveTaskRun(agentId, taskId) {
  const { rows: [row] } = await db.query(
    `SELECT r.*, t.title, t.description
       FROM agent_task_runs r
       JOIN task_catalog t ON t.id = r.task_id
      WHERE r.agent_id = $1
        AND r.task_id = $2
        AND r.status = ANY($3::text[])
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [agentId, taskId, ACTIVE_TASK_RUN_STATUSES],
  );

  return row || null;
}

async function listTaskRuns(agentId, { status = 'recent', limit = 20 } = {}) {
  const normalizedLimit = normalizeLimit(limit);

  if (status === 'active') {
    const { rows } = await db.query(
      `SELECT r.*, t.title, t.description
         FROM agent_task_runs r
         JOIN task_catalog t ON t.id = r.task_id
        WHERE r.agent_id = $1
          AND r.status = ANY($2::text[])
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [agentId, ACTIVE_TASK_RUN_STATUSES, normalizedLimit],
    );

    return rows;
  }

  const { rows } = await db.query(
    `SELECT r.*, t.title, t.description
       FROM agent_task_runs r
       JOIN task_catalog t ON t.id = r.task_id
      WHERE r.agent_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [agentId, normalizedLimit],
  );

  return rows;
}

async function getTaskRun(agentId, runId) {
  const { rows: [row] } = await db.query(
    `SELECT r.*, t.title, t.description
       FROM agent_task_runs r
       JOIN task_catalog t ON t.id = r.task_id
      WHERE r.agent_id = $1
        AND r.id = $2
      LIMIT 1`,
    [agentId, runId],
  );

  return row || null;
}

async function updateTaskRunStage(runId, {
  status = 'running',
  stageKey = null,
  stageLabel = null,
  stageDetail = null,
  error = null,
}) {
  const { rows: [row] } = await db.query(
    `UPDATE agent_task_runs
        SET status = $2,
            stage_key = COALESCE($3, stage_key),
            stage_label = COALESCE($4, stage_label),
            stage_detail = COALESCE($5, stage_detail),
            error = COALESCE($6, error)
      WHERE id = $1
      RETURNING *`,
    [runId, status, stageKey, stageLabel, stageDetail, error],
  );

  return row || null;
}

async function markTaskRunRunning(runId, {
  stageKey = 'running',
  stageLabel = 'Running',
  stageDetail = 'Task execution is in progress.',
} = {}) {
  return updateTaskRunStage(runId, {
    status: 'running',
    stageKey,
    stageLabel,
    stageDetail,
  });
}

async function completeTaskRun(runId, {
  resultPayload = null,
  stageKey = 'completed',
  stageLabel = 'Completed',
  stageDetail = 'Task completed successfully.',
} = {}) {
  const { rows: [row] } = await db.query(
    `UPDATE agent_task_runs
        SET status = 'completed',
            stage_key = $2,
            stage_label = $3,
            stage_detail = $4,
            result_payload = $5::jsonb,
            error = NULL,
            completed_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [runId, stageKey, stageLabel, stageDetail, JSON.stringify(resultPayload || {})],
  );

  return row || null;
}

async function failTaskRun(runId, {
  error,
  stageKey = 'failed',
  stageLabel = 'Failed',
  stageDetail = null,
  resultPayload = null,
} = {}) {
  const message = error ? String(error) : 'Task execution failed.';
  const { rows: [row] } = await db.query(
    `UPDATE agent_task_runs
        SET status = 'failed',
            stage_key = $2,
            stage_label = $3,
            stage_detail = COALESCE($4, $5),
            error = $5,
            result_payload = COALESCE($6::jsonb, result_payload),
            completed_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [runId, stageKey, stageLabel, stageDetail, message, resultPayload ? JSON.stringify(resultPayload) : null],
  );

  return row || null;
}

module.exports = {
  ACTIVE_TASK_RUN_STATUSES,
  completeTaskRun,
  createTaskRun,
  failTaskRun,
  findActiveTaskRun,
  getTaskRun,
  listTaskRuns,
  markTaskRunRunning,
  updateTaskRunStage,
};