'use strict';

function loadHarness({ queryImpl, clientQueryImpl, healthyRpcUrl = 'https://rpc.testnet.arc.network' } = {}) {
  jest.resetModules();

  const query = jest.fn(async (sql, params) => {
    if (typeof queryImpl === 'function') {
      return queryImpl(sql, params);
    }
    return { rows: [] };
  });

  const client = {
    query: jest.fn(async (sql, params) => {
      if (typeof clientQueryImpl === 'function') {
        return clientQueryImpl(sql, params);
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };

  const getClient = jest.fn(async () => client);

  jest.doMock('../../../db', () => ({ query, getClient }));
  const getHealthyArcRpcUrl = jest.fn(() => healthyRpcUrl);
  jest.doMock('../../arcProvider', () => ({ getHealthyArcRpcUrl }));

  const paymentRetryService = require('../paymentRetryService');
  return {
    paymentRetryService,
    query,
    client,
    getClient,
    getHealthyArcRpcUrl,
  };
}

const BASE_INTENT_ROW = {
  id: 'intent-1',
  idempotency_key: 'idem-1',
  agent_id: 'agent-1',
  event_type: 'task_execution_fee',
  rail: 'agentic_automation_economy',
  reference_type: 'automation',
  reference_id: 'ref-1',
  fee_usdc: 0.1,
  token: 'USDC',
  source_chain: 'Arc Testnet',
  destination_chain: 'Arc Testnet',
  recipient_address: '0x1111111111111111111111111111111111111111',
  status: 'processing',
  attempt_count: 0,
  max_attempts: 10,
  next_attempt_at: null,
  locked_at: '2026-07-17T00:00:00.000Z',
  locked_by: 'payment-retry-worker:intent-1',
  payload: {
    mode: 'circle_gateway_automation_fee',
  },
};

describe('paymentRetryService', () => {
  test('buildPaymentIdempotencyKey is deterministic across field order', () => {
    const { paymentRetryService } = loadHarness();

    const keyA = paymentRetryService.buildPaymentIdempotencyKey({
      agentId: 'agent-1',
      rail: 'agentic_task_economy',
      referenceType: 'task',
      referenceId: 'task-1',
      feeUsdc: 0.1,
      recipient: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
    });

    const keyB = paymentRetryService.buildPaymentIdempotencyKey({
      destinationChain: 'Arc Testnet',
      sourceChain: 'Arc Testnet',
      recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      feeUsdc: '0.100000',
      referenceId: 'task-1',
      referenceType: 'task',
      rail: 'agentic_task_economy',
      agentId: 'agent-1',
    });

    expect(keyA).toBe(keyB);
  });

  test('buildPaymentIdempotencyKey normalizes fee precision to 6 decimals', () => {
    const { paymentRetryService } = loadHarness();

    const keyA = paymentRetryService.buildPaymentIdempotencyKey({
      agentId: 'agent-1',
      rail: 'agentic_task_economy',
      referenceType: 'task',
      referenceId: 'task-1',
      feeUsdc: 0.1,
      recipient: '0x1111111111111111111111111111111111111111',
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
    });

    const keyB = paymentRetryService.buildPaymentIdempotencyKey({
      agentId: 'agent-1',
      rail: 'agentic_task_economy',
      referenceType: 'task',
      referenceId: 'task-1',
      feeUsdc: '0.1000000000',
      recipient: '0x1111111111111111111111111111111111111111',
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
    });

    expect(keyA).toBe(keyB);
  });

  test('createOrUpdateRetryIntent prevents duplicate rows for same idempotency key', async () => {
    const { paymentRetryService, query } = loadHarness();

    query
      .mockResolvedValueOnce({ rows: [{ id: 'intent-1', idempotency_key: 'idem-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'intent-1', idempotency_key: 'idem-1' }] });

    const first = await paymentRetryService.createOrUpdateRetryIntent({
      idempotencyKey: 'idem-1',
      agentId: 'agent-1',
      eventType: 'task_execution_fee',
      rail: 'agentic_task_economy',
      referenceType: 'task',
      referenceId: 'task-1',
      feeUsdc: 0.1,
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
      recipientAddress: '0x1111111111111111111111111111111111111111',
      status: 'deferred',
    }, { conflictMode: 'insert_only' });

    const second = await paymentRetryService.createOrUpdateRetryIntent({
      idempotencyKey: 'idem-1',
      agentId: 'agent-1',
      eventType: 'task_execution_fee',
      rail: 'agentic_task_economy',
      referenceType: 'task',
      referenceId: 'task-1',
      feeUsdc: 0.1,
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
      recipientAddress: '0x1111111111111111111111111111111111111111',
      status: 'deferred',
    }, { conflictMode: 'insert_only' });

    expect(first.created).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });

  test('backfillDeferredPaymentEvents skips confirmed and duplicate intents idempotently', async () => {
    const deferredRows = [
      {
        id: 10,
        agent_id: 'agent-1',
        event_type: 'task_execution_fee',
        rail: 'agentic_automation_economy',
        reference_type: 'automation',
        reference_id: 'tx-1',
        amount_usdc: 0.1,
        token: 'USDC',
        source_chain: 'Arc Testnet',
        destination_chain: 'Arc Testnet',
        counterparty_address: '0x1111111111111111111111111111111111111111',
        payload: { retryIntent: { fromChain: 'Arc Testnet', toChain: 'Arc Testnet' } },
      },
      {
        id: 11,
        agent_id: 'agent-1',
        event_type: 'task_execution_fee',
        rail: 'agentic_automation_economy',
        reference_type: 'automation',
        reference_id: 'tx-2',
        amount_usdc: 0.1,
        token: 'USDC',
        source_chain: 'Arc Testnet',
        destination_chain: 'Arc Testnet',
        counterparty_address: '0x1111111111111111111111111111111111111111',
        payload: { retryIntent: { fromChain: 'Arc Testnet', toChain: 'Arc Testnet' } },
      },
    ];

    const { paymentRetryService, query } = loadHarness({
      queryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_events') && normalized.includes("status = 'deferred'")) {
          return { rows: deferredRows };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          if (!query.mock.calls.length || query.mock.calls.length < 3) {
            return { rows: [{ id: 999 }] };
          }
          return { rows: [] };
        }
        if (normalized.includes('insert into agentic_payment_retry_intents')) {
          return { rows: [] };
        }
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('idempotency_key')) {
          return { rows: [{ id: 'intent-existing' }] };
        }
        return { rows: [] };
      },
    });

    const summary = await paymentRetryService.backfillDeferredPaymentEvents({ limit: 20 });

    expect(summary.scanned).toBe(2);
    expect(summary.inserted).toBe(0);
    expect(summary.skippedConfirmed).toBe(1);
    expect(summary.skippedDuplicate).toBe(1);
    expect(summary.invalidPayload).toBe(0);
  });

  test('claimDueRetryIntents uses FOR UPDATE SKIP LOCKED for atomic claiming', async () => {
    const seenSql = [];
    const { paymentRetryService, client } = loadHarness({
      clientQueryImpl: async (sql) => {
        seenSql.push(String(sql));
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        return { rows: [{ ...BASE_INTENT_ROW, status: 'processing' }] };
      },
    });

    const claimed = await paymentRetryService.claimDueRetryIntents({
      batchSize: 5,
      workerId: 'worker-A',
      lockTimeoutMs: 900000,
    });

    expect(claimed).toHaveLength(1);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(seenSql.join('\n')).toContain('FOR UPDATE SKIP LOCKED');
  });

  test('processRetryIntent defers on shared Arc cooldown without settlement attempt increment', async () => {
    const settleExecutionFee = jest.fn();
    const { paymentRetryService, query, getHealthyArcRpcUrl } = loadHarness({
      healthyRpcUrl: null,
      queryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          return { rows: [] };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'deferred'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'deferred', next_attempt_at: '2026-07-17T01:00:00.000Z' }] };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 1 }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee,
      jitterFn: (delay) => delay,
    });

    expect(result.status).toBe('deferred');
    expect(settleExecutionFee).not.toHaveBeenCalled();
    expect(getHealthyArcRpcUrl).toHaveBeenCalledWith('payment_retry_preflight', {
      trafficClass: 'gateway_payment',
    });
    const attemptIncrementQueries = query.mock.calls.filter(([sql]) => String(sql).includes('attempt_count = attempt_count + 1'));
    expect(attemptIncrementQueries).toHaveLength(0);
  });

  test('processRetryIntent marks confirmed when settlement returns mint hash', async () => {
    const settleExecutionFee = jest.fn(async () => ({
      status: 'confirmed',
      gatewayMintTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      gatewayApprovalTxHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      gatewayDepositTxHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      transferResult: {
        mintTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    }));

    const { paymentRetryService, query } = loadHarness({
      queryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          return { rows: [] };
        }
        if (normalized.includes('from agents where id = $1')) {
          return { rows: [{ id: 'agent-1', private_key_encrypted: 'enc' }] };
        }
        if (normalized.includes('set attempt_count = attempt_count + 1')) {
          return { rows: [{ ...BASE_INTENT_ROW, attempt_count: 1 }] };
        }
        if (normalized.includes("update agentic_payment_retry_intents")
          && normalized.includes("set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb")
          && normalized.includes("and status = 'processing'")) {
          return {
            rows: [{
              ...BASE_INTENT_ROW,
              attempt_count: 1,
              payload: {
                ...BASE_INTENT_ROW.payload,
                submissionPhase: 'submission_started',
              },
            }],
          };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 33 }] };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'manual_review'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'manual_review' }] };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'failed'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'failed' }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      clientQueryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('for update')) {
          return { rows: [{ ...BASE_INTENT_ROW, attempt_count: 1 }] };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'confirmed'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'confirmed', attempt_count: 1 }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          return { rows: [] };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 77 }] };
        }
        throw new Error(`Unexpected client SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee,
    });

    expect(result.status).toBe('confirmed');
    expect(settleExecutionFee).toHaveBeenCalledTimes(1);

    const attemptIncrementCalls = query.mock.calls.filter(([sql]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
      return normalized.includes('set attempt_count = attempt_count + 1');
    });
    expect(attemptIncrementCalls).toHaveLength(1);

    const submissionStartedCallIndex = query.mock.calls.findIndex(([sql]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
      return normalized.includes("update agentic_payment_retry_intents")
        && normalized.includes("set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb")
        && normalized.includes("and status = 'processing'");
    });
    expect(submissionStartedCallIndex).toBeGreaterThanOrEqual(0);

    const submissionStartedOrder = query.mock.invocationCallOrder[submissionStartedCallIndex];
    const settleOrder = settleExecutionFee.mock.invocationCallOrder[0];
    expect(submissionStartedOrder).toBeLessThan(settleOrder);
  });

  test('processRetryIntent routes post-broadcast ambiguity to manual_review', async () => {
    const settleExecutionFee = jest.fn(async () => ({
      status: 'failed',
      reason: 'gateway_transfer_unconfirmed',
      gatewayDepositTxHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      gatewayMintTxHash: null,
    }));

    const { paymentRetryService } = loadHarness({
      queryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          return { rows: [] };
        }
        if (normalized.includes('from agents where id = $1')) {
          return { rows: [{ id: 'agent-1', private_key_encrypted: 'enc' }] };
        }
        if (normalized.includes('set attempt_count = attempt_count + 1')) {
          return { rows: [{ ...BASE_INTENT_ROW, attempt_count: 1 }] };
        }
        if (normalized.includes("update agentic_payment_retry_intents")
          && normalized.includes("set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb")
          && normalized.includes("and status = 'processing'")) {
          return {
            rows: [{
              ...BASE_INTENT_ROW,
              attempt_count: 1,
              payload: {
                ...BASE_INTENT_ROW.payload,
                submissionPhase: 'submission_started',
              },
            }],
          };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'manual_review'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'manual_review' }] };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 91 }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee,
    });

    expect(result.status).toBe('manual_review');
  });

  test('processRetryIntent marks permanent validation errors as failed', async () => {
    const settleExecutionFee = jest.fn(async () => {
      throw new Error('invalid recipient');
    });

    const { paymentRetryService } = loadHarness({
      queryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          return { rows: [] };
        }
        if (normalized.includes('from agents where id = $1')) {
          return { rows: [{ id: 'agent-1', private_key_encrypted: 'enc' }] };
        }
        if (normalized.includes('set attempt_count = attempt_count + 1')) {
          return { rows: [{ ...BASE_INTENT_ROW, attempt_count: 1 }] };
        }
        if (normalized.includes("update agentic_payment_retry_intents")
          && normalized.includes("set payload = coalesce(payload, '{}'::jsonb) || $3::jsonb")
          && normalized.includes("and status = 'processing'")) {
          return {
            rows: [{
              ...BASE_INTENT_ROW,
              attempt_count: 1,
              payload: {
                ...BASE_INTENT_ROW.payload,
                submissionPhase: 'submission_started',
              },
            }],
          };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'failed'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'failed' }] };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 101 }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('invalid_recipient');
  });

  test('releaseIntentAfterEnqueueFailure atomically unlocks processing intent and returns deferred', async () => {
    const { paymentRetryService, query } = loadHarness({
      queryImpl: async (sql, params = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes("update agentic_payment_retry_intents")
          && normalized.includes("set status = 'deferred'")
          && normalized.includes('next_attempt_at = $3::timestamptz')
          && normalized.includes("payload = coalesce(payload, '{}'::jsonb) || $6::jsonb")
          && normalized.includes("and ($2::text is null or locked_by = $2)")) {
          expect(params[3]).toBe('QUEUE_ENQUEUE_FAILED');
          expect(params[4]).toBe('queue add failed');
          return {
            rows: [{
              ...BASE_INTENT_ROW,
              status: 'deferred',
              locked_at: null,
              locked_by: null,
              last_error_code: 'QUEUE_ENQUEUE_FAILED',
              last_error: 'queue add failed',
              next_attempt_at: '2026-07-17T01:00:00.000Z',
            }],
          };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 501 }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const row = await paymentRetryService.releaseIntentAfterEnqueueFailure('intent-1', {
      lockOwner: 'payment-retry-worker:intent-1',
      attemptCount: 0,
      lastError: 'queue add failed',
      nextAttemptAt: '2026-07-17T01:00:00.000Z',
      silent: true,
    });

    expect(row).toMatchObject({
      id: 'intent-1',
      status: 'deferred',
      locked_at: null,
      locked_by: null,
      last_error_code: 'QUEUE_ENQUEUE_FAILED',
      next_attempt_at: '2026-07-17T01:00:00.000Z',
      attempt_count: 0,
    });

    const attemptIncrementQueries = query.mock.calls.filter(([sql]) => String(sql).includes('attempt_count = attempt_count + 1'));
    expect(attemptIncrementQueries).toHaveLength(0);
  });

  test('confirmed dedupe does not match legacy record when recipient differs', async () => {
    const settleExecutionFee = jest.fn();
    const legacyEvent = {
      payloadIdempotencyKey: null,
      agentId: 'agent-1',
      rail: 'agentic_automation_economy',
      referenceType: 'automation',
      referenceId: 'ref-1',
      recipient: '0x9999999999999999999999999999999999999999',
      sourceChain: 'Arc Testnet',
      destinationChain: 'Arc Testnet',
      token: 'USDC',
      feeUsdc: '0.100000',
    };

    const { paymentRetryService } = loadHarness({
      healthyRpcUrl: null,
      queryImpl: async (sql, params = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          const legacyMatch = Boolean(
            params[2] === true
            && legacyEvent.agentId === params[3]
            && legacyEvent.rail === params[4]
            && legacyEvent.referenceType === params[5]
            && legacyEvent.referenceId === params[6]
            && legacyEvent.recipient === params[7]
            && legacyEvent.sourceChain === params[8]
            && legacyEvent.destinationChain === params[9]
            && legacyEvent.token === params[10]
            && legacyEvent.feeUsdc === params[11]
          );
          return { rows: legacyMatch ? [{ id: 7001 }] : [] };
        }
        if (normalized.includes("update agentic_payment_retry_intents") && normalized.includes("set status = 'deferred'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'deferred', next_attempt_at: '2026-07-17T01:00:00.000Z' }] };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 7002 }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee,
      jitterFn: (delay) => delay,
    });

    expect(result.status).toBe('deferred');
    expect(result.reconciled).not.toBe(true);
    expect(settleExecutionFee).not.toHaveBeenCalled();
  });

  test('confirmed dedupe does not match legacy record when chain differs', async () => {
    const settleExecutionFee = jest.fn();
    const legacyEvent = {
      payloadIdempotencyKey: null,
      agentId: 'agent-1',
      rail: 'agentic_automation_economy',
      referenceType: 'automation',
      referenceId: 'ref-1',
      recipient: '0x1111111111111111111111111111111111111111',
      sourceChain: 'Base Sepolia',
      destinationChain: 'Arc Testnet',
      token: 'USDC',
      feeUsdc: '0.100000',
    };

    const { paymentRetryService } = loadHarness({
      healthyRpcUrl: null,
      queryImpl: async (sql, params = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          const legacyMatch = Boolean(
            params[2] === true
            && legacyEvent.agentId === params[3]
            && legacyEvent.rail === params[4]
            && legacyEvent.referenceType === params[5]
            && legacyEvent.referenceId === params[6]
            && legacyEvent.recipient === params[7]
            && legacyEvent.sourceChain === params[8]
            && legacyEvent.destinationChain === params[9]
            && legacyEvent.token === params[10]
            && legacyEvent.feeUsdc === params[11]
          );
          return { rows: legacyMatch ? [{ id: 7101 }] : [] };
        }
        if (normalized.includes("update agentic_payment_retry_intents") && normalized.includes("set status = 'deferred'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'deferred', next_attempt_at: '2026-07-17T01:00:00.000Z' }] };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 7102 }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee,
      jitterFn: (delay) => delay,
    });

    expect(result.status).toBe('deferred');
    expect(result.reconciled).not.toBe(true);
    expect(settleExecutionFee).not.toHaveBeenCalled();
  });

  test('confirmed dedupe matches exact strict legacy identity', async () => {
    const { paymentRetryService } = loadHarness({
      queryImpl: async (sql, params = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          const strictLegacyIdentityMatches = Boolean(
            params[2] === true
            && params[3] === 'agent-1'
            && params[4] === 'agentic_automation_economy'
            && params[5] === 'automation'
            && params[6] === 'ref-1'
            && params[7] === '0x1111111111111111111111111111111111111111'
            && params[8] === 'Arc Testnet'
            && params[9] === 'Arc Testnet'
            && params[10] === 'USDC'
            && params[11] === '0.100000'
          );
          return { rows: strictLegacyIdentityMatches ? [{ id: 7201 }] : [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee: jest.fn(),
    });

    expect(result.status).toBe('confirmed');
    expect(result.reconciled).toBe(true);
  });

  test('confirmed dedupe matches exact deterministic idempotency key first', async () => {
    const { paymentRetryService } = loadHarness({
      queryImpl: async (sql, params = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW }] };
        }
        if (normalized.includes("from agentic_payment_events") && normalized.includes("status = 'confirmed'")) {
          return { rows: params[1] === 'idem-1' ? [{ id: 7301 }] : [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee: jest.fn(),
    });

    expect(result.status).toBe('confirmed');
    expect(result.reconciled).toBe(true);
  });

  test('releaseExpiredLocks reopens preflight locks and sends submission-started rows to manual_review', async () => {
    const { paymentRetryService } = loadHarness({
      queryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes("from agentic_payment_retry_intents") && normalized.includes("status = 'processing'")) {
          return {
            rows: [
              {
                ...BASE_INTENT_ROW,
                id: 'intent-preflight',
                payload: { submissionPhase: 'preflight' },
                gateway_deposit_tx_hash: null,
                gateway_approval_tx_hash: null,
                gateway_mint_tx_hash: null,
              },
              {
                ...BASE_INTENT_ROW,
                id: 'intent-started-nohash',
                payload: { submissionPhase: 'submission_started' },
                gateway_deposit_tx_hash: null,
                gateway_approval_tx_hash: null,
                gateway_mint_tx_hash: null,
              },
              {
                ...BASE_INTENT_ROW,
                id: 'intent-started-hash',
                payload: { submissionPhase: 'submission_started' },
                gateway_deposit_tx_hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
              },
            ],
          };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'manual_review'")) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'manual_review' }] };
        }
        if (normalized.includes('insert into agentic_payment_events')) {
          return { rows: [{ id: 88 }] };
        }
        if (normalized.includes('update agentic_payment_retry_intents') && normalized.includes("set status = 'deferred'")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const summary = await paymentRetryService.releaseExpiredLocks({ lockTimeoutMs: 900000, limit: 10 });

    expect(summary.scanned).toBe(3);
    expect(summary.reopened).toBe(1);
    expect(summary.manualReview).toBe(2);
  });

  test('processRetryIntent skips terminal confirmed intents and never retries them', async () => {
    const settleExecutionFee = jest.fn();
    const { paymentRetryService } = loadHarness({
      queryImpl: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
        if (normalized.includes('from agentic_payment_retry_intents') && normalized.includes('where id = $1')) {
          return { rows: [{ ...BASE_INTENT_ROW, status: 'confirmed' }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });

    const result = await paymentRetryService.processRetryIntent({
      intentId: 'intent-1',
      lockOwner: 'payment-retry-worker:intent-1',
      settleExecutionFee,
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('intent_terminal');
    expect(settleExecutionFee).not.toHaveBeenCalled();
  });
});
