'use strict';

process.env.QUEUE_WORKERS_ENABLED = 'false';
process.env.DISCOVERY_REQUIRES_EXECUTION_CAP_HEADROOM = 'false';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);

jest.mock('bull', () => {
  return jest.fn().mockImplementation(() => {
    const queue = {
      handlers: {},
      client: {
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1),
      },
      process: jest.fn((name, _concurrency, handler) => {
        queue.handlers[name] = handler;
      }),
      add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
      getJob: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
      getJobs: jest.fn().mockResolvedValue([]),
      pause: jest.fn().mockResolvedValue(),
      resume: jest.fn().mockResolvedValue(),
      isReady: jest.fn().mockResolvedValue(true),
      on: jest.fn(),
      toKey: jest.fn((key) => `bull:agent-jobs:${key}`),
    };
    return queue;
  });
});

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue(),
})));

jest.mock('../../services/agentWalletService', () => ({
  getSwapQuoteResult: jest.fn(),
  agentSwap: jest.fn(),
}));

const queueModule = require('../agentQueue');

describe('agentQueue multi-lane safety helpers', () => {
  const testOnly = queueModule.__testOnly;

  test('does not count deterministic pre-broadcast swap_error as meaningful execution attempt', () => {
    const shouldCount = testOnly.shouldCountAsMeaningfulExecutionAttempt({
      txResult: null,
      executionResult: {
        ok: false,
        reason: 'swap_error',
        error: 'The Circle route is currently unavailable for this cirBTC pair. Direct Arc fallback is disabled.',
      },
    });

    expect(shouldCount).toBe(false);
  });

  test('counts once when a tx hash exists at submission boundary', () => {
    const shouldCount = testOnly.shouldCountAsMeaningfulExecutionAttempt({
      txResult: {
        txHash: '0xabc1230000000000000000000000000000000000000000000000000000000000',
      },
      executionResult: {
        ok: true,
      },
    });

    expect(shouldCount).toBe(true);
  });

  test('builds distinct deterministic failure context for different amount or error', () => {
    const first = testOnly.buildDeterministicLaneFailureContext({
      agentId: 'agent-1',
      transactionType: 'direct_lp_add',
      executionSource: 'cirbtc_lp_policy_v1',
      policyLane: 'cirbtc_direct_pair_lp',
      operationType: 'add_liquidity',
      actionParams: { amountIn: '10', stableToken: 'EURC', poolKey: 'EURC-CIRBTC' },
      automationPolicy: { metrics: { selectedPoolKey: 'EURC-CIRBTC' } },
      executionPayload: {},
      defaultFromToken: 'EURC',
      defaultToToken: 'cirBTC',
      requestedExecutionAmount: 10,
      reason: 'swap_error',
      error: 'The Circle route is currently unavailable for this cirBTC pair. Direct Arc fallback is disabled.',
      routeMode: 'primary_only',
      recommendationFingerprint: 'rfp-1',
    });

    const second = testOnly.buildDeterministicLaneFailureContext({
      agentId: 'agent-1',
      transactionType: 'direct_lp_add',
      executionSource: 'cirbtc_lp_policy_v1',
      policyLane: 'cirbtc_direct_pair_lp',
      operationType: 'add_liquidity',
      actionParams: { amountIn: '11', stableToken: 'EURC', poolKey: 'EURC-CIRBTC' },
      automationPolicy: { metrics: { selectedPoolKey: 'EURC-CIRBTC' } },
      executionPayload: {},
      defaultFromToken: 'EURC',
      defaultToToken: 'cirBTC',
      requestedExecutionAmount: 11,
      reason: 'swap_error',
      error: 'The Circle route is currently unavailable for this cirBTC pair. Direct Arc fallback is disabled.',
      routeMode: 'primary_only',
      recommendationFingerprint: 'rfp-1',
    });

    const third = testOnly.buildDeterministicLaneFailureContext({
      agentId: 'agent-1',
      transactionType: 'direct_lp_add',
      executionSource: 'cirbtc_lp_policy_v1',
      policyLane: 'cirbtc_direct_pair_lp',
      operationType: 'add_liquidity',
      actionParams: { amountIn: '10', stableToken: 'EURC', poolKey: 'EURC-CIRBTC' },
      automationPolicy: { metrics: { selectedPoolKey: 'EURC-CIRBTC' } },
      executionPayload: {},
      defaultFromToken: 'EURC',
      defaultToToken: 'cirBTC',
      requestedExecutionAmount: 10,
      reason: 'direct_pair_seed_required',
      error: 'pair reserves are inconsistent',
      routeMode: 'primary_only',
      recommendationFingerprint: 'rfp-1',
    });

    expect(first.scopeKey).not.toBe(second.scopeKey);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe(third.fingerprint);
  });

  test('discovery gate stays open when execution cap headroom is not required', () => {
    const shouldSuspend = testOnly.shouldSuspendMarketAndOracleDiscoveryWhenDefiCapReached({
      daily_defi_loop_count: 999,
      defi_daily_reset_at: new Date().toISOString(),
      daily_limit_reset_at: new Date().toISOString(),
    });

    expect(shouldSuspend).toBe(false);
  });
});
