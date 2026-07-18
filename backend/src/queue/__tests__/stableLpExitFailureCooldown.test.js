'use strict';

const {
  buildStableLpExitFailureFingerprint,
  buildFailureMeta,
  registerStableLpExitFailureCooldownHit,
  findActiveStableLpExitFailureCooldownForAgent,
} = require('../stableLpExitFailureCooldown');

describe('stableLpExitFailureCooldown', () => {
  test('treats different live balance or calldata fingerprint as distinct failures', () => {
    const base = {
      agentId: 'agent-1',
      operationType: 'remove_liquidity',
      poolAddress: '0x2D84D79C852f6842AbE0304b70bBaA1506AdD457',
      liveLpBalance: '10.1',
      tokenOut: 'USDC',
      errorCode: 'TX_SIMULATION_FAILED',
      simulationFingerprint: '0xaaa',
    };

    const first = buildStableLpExitFailureFingerprint(base);
    const differentBalance = buildStableLpExitFailureFingerprint({
      ...base,
      liveLpBalance: '10.2',
    });
    const differentCalldata = buildStableLpExitFailureFingerprint({
      ...base,
      simulationFingerprint: '0xbbb',
    });

    expect(first).not.toEqual(differentBalance);
    expect(first).not.toEqual(differentCalldata);
  });

  test('marks cooldown active and updates repeat counters instead of creating a new row', async () => {
    const existingMeta = buildFailureMeta({
      errorCode: 'TX_SIMULATION_FAILED',
      stableLpExitFailureFingerprint: 'fp-1',
      firstSeenAt: new Date(Date.now() - 60_000).toISOString(),
      lastSeenAt: new Date(Date.now() - 30_000).toISOString(),
      repeatCount: 1,
    }, {
      fingerprint: 'fp-1',
      cooldownMs: 21_600_000,
      nowIso: new Date(Date.now() - 30_000).toISOString(),
      repeatCount: 1,
    });

    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 99,
              created_at: new Date(Date.now() - 60_000).toISOString(),
              meta: existingMeta,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const result = await registerStableLpExitFailureCooldownHit(db, {
      agentId: 'agent-1',
      fingerprint: 'fp-1',
      cooldownMs: 21_600_000,
    });

    expect(result).toMatchObject({
      active: true,
      rowId: 99,
      repeatCount: 2,
    });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][0]).toContain('UPDATE transactions');
    expect(db.query.mock.calls[1][1][0]).toBe(99);
    const nextMeta = JSON.parse(db.query.mock.calls[1][1][1]);
    expect(nextMeta.repeatCount).toBe(2);
    expect(nextMeta.firstSeenAt).toBe(existingMeta.firstSeenAt);
    expect(nextMeta.lastSeenAt).toBeTruthy();
  });

  test('returns no active cooldown when fingerprint row is missing', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await registerStableLpExitFailureCooldownHit(db, {
      agentId: 'agent-1',
      fingerprint: 'missing',
      cooldownMs: 21_600_000,
    });

    expect(result).toEqual({
      active: false,
      retryAfterMs: 0,
      rowId: null,
      repeatCount: 0,
    });
  });

  test('finds active cooldown for market-analysis enqueue guard', async () => {
    const now = Date.now();
    const activeMeta = buildFailureMeta({
      errorCode: 'TX_SIMULATION_FAILED',
      stableLpExitFailureFingerprint: 'fp-active',
      firstSeenAt: new Date(now - 120_000).toISOString(),
      lastSeenAt: new Date(now - 60_000).toISOString(),
      repeatCount: 3,
    }, {
      fingerprint: 'fp-active',
      cooldownMs: 21_600_000,
      nowIso: new Date(now - 60_000).toISOString(),
      repeatCount: 3,
    });

    const db = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 111,
            created_at: new Date(now - 120_000).toISOString(),
            meta: activeMeta,
          },
        ],
      }),
    };

    const result = await findActiveStableLpExitFailureCooldownForAgent(db, {
      agentId: 'agent-1',
      cooldownMs: 21_600_000,
      nowMs: now,
    });

    expect(result.active).toBe(true);
    expect(result.fingerprint).toBe('fp-active');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });
});
