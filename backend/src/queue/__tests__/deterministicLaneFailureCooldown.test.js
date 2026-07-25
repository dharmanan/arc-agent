'use strict';

const {
  buildDeterministicLaneFailureScopeKey,
  buildDeterministicLaneFailureFingerprint,
  buildDeterministicLaneFailureMeta,
  registerDeterministicLaneFailureCooldownHit,
  findActiveDeterministicLaneFailureByScope,
} = require('../deterministicLaneFailureCooldown');

describe('deterministicLaneFailureCooldown', () => {
  test('creates distinct scope keys for different amount/pair/error dimensions', () => {
    const baseScope = buildDeterministicLaneFailureScopeKey({
      policyLane: 'cirbtc_direct_pair_lp',
      executionSource: 'cirbtc_lp_policy_v1',
      pairOrPool: 'EURC-CIRBTC',
      tokenIn: 'EURC',
      tokenOut: 'CIRBTC',
      requestedAmount: 10,
      routeMode: 'primary_only',
      recommendationFingerprint: 'r1',
    });

    const differentAmount = buildDeterministicLaneFailureScopeKey({
      policyLane: 'cirbtc_direct_pair_lp',
      executionSource: 'cirbtc_lp_policy_v1',
      pairOrPool: 'EURC-CIRBTC',
      tokenIn: 'EURC',
      tokenOut: 'CIRBTC',
      requestedAmount: 11,
      routeMode: 'primary_only',
      recommendationFingerprint: 'r1',
    });

    const differentPair = buildDeterministicLaneFailureScopeKey({
      policyLane: 'cirbtc_direct_pair_lp',
      executionSource: 'cirbtc_lp_policy_v1',
      pairOrPool: 'USDC-CIRBTC',
      tokenIn: 'USDC',
      tokenOut: 'CIRBTC',
      requestedAmount: 10,
      routeMode: 'primary_only',
      recommendationFingerprint: 'r1',
    });

    const baseFingerprint = buildDeterministicLaneFailureFingerprint({
      agentId: 'agent-a',
      scopeKey: baseScope,
      errorCode: 'CIRBTC_ROUTE_UNAVAILABLE',
    });
    const differentErrorFingerprint = buildDeterministicLaneFailureFingerprint({
      agentId: 'agent-a',
      scopeKey: baseScope,
      errorCode: 'DIRECT_PAIR_SEED_REQUIRED',
    });

    expect(baseScope).not.toBe(differentAmount);
    expect(baseScope).not.toBe(differentPair);
    expect(baseFingerprint).not.toBe(differentErrorFingerprint);
  });

  test('updates repeat counters when same deterministic failure is under cooldown', async () => {
    const now = Date.now();
    const scopeKey = buildDeterministicLaneFailureScopeKey({
      policyLane: 'cirbtc_direct_pair_lp',
      executionSource: 'cirbtc_lp_policy_v1',
      pairOrPool: 'EURC-CIRBTC',
      tokenIn: 'EURC',
      tokenOut: 'CIRBTC',
      requestedAmount: 10,
      routeMode: 'primary_only',
      recommendationFingerprint: 'r1',
    });
    const fingerprint = buildDeterministicLaneFailureFingerprint({
      agentId: 'agent-1',
      scopeKey,
      errorCode: 'CIRBTC_ROUTE_UNAVAILABLE',
    });

    const existingMeta = buildDeterministicLaneFailureMeta({
      laneFailureFingerprint: fingerprint,
      laneFailureScopeKey: scopeKey,
      firstSeenAt: new Date(now - 120_000).toISOString(),
      lastSeenAt: new Date(now - 60_000).toISOString(),
      repeatCount: 1,
    }, {
      fingerprint,
      scopeKey,
      errorCode: 'CIRBTC_ROUTE_UNAVAILABLE',
      cooldownMs: 45 * 60 * 1000,
      nowIso: new Date(now - 60_000).toISOString(),
      repeatCount: 1,
    });

    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 77,
              created_at: new Date(now - 120_000).toISOString(),
              meta: existingMeta,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await registerDeterministicLaneFailureCooldownHit(db, {
      agentId: 'agent-1',
      transactionType: 'direct_lp_add',
      fingerprint,
      scopeKey,
      errorCode: 'CIRBTC_ROUTE_UNAVAILABLE',
      cooldownMs: 45 * 60 * 1000,
      nowMs: now,
    });

    expect(result).toMatchObject({
      active: true,
      rowId: 77,
      repeatCount: 2,
    });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('finds active cooldown by lane scope key', async () => {
    const now = Date.now();
    const scopeKey = buildDeterministicLaneFailureScopeKey({
      policyLane: 'cirbtc_direct_pair_lp',
      executionSource: 'cirbtc_lp_policy_v1',
      pairOrPool: 'EURC-CIRBTC',
      tokenIn: 'EURC',
      tokenOut: 'CIRBTC',
      requestedAmount: 10,
      routeMode: 'primary_only',
      recommendationFingerprint: 'r1',
    });
    const fingerprint = buildDeterministicLaneFailureFingerprint({
      agentId: 'agent-1',
      scopeKey,
      errorCode: 'CIRBTC_ROUTE_UNAVAILABLE',
    });

    const rowMeta = buildDeterministicLaneFailureMeta({
      laneFailureFingerprint: fingerprint,
      laneFailureScopeKey: scopeKey,
      firstSeenAt: new Date(now - 120_000).toISOString(),
      lastSeenAt: new Date(now - 60_000).toISOString(),
      repeatCount: 3,
    }, {
      fingerprint,
      scopeKey,
      errorCode: 'CIRBTC_ROUTE_UNAVAILABLE',
      cooldownMs: 45 * 60 * 1000,
      nowIso: new Date(now - 60_000).toISOString(),
      repeatCount: 3,
    });

    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 88,
            created_at: new Date(now - 120_000).toISOString(),
            meta: rowMeta,
          },
        ],
      }),
    };

    const state = await findActiveDeterministicLaneFailureByScope(db, {
      agentId: 'agent-1',
      transactionType: 'direct_lp_add',
      scopeKey,
      cooldownMs: 45 * 60 * 1000,
      nowMs: now,
    });

    expect(state.active).toBe(true);
    expect(state.rowId).toBe(88);
    expect(state.fingerprint).toBe(fingerprint);
    expect(state.retryAfterMs).toBeGreaterThan(0);
  });
});
