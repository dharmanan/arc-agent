'use strict';

const {
  buildFeeSettlementRetryJobId,
  isRetryIntentDueForQueue,
  canEnqueueRetryJobState,
  ensureRetryJobVisible,
} = require('../paymentRetryQueueUtils');

describe('paymentRetryQueueUtils', () => {
  test('buildFeeSettlementRetryJobId is deterministic per intent id', () => {
    expect(buildFeeSettlementRetryJobId('intent-123')).toBe('fee-settlement-retry:intent-123');
    expect(buildFeeSettlementRetryJobId('intent-123')).toBe('fee-settlement-retry:intent-123');
  });

  test('canEnqueueRetryJobState blocks live queue duplicates', () => {
    expect(canEnqueueRetryJobState('waiting')).toBe(false);
    expect(canEnqueueRetryJobState('active')).toBe(false);
    expect(canEnqueueRetryJobState('delayed')).toBe(false);
    expect(canEnqueueRetryJobState('paused')).toBe(false);
    expect(canEnqueueRetryJobState('completed')).toBe(true);
    expect(canEnqueueRetryJobState('failed')).toBe(true);
  });

  test('isRetryIntentDueForQueue accepts only pending/deferred intents that are due and under max attempts', () => {
    const now = Date.now();

    expect(isRetryIntentDueForQueue({
      status: 'pending',
      attempt_count: 0,
      max_attempts: 10,
      next_attempt_at: new Date(now - 1000).toISOString(),
    }, now)).toBe(true);

    expect(isRetryIntentDueForQueue({
      status: 'manual_review',
      attempt_count: 0,
      max_attempts: 10,
      next_attempt_at: null,
    }, now)).toBe(false);

    expect(isRetryIntentDueForQueue({
      status: 'deferred',
      attempt_count: 10,
      max_attempts: 10,
      next_attempt_at: null,
    }, now)).toBe(false);

    expect(isRetryIntentDueForQueue({
      status: 'deferred',
      attempt_count: 1,
      max_attempts: 10,
      next_attempt_at: new Date(now + 60_000).toISOString(),
    }, now)).toBe(false);
  });

  test('ensureRetryJobVisible returns queued when a new deterministic job is visible after add', async () => {
    const job = { id: 'fee-settlement-retry:intent-1' };
    const queue = {
      getJob: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(job),
      add: jest.fn().mockResolvedValue({ id: 'synthetic-fallback-job' }),
    };

    const result = await ensureRetryJobVisible(queue, {
      jobId: 'fee-settlement-retry:intent-1',
      name: 'FEE_SETTLEMENT_RETRY',
      data: { intentId: 'intent-1' },
      opts: { jobId: 'fee-settlement-retry:intent-1' },
    });

    expect(result.queued).toBe(true);
    expect(result.reason).toBe('enqueued_visible');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.getJob).toHaveBeenCalledTimes(2);
  });

  test('ensureRetryJobVisible treats existing singleton job as queued without add', async () => {
    const queue = {
      getJob: jest.fn().mockResolvedValue({ id: 'fee-settlement-retry:intent-2' }),
      add: jest.fn(),
    };

    const result = await ensureRetryJobVisible(queue, {
      jobId: 'fee-settlement-retry:intent-2',
      name: 'FEE_SETTLEMENT_RETRY',
      data: { intentId: 'intent-2' },
      opts: { jobId: 'fee-settlement-retry:intent-2' },
    });

    expect(result.queued).toBe(true);
    expect(result.reason).toBe('existing_job');
    expect(queue.add).not.toHaveBeenCalled();
  });

  test('ensureRetryJobVisible rejects synthetic add fallback when deterministic job is not visible', async () => {
    const queue = {
      getJob: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      add: jest.fn().mockResolvedValue({ id: 'synthetic-fallback-job' }),
    };

    const result = await ensureRetryJobVisible(queue, {
      jobId: 'fee-settlement-retry:intent-3',
      name: 'FEE_SETTLEMENT_RETRY',
      data: { intentId: 'intent-3' },
      opts: { jobId: 'fee-settlement-retry:intent-3' },
    });

    expect(result.queued).toBe(false);
    expect(result.reason).toBe('job_not_visible_after_add');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  test('ensureRetryJobVisible reports add failure when no deterministic job exists', async () => {
    const addError = new Error('queue add failed');
    const queue = {
      getJob: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      add: jest.fn().mockRejectedValue(addError),
    };

    const result = await ensureRetryJobVisible(queue, {
      jobId: 'fee-settlement-retry:intent-4',
      name: 'FEE_SETTLEMENT_RETRY',
      data: { intentId: 'intent-4' },
      opts: { jobId: 'fee-settlement-retry:intent-4' },
    });

    expect(result.queued).toBe(false);
    expect(result.reason).toBe('add_failed');
    expect(result.addError).toBe(addError);
  });
});
