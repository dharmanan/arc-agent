'use strict';

function buildFeeSettlementRetryJobId(intentId) {
  return `fee-settlement-retry:${String(intentId || '').trim()}`;
}

function toUnixMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRetryIntentDueForQueue(intent, nowMs = Date.now()) {
  const status = String(intent?.status || '').trim().toLowerCase();
  if (status !== 'pending' && status !== 'deferred') {
    return false;
  }

  const attemptCount = Number(intent?.attempt_count || 0);
  const maxAttempts = Number(intent?.max_attempts || 0);
  if (maxAttempts > 0 && attemptCount >= maxAttempts) {
    return false;
  }

  const nextAttemptAtMs = toUnixMs(intent?.next_attempt_at);
  if (nextAttemptAtMs != null && nextAttemptAtMs > nowMs) {
    return false;
  }

  return true;
}

function canEnqueueRetryJobState(jobState) {
  const normalized = String(jobState || '').trim().toLowerCase();
  return normalized !== 'waiting'
    && normalized !== 'active'
    && normalized !== 'delayed'
    && normalized !== 'paused';
}

async function safeGetJob(queue, jobId) {
  if (!queue || typeof queue.getJob !== 'function') return null;
  return queue.getJob(jobId).catch(() => null);
}

async function ensureRetryJobVisible(queue, options = {}) {
  const jobId = String(options.jobId || '').trim();
  if (!jobId) {
    return {
      queued: false,
      reason: 'job_id_missing',
      existingJob: null,
      addError: null,
    };
  }

  const existingJob = await safeGetJob(queue, jobId);
  if (existingJob) {
    return {
      queued: true,
      reason: 'existing_job',
      existingJob,
      addError: null,
    };
  }

  let addError = null;
  if (!queue || typeof queue.add !== 'function') {
    addError = new Error('queue_add_missing');
  } else {
    try {
      await queue.add(options.name, options.data, options.opts);
    } catch (error) {
      addError = error;
    }
  }

  const existingAfterAdd = await safeGetJob(queue, jobId);
  if (existingAfterAdd) {
    return {
      queued: true,
      reason: addError ? 'existing_job_after_add_error' : 'enqueued_visible',
      existingJob: existingAfterAdd,
      addError,
    };
  }

  return {
    queued: false,
    reason: addError ? 'add_failed' : 'job_not_visible_after_add',
    existingJob: null,
    addError,
  };
}

module.exports = {
  buildFeeSettlementRetryJobId,
  isRetryIntentDueForQueue,
  canEnqueueRetryJobState,
  ensureRetryJobVisible,
};
