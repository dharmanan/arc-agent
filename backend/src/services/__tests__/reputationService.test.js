'use strict';

describe('reputation overview regression coverage', () => {
  jest.setTimeout(10000);

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.REPUTATION_REGISTRY_ADDRESS = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
    process.env.REPUTATION_OVERVIEW_ONCHAIN_READ_TIMEOUT_MS = '800';
  });

  function setupService({
    agentRow,
    summaryRow = { local_score: 0, total_events: 0 },
    breakdownRows = [],
    recentRows = [],
    snapshotPayload = null,
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
    const sendProtectedContractTx = jest.fn();
    jest.doMock('../txSecurityService', () => ({
      sendProtectedContractTx,
    }));
    const loadAgentReadSnapshot = jest.fn(async () => (snapshotPayload
      ? { payload: snapshotPayload, updated_at: snapshotPayload.checkedAt || null }
      : null));
    const saveAgentReadSnapshot = jest.fn(async () => true);
    jest.doMock('../agentReadSnapshotService', () => ({
      SNAPSHOT_KINDS: {
        REPUTATION: 'reputation',
      },
      loadAgentReadSnapshot,
      saveAgentReadSnapshot,
    }));
    const safeArcRpcCall = jest.fn(safeArcRpcCallImpl || (async (_label, fn) => fn({}, 'https://rpc.testnet.arc.network')));
    jest.doMock('../arcProvider', () => ({
      safeArcRpcCall,
      isArcRpcRateLimitError: jest.fn(() => false),
    }));

    let reputationService;
    jest.isolateModules(() => {
      reputationService = require('../reputationService');
    });

    return {
      reputationService,
      query,
      loadAgentReadSnapshot,
      saveAgentReadSnapshot,
      safeArcRpcCall,
      sendProtectedContractTx,
    };
  }

  test('maps DB reputation_enabled=true to reputationEnabled=true', async () => {
    const { reputationService } = setupService({
      agentRow: {
        id: 'agent-1',
        name: 'Alpha',
        reputation_enabled: true,
        erc8004_status: 'registered',
        erc8004_token_id: null,
      },
      summaryRow: { local_score: 5, total_events: 2 },
    });

    const overview = await reputationService.getReputationOverview('agent-1', 'user-1', 10);

    expect(overview).toBeTruthy();
    expect(overview.reputationEnabled).toBe(true);
    expect(overview.localScore).toBe(5);
    expect(overview.totalEvents).toBe(2);
  });

  test('returns live mode when reputation read responds in 842ms', async () => {
    const { reputationService, saveAgentReadSnapshot } = setupService({
      agentRow: {
        id: 'agent-2',
        name: 'Beta',
        reputation_enabled: true,
        erc8004_status: 'registered',
        erc8004_token_id: '42',
      },
      summaryRow: { local_score: 19, total_events: 4 },
      safeArcRpcCallImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 842));
        return 77n;
      },
    });

    const overview = await reputationService.getReputationOverview('agent-2', 'user-2', 10);

    expect(overview.mode).toBe('hybrid');
    expect(overview.onchain.status).toBe('live');
    expect(overview.onchain.score).toBe(77);
    expect(saveAgentReadSnapshot).toHaveBeenCalledWith(
      'agent-2',
      'reputation',
      expect.objectContaining({
        score: 77,
        tokenId: '42',
        contractAddress: process.env.REPUTATION_REGISTRY_ADDRESS,
        source: 'live_rpc',
      }),
    );
  });

  test('returns cached confirmed score when live reputation read times out', async () => {
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
      snapshotPayload: {
        score: 33,
        tokenId: '77',
        contractAddress: process.env.REPUTATION_REGISTRY_ADDRESS,
        checkedAt: '2026-07-19T10:20:00.000Z',
        source: 'live_rpc',
      },
      safeArcRpcCallImpl: () => new Promise(() => {}),
    });

    const overview = await reputationService.getReputationOverview('agent-3', 'user-3', 10);

    expect(overview.mode).toBe('hybrid_cached');
    expect(overview.onchain.status).toBe('cached');
    expect(overview.onchain.score).toBe(33);
    expect(overview.onchain.stale).toBe(true);
    expect(overview.onchain.cachedAt).toBe('2026-07-19T10:20:00.000Z');
  });

  test('keeps read_error and local_only mode when timed out read has no snapshot', async () => {
    const { reputationService } = setupService({
      agentRow: {
        id: 'agent-4',
        name: 'Delta',
        reputation_enabled: true,
        erc8004_status: 'registered',
        erc8004_token_id: '88',
      },
      summaryRow: { local_score: 4, total_events: 1 },
      safeArcRpcCallImpl: () => new Promise(() => {}),
    });

    const overview = await reputationService.getReputationOverview('agent-4', 'user-4', 10);

    expect(overview.mode).toBe('local_only');
    expect(overview.onchain.status).toBe('read_error');
    expect(overview.onchain.score).toBe(null);
  });

  test('treats cached score as display-only and never triggers financial execution path', async () => {
    const { reputationService, sendProtectedContractTx } = setupService({
      agentRow: {
        id: 'agent-5',
        name: 'Epsilon',
        reputation_enabled: true,
        erc8004_status: 'registered',
        erc8004_token_id: '99',
      },
      summaryRow: { local_score: 8, total_events: 2 },
      snapshotPayload: {
        score: 55,
        tokenId: '99',
        contractAddress: process.env.REPUTATION_REGISTRY_ADDRESS,
        checkedAt: '2026-07-19T11:00:00.000Z',
        source: 'live_rpc',
      },
      safeArcRpcCallImpl: () => new Promise(() => {}),
    });

    const overview = await reputationService.getReputationOverview('agent-5', 'user-5', 10);

    expect(overview.onchain.status).toBe('cached');
    expect(overview.onchain.score).toBe(55);
    expect(sendProtectedContractTx).not.toHaveBeenCalled();
  });
});
