'use strict';

describe('reputation overview regression coverage', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.REPUTATION_REGISTRY_ADDRESS = '';
    process.env.REPUTATION_OVERVIEW_ONCHAIN_READ_TIMEOUT_MS = '15';
  });

  function setupService({
    agentRow,
    summaryRow,
    breakdownRows,
    recentRows,
    safeArcRpcCallImpl,
  }) {
    const query = jest.fn(async (sql) => {
      if (sql.includes('FROM agents') && sql.includes('reputation_enabled')) {
        return { rows: [agentRow] };
      }

      if (sql.includes('COALESCE(SUM(score_delta), 0)::int AS local_score')) {
        return { rows: [summaryRow] };
      }

      if (sql.includes('GROUP BY event_type')) {
        return { rows: breakdownRows };
      }

      if (sql.includes('ORDER BY created_at DESC')) {
        return { rows: recentRows };
      }

      throw new Error(`Unexpected query in test: ${sql}`);
    });

    jest.doMock('../../db', () => ({ query }));
    jest.doMock('../txSecurityService', () => ({
      sendProtectedContractTx: jest.fn(),
    }));
    jest.doMock('../agentReadSnapshotService', () => ({
      getUserReadTimeoutMs: () => 15,
    }));
    jest.doMock('../arcProvider', () => ({
      safeArcRpcCall: jest.fn(safeArcRpcCallImpl || (async (_label, fn, fallback) => {
        if (typeof fn === 'function') return fn({});
        return fallback;
      })),
      getArcRpcUrl: jest.fn(() => 'https://rpc.testnet.arc.network'),
      createArcRpcProvider: jest.fn(() => ({})),
      isArcRpcRateLimitError: jest.fn(() => false),
    }));

    let reputationService;
    jest.isolateModules(() => {
      reputationService = require('../reputationService');
    });

    return { reputationService, query };
  }

  test('maps DB reputation_enabled=true to reputationEnabled=true', async () => {
    const { reputationService } = setupService({
      agentRow: {
        id: 'agent-1',
        name: 'Alpha',
        reputation_enabled: true,
        erc8004_status: 'skipped',
        erc8004_token_id: null,
      },
      summaryRow: { local_score: 5, total_events: 2 },
      breakdownRows: [],
      recentRows: [],
    });

    const overview = await reputationService.getReputationOverview('agent-1', 'user-1', 10);

    expect(overview).toBeTruthy();
    expect(overview.reputationEnabled).toBe(true);
    expect(overview.localScore).toBe(5);
    expect(overview.totalEvents).toBe(2);
  });

  test('keeps local score and recent events from DB when events exist', async () => {
    const { reputationService } = setupService({
      agentRow: {
        id: 'agent-2',
        name: 'Beta',
        reputation_enabled: true,
        erc8004_status: 'registered',
        erc8004_token_id: '42',
      },
      summaryRow: { local_score: 19, total_events: 4 },
      breakdownRows: [
        { event_type: 'ARB_EXECUTED', event_count: 2, score_total: 4 },
        { event_type: 'DAILY_TASK_COMPLETED', event_count: 2, score_total: 2 },
      ],
      recentRows: [
        { event_type: 'ARB_EXECUTED', score_delta: 2, created_at: '2026-06-28T10:00:00.000Z' },
        { event_type: 'DAILY_TASK_COMPLETED', score_delta: 1, created_at: '2026-06-28T09:00:00.000Z' },
      ],
    });

    const overview = await reputationService.getReputationOverview('agent-2', 'user-2', 10);

    expect(overview.reputationEnabled).toBe(true);
    expect(overview.localScore).toBe(19);
    expect(overview.totalEvents).toBe(4);
    expect(Array.isArray(overview.recentEvents)).toBe(true);
    expect(overview.recentEvents.length).toBe(2);
    expect(overview.recentEvents[0].eventType).toBe('ARB_EXECUTED');
  });

  test('preserves DB-backed local reputation when Arc RPC is unavailable', async () => {
    process.env.REPUTATION_REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
    process.env.REPUTATION_OVERVIEW_ONCHAIN_READ_TIMEOUT_MS = '10';

    const { reputationService } = setupService({
      agentRow: {
        id: 'agent-3',
        name: 'Gamma',
        reputation_enabled: true,
        erc8004_status: 'registered',
        erc8004_token_id: '77',
      },
      summaryRow: { local_score: 11, total_events: 3 },
      breakdownRows: [
        { event_type: 'TRANSACTION_COMPLETED', event_count: 3, score_total: 3 },
      ],
      recentRows: [
        { event_type: 'TRANSACTION_COMPLETED', score_delta: 1, created_at: '2026-06-28T08:00:00.000Z' },
      ],
      safeArcRpcCallImpl: () => new Promise(() => {}),
    });

    const overview = await reputationService.getReputationOverview('agent-3', 'user-3', 10);

    expect(overview.reputationEnabled).toBe(true);
    expect(overview.localScore).toBe(11);
    expect(overview.totalEvents).toBe(3);
    expect(overview.recentEvents.length).toBe(1);
    expect(overview.onchain.status).toBe('read_error');
  });
});
