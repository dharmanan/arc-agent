'use strict';

const http = require('http');

const TEST_USER_ID = 'user-123';
const TEST_AGENT_ID = 'agent-123';
const TEST_OWNER_ADDRESS = '0x00000000000000000000000000000000000000AA';
const TEST_JWT_SECRET = 'test-secret-1234567890-test-secret';

function buildTestApp(router) {
  const express = require('express');
  const app = express();

  app.use(express.json());
  app.use('/api/tasks', router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

async function createServer(app) {
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  return {
    async post(path, body, token) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      return {
        status: response.status,
        body: await response.json(),
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function loadTasksHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const db = { query: jest.fn() };
  const queue = { queueManualTask: jest.fn().mockResolvedValue(undefined) };
  const taskRunService = {
    findActiveTaskRun: jest.fn().mockResolvedValue(null),
    createTaskRun: jest.fn().mockResolvedValue({ id: 'run-1' }),
    failTaskRun: jest.fn().mockResolvedValue(undefined),
  };
  const oracle = {
    resolveCurvePool: jest.fn().mockReturnValue({
      address: '0x2D84D79C852f6842AbE0304b70bBaA1506AdD457',
      source: 'verified_default',
      baseToken: { symbol: 'EURC', decimals: 6, index: 1 },
      quoteToken: { symbol: 'USDC', decimals: 6, index: 0 },
    }),
  };
  const protocols = {
    getCurveQuote: jest.fn().mockResolvedValue({ amountOut: '9.9987', amountOutRaw: 9998700n }),
  };

  jest.doMock('../../db', () => db);
  jest.doMock('../../queue/agentQueue', () => queue);
  jest.doMock('../../services/taskRunService', () => taskRunService);
  jest.doMock('../../services/dailyLimitBypass', () => ({ isDailyLimitBypassed: jest.fn().mockReturnValue(false) }));
  jest.doMock('../../services/agentService', () => ({ getAgentWithKey: jest.fn() }));
  jest.doMock('../../services/nativeLendingRiskService', () => ({}));
  jest.doMock('../../services/circlePaidCatalogService', () => ({
    buildCirclePaidHandoff: jest.fn(() => null),
    getCirclePaidCatalog: jest.fn(() => ({ items: [], economy: {} })),
    getCirclePaidItemById: jest.fn(() => null),
  }));
  jest.doMock('../../services/predictionMarketService', () => ({
    getEventOddsCompare: jest.fn(),
    getPredictionMarketPulse: jest.fn(),
  }));
  jest.doMock('../../services/circlePaidSnapshotService', () => ({
    buildCirclePaidPricingSnapshot: jest.fn(),
    buildPredictionMarketPreviewPayload: jest.fn(),
    createCirclePaidPreviewSnapshot: jest.fn(),
    getCirclePaidSnapshotForAgent: jest.fn(),
    listCirclePaidSnapshots: jest.fn(),
    unlockCirclePaidSnapshot: jest.fn(),
  }));
  jest.doMock('../../services/walletSnapshotService', () => ({ getWalletAssetSnapshot: jest.fn() }));
  jest.doMock('../../services/oracle', () => oracle);
  jest.doMock('../../services/protocols', () => protocols);

  let router;
  let signToken;
  jest.isolateModules(() => {
    router = require('../tasks');
    ({ signToken } = require('../../middleware/auth'));
  });

  return {
    app: buildTestApp(router),
    db,
    oracle,
    protocols,
    signToken,
  };
}

describe('manual DeFi quote route', () => {
  test('returns an exact Curve preview for EURC to USDC', async () => {
    const { app, db, oracle, protocols, signToken } = loadTasksHarness();
    const server = await createServer(app);
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query.mockResolvedValue({ rows: [{ id: TEST_AGENT_ID }] });

    try {
      const response = await server.post(
        `/api/tasks/agents/${TEST_AGENT_ID}/defi/manual/quote`,
        {
          poolKey: 'USDC-EURC',
          venue: 'curve',
          action: 'swap',
          params: {
            fromToken: 'EURC',
            toToken: 'USDC',
            amountIn: 10,
          },
        },
        token,
      );

      expect(response.status).toBe(200);
      expect(response.body.amountOut).toBe('9.9987');
      expect(response.body.fromToken).toBe('EURC');
      expect(response.body.toToken).toBe('USDC');
      expect(response.body.executionRail).toBe('curve_pool_quote');
      expect(oracle.resolveCurvePool).toHaveBeenCalledWith('USDC-EURC');
      expect(protocols.getCurveQuote).toHaveBeenCalledWith(
        '0x2D84D79C852f6842AbE0304b70bBaA1506AdD457',
        1,
        0,
        '10',
        6,
        6,
      );
    } finally {
      await server.close();
    }
  });
});