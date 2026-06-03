'use strict';

const request = require('supertest');

const TEST_USER_ID = 'user-123';
const TEST_AGENT_ID = 'agent-123';
const TEST_OWNER_ADDRESS = '0x00000000000000000000000000000000000000AA';
const TEST_JWT_SECRET = ['test', 'jwt', 'secret', 'fixture'].join('-');

function buildTestApp(router) {
  const express = require('express');
  const app = express();

  app.use(express.json());
  app.use('/api/agents', router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

function loadAgentsHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    queueDefiLoopForAgent: jest.fn().mockResolvedValue({
      queued: true,
      jobId: `defi-${TEST_AGENT_ID}-manual-test`,
    }),
  };

  const agentService = {
    listAgents: jest.fn().mockResolvedValue([]),
    createAgent: jest.fn(),
    getAgent: jest.fn().mockResolvedValue({ id: TEST_AGENT_ID }),
    updateAgent: jest.fn().mockResolvedValue({
      id: TEST_AGENT_ID,
      isSmartMode: false,
    }),
  };

  jest.doMock('../../queue/agentQueue', () => queue);
  jest.doMock('../../services/agentService', () => agentService);
  jest.doMock('../../services/llmService', () => ({}));
  jest.doMock('../../services/reputationService', () => ({}));
  jest.doMock('../../services/positionsService', () => ({}));
  jest.doMock('../../services/lpRewardService', () => ({}));
  jest.doMock('../../services/nativeLendingRiskService', () => ({}));
  jest.doMock('../../services/cryptoService', () => ({ encrypt: jest.fn((value) => `enc:${value}`) }));

  let router;
  let signToken;
  jest.isolateModules(() => {
    router = require('../agents');
    ({ signToken } = require('../../middleware/auth'));
  });

  return {
    app: buildTestApp(router),
    queue,
    agentService,
    signToken,
  };
}

describe('agents update DEFI kickoff', () => {
  test('uses hardened DEFI helper when enabling automation lanes', async () => {
    const { app, queue, agentService, signToken } = loadAgentsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    const response = await request(app)
      .put(`/api/agents/${TEST_AGENT_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ defiLoopEnabled: true });

    expect(response.status).toBe(200);
    expect(agentService.updateAgent).toHaveBeenCalledWith(TEST_AGENT_ID, TEST_USER_ID, { defiLoopEnabled: true });
    expect(queue.queueDefiLoopForAgent).toHaveBeenCalledWith(TEST_AGENT_ID, { reason: 'manual' });
    expect(queue.add).not.toHaveBeenCalledWith(
      'DEFI_LOOP',
      expect.any(Object),
      expect.any(Object),
    );
  });
});