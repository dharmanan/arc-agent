'use strict';

const db = require('../db');

const ACTIVE_TASK_RUN_STATUSES = ['queued', 'running'];
const TASK_RUN_STALE_TIMEOUT_MINUTES = (() => {
  const parsed = Number.parseInt(process.env.TASK_RUN_STALE_TIMEOUT_MINUTES || '20', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
})();

function normalizeLimit(limit, fallback = 20) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function _isActiveStatus(status) {
  return ACTIVE_TASK_RUN_STATUSES.includes(String(status || '').toLowerCase());
}

function _isTaskRunStale(row) {
  if (!row || !_isActiveStatus(row.status)) return false;
  const updatedAtMs = new Date(row.updated_at || row.created_at || 0).getTime();
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return false;
  return (Date.now() - updatedAtMs) >= TASK_RUN_STALE_TIMEOUT_MINUTES * 60_000;
}

function _buildStaleTaskRunDetail(row) {
  const taskId = String(row?.task_id || '').trim().toUpperCase();
  if (taskId === 'EXEC_SEPOLIA_GAS_FANOUT' || taskId === 'EXEC_CCTP_BRIDGE') {
    return 'The previous worker stopped before saving the final bridge status. Destination funds may already have arrived, so review balances before retrying this task.';
  }

  return 'The previous worker stopped before writing a final result. This stale task run was closed so you can retry it safely.';
}

async function _recoverTaskRunRow(row) {
  if (!row || !_isTaskRunStale(row)) return row || null;

  const { rows: [latestResult] } = await db.query(
    `SELECT payload, created_at
       FROM agent_task_results
      WHERE agent_id = $1
        AND task_id = $2
        AND created_at >= $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [row.agent_id, row.task_id, row.created_at],
  );

  if (latestResult?.payload) {
    return completeTaskRun(row.id, {
      resultPayload: latestResult.payload,
      stageKey: 'recovered_completed',
      stageLabel: 'Completed',
      stageDetail: latestResult.payload.summary || 'Recovered a completed task result after a worker restart.',
    });
  }

  return failTaskRun(row.id, {
    error: 'stale_task_run_closed',
    stageKey: 'worker_interrupted',
    stageLabel: 'Worker Interrupted',
    stageDetail: _buildStaleTaskRunDetail(row),
    resultPayload: {
      staleRunClosed: true,
      recoveredFrom: 'active_timeout',
      lastKnownStageKey: row.stage_key || null,
      lastKnownStageLabel: row.stage_label || null,
    },
  });
}

async function _recoverStaleTaskRuns(agentId, { taskId = null } = {}) {
  const params = [agentId, ACTIVE_TASK_RUN_STATUSES];
  const taskFilter = taskId ? 'AND r.task_id = $3' : '';
  if (taskId) params.push(taskId);

  const { rows } = await db.query(
    `SELECT r.*, t.title, t.description
       FROM agent_task_runs r
       JOIN task_catalog t ON t.id = r.task_id
      WHERE r.agent_id = $1
        AND r.status = ANY($2::text[])
        ${taskFilter}
      ORDER BY r.created_at DESC`,
    params,
  );

  for (const row of rows) {
    await _recoverTaskRunRow(row);
  }
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
  await _recoverStaleTaskRuns(agentId, { taskId });

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

async function findActiveTaskRunForTaskIds(agentId, taskIds = []) {
  const normalizedTaskIds = Array.from(new Set(
    (Array.isArray(taskIds) ? taskIds : [])
      .map(taskId => String(taskId || '').trim().toUpperCase())
      .filter(Boolean),
  ));

  if (normalizedTaskIds.length === 0) return null;

  await _recoverStaleTaskRuns(agentId);

  const { rows: [row] } = await db.query(
    `SELECT r.*, t.title, t.description
       FROM agent_task_runs r
       JOIN task_catalog t ON t.id = r.task_id
      WHERE r.agent_id = $1
        AND r.task_id = ANY($2::text[])
        AND r.status = ANY($3::text[])
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [agentId, normalizedTaskIds, ACTIVE_TASK_RUN_STATUSES],
  );

  return row || null;
}

async function listTaskRuns(agentId, { status = 'recent', limit = 20 } = {}) {
  await _recoverStaleTaskRuns(agentId);

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

  if (_isTaskRunStale(row)) {
    return _recoverTaskRunRow(row);
  }

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
  findActiveTaskRunForTaskIds,
  getTaskRun,
  listTaskRuns,
  markTaskRunRunning,
  updateTaskRunStage,
};