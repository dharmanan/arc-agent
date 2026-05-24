'use strict';

const request = require('supertest');
const { Wallet } = require('ethers');

const TEST_USER_ID = 'user-123';
const TEST_AGENT_ID = 'agent-123';
const TEST_OWNER_ADDRESS = '0x00000000000000000000000000000000000000AA';
const TEST_JWT_SECRET = 'test-secret-1234567890-test-secret';

function buildTestApp(router, mountPath) {
  const express = require('express');
  const app = express();

  app.use(express.json());
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

function loadTasksHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const db = { query: jest.fn() };
  const queue = {
    queueManualTask: jest.fn().mockResolvedValue(undefined),
    guardTaskPermission: jest.fn().mockResolvedValue({ ok: true }),
  };
  const taskRunService = {
    findActiveTaskRun: jest.fn().mockResolvedValue(null),
    createTaskRun: jest.fn().mockResolvedValue({ id: 'run-1' }),
    failTaskRun: jest.fn().mockResolvedValue(undefined),
  };
  const isDailyLimitBypassed = jest.fn().mockReturnValue(false);

  jest.doMock('../../db', () => db);
  jest.doMock('../../queue/agentQueue', () => queue);
  jest.doMock('../../services/taskRunService', () => taskRunService);
  jest.doMock('../../services/dailyLimitBypass', () => ({ isDailyLimitBypassed }));
  jest.doMock('../../services/agentService', () => ({ getAgentWithKey: jest.fn() }));
  jest.doMock('../../services/circlePaidCatalogService', () => ({
    buildCirclePaidHandoff: jest.fn(() => null),
    getCirclePaidCatalog: jest.fn(() => ({ items: [], economy: {} })),
    getCirclePaidItemById: jest.fn(() => null),
  }));
  jest.doMock('../../services/predictionMarketService', () => ({
    getEventOddsCompare: jest.fn(),
    getPredictionMarketPulse: jest.fn(),
  }));
  jest.doMock('../../services/walletSnapshotService', () => ({
    getWalletAssetSnapshot: jest.fn(),
  }));
  jest.doMock('../../services/circlePaidSnapshotService', () => ({
    buildCirclePaidPricingSnapshot: jest.fn(),
    buildPredictionMarketPreviewPayload: jest.fn(),
    createCirclePaidPreviewSnapshot: jest.fn(),
    getCirclePaidSnapshotForAgent: jest.fn(),
    listCirclePaidSnapshots: jest.fn(),
    unlockCirclePaidSnapshot: jest.fn(),
  }));

  let router;
  let signToken;
  jest.isolateModules(() => {
    router = require('../tasks');
    ({ signToken } = require('../../middleware/auth'));
  });

  return {
    app: buildTestApp(router, '/api/tasks'),
    db,
    queue,
    taskRunService,
    signToken,
  };
}

function loadJobsHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  delete process.env.AGENTIC_COMMERCE_ADDRESS;

  const db = { query: jest.fn() };
  const gatewayAuditService = {
    recordAgenticPaymentEventSafe: jest.fn().mockResolvedValue(undefined),
  };
  const settleJobCreateFee = jest.fn().mockResolvedValue({
    rail: 'agentic_job_economy',
    feeUsdc: 0.05,
    status: 'confirmed',
    sourceChain: 'Arc Testnet',
    destinationChain: 'Arc Testnet',
  });
  const buildJobEconomy = jest.fn(({ economy, job }) => ({
    ...(economy || {}),
    summaryStatus: job?.status || null,
    payout: economy?.payout || { rail: 'agentic_job_escrow', status: 'completed' },
    applicationsOpen: economy?.applicationsOpen || false,
    applications: economy?.applications || [],
    reviewPolicy: economy?.reviewPolicy || {
      mode: 'manual_client_review',
      autoPenalty: false,
    },
  }));
  const recordReputationEvent = jest.fn().mockResolvedValue(undefined);
  const buildJobReviewPolicy = jest.fn((existing = {}) => ({
    mode: 'manual_client_review',
    autoPenalty: true,
    timeoutHours: 48,
    timeoutAction: 'delete_without_payout',
    clientPenaltyEvent: 'JOB_REVIEW_TIMEOUT',
    disputeState: existing.disputeState || 'none',
    disputeReason: existing.disputeReason || '',
    disputeRaisedAt: existing.disputeRaisedAt || null,
    disputeRaisedBy: existing.disputeRaisedBy || null,
  }));

  jest.doMock('../../db', () => db);
  jest.doMock('../../services/cryptoService', () => ({ decrypt: jest.fn(() => '0x') }));
  jest.doMock('../../services/agenticEconomy/gatewayAuditService', () => gatewayAuditService);
  jest.doMock('../../services/agenticEconomy/jobEconomyService', () => ({
    settleJobCreateFee,
    buildJobEconomy,
    getJobEconomyConfigSummary: jest.fn(() => ({ mode: 'test_job_economy' })),
    buildJobCreateFeeFailure: jest.fn(({ error }) => ({
      rail: 'agentic_job_economy',
      feeUsdc: 0.05,
      status: 'failed',
      reason: error,
    })),
  }));
  jest.doMock('../../services/reputationService', () => ({
    recordReputationEvent,
    EVENT_TYPES: { TX_COMPLETED: 'TX_COMPLETED', JOB_REVIEW_TIMEOUT: 'JOB_REVIEW_TIMEOUT' },
  }));
  jest.doMock('../../services/jobRetentionService', () => ({
    buildJobReviewPolicy,
    JOB_REVIEW_TIMEOUT_HOURS: 48,
  }));

  let router;
  let signToken;
  jest.isolateModules(() => {
    router = require('../jobs');
    ({ signToken } = require('../../middleware/auth'));
  });

  return {
    app: buildTestApp(router, '/api/agents/:id/jobs'),
    db,
    gatewayAuditService,
    recordReputationEvent,
    signToken,
  };
}

function loadPublicJobsHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';

  const db = { query: jest.fn() };
  const buildJobEconomy = jest.fn(({ economy, job }) => ({
    ...(economy || {}),
    summaryStatus: job?.status || null,
    applicationsOpen: economy?.applicationsOpen || false,
    applications: economy?.applications || [],
    reviewPolicy: economy?.reviewPolicy || {
      mode: 'manual_client_review',
      autoPenalty: true,
      timeoutHours: 48,
      clientPenaltyEvent: 'JOB_REVIEW_TIMEOUT',
    },
  }));

  jest.doMock('../../db', () => db);
  jest.doMock('../../services/agenticEconomy/jobEconomyService', () => ({
    buildJobEconomy,
  }));
  jest.doMock('../../services/jobRetentionService', () => ({
    buildJobReviewPolicy: jest.fn((existing = {}) => ({
      mode: 'manual_client_review',
      autoPenalty: true,
      timeoutHours: 48,
      timeoutAction: 'delete_without_payout',
      clientPenaltyEvent: 'JOB_REVIEW_TIMEOUT',
      disputeState: existing.disputeState || 'none',
      disputeReason: existing.disputeReason || '',
      disputeRaisedAt: existing.disputeRaisedAt || null,
      disputeRaisedBy: existing.disputeRaisedBy || null,
    })),
    JOB_REVIEW_TIMEOUT_HOURS: 48,
  }));
  jest.doMock('../../services/cryptoService', () => ({ decrypt: jest.fn(() => '0x') }));
  jest.doMock('../../services/agenticEconomy/gatewayAuditService', () => ({
    recordAgenticPaymentEventSafe: jest.fn().mockResolvedValue(undefined),
  }));
  jest.doMock('../../services/reputationService', () => ({
    recordReputationEvent: jest.fn().mockResolvedValue(undefined),
    EVENT_TYPES: { JOB_REVIEW_TIMEOUT: 'JOB_REVIEW_TIMEOUT' },
  }));

  let routeModule;
  jest.isolateModules(() => {
    routeModule = require('../publicJobs');
  });

  return {
    app: buildTestApp(routeModule, '/api/jobs'),
    db,
    buildPublicJobDeliveryMessage: routeModule._buildPublicJobDeliveryMessage,
    buildPublicJobApplicationMessage: routeModule._buildPublicJobApplicationMessage,
    buildPublicJobDisputeMessage: routeModule._buildPublicJobDisputeMessage,
  };
}

function loadOracleHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.ORACLE_PAY_ADDRESS = '0x00000000000000000000000000000000000000BB';

  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const gatewayMiddleware = jest.fn((req, res) => {
    res
      .status(402)
      .set('PAYMENT-REQUIRED', 'amount=5000')
      .json({ error: 'payment_required' });
  });
  const recordOracleSignal = jest.fn();

  jest.doMock('../../db', () => db);
  jest.doMock('../../services/oracle', () => ({
    recordOracleSignal,
    recordOracleFallback: jest.fn(),
    normalizeCurvePoolKey: jest.fn((value) => value),
    normalizePoolVenue: jest.fn((value) => value),
    getCacheStats: jest.fn(() => ({})),
    getOracleObservabilitySummary: jest.fn(() => ({})),
    getYieldOpportunities: jest.fn().mockResolvedValue([]),
  }));
  jest.doMock('../../services/protocols', () => ({}));
  jest.doMock('../../services/agentWalletService', () => ({}));
  jest.doMock('../../services/agentService', () => ({}));
  jest.doMock('../../services/predictionMarketService', () => ({
    getPredictionMarketPulse: jest.fn(),
  }));
  jest.doMock('../../services/agenticEconomy/gatewaySeller', () => ({
    createGatewayRouteConfig: jest.fn((config) => config),
    createGatewaySellerMiddleware: jest.fn(() => gatewayMiddleware),
    getGatewaySellerSummary: jest.fn(() => ({ configured: true })),
  }));
  jest.doMock('../../services/agenticEconomy/gatewayFacilitator', () => ({
    getGatewayFacilitatorSummary: jest.fn(() => ({ configured: true })),
  }));
  jest.doMock('../../services/agenticEconomy/gatewayBuyer', () => ({
    depositGatewayBalance: jest.fn(),
    getAgentGatewayBalances: jest.fn(),
    getGatewayBuyerSummary: jest.fn(() => ({ configured: true })),
    createGatewayClientForAgent: jest.fn(),
  }));
  jest.doMock('../../services/agenticEconomy/taskEconomyService', () => ({
    getTaskEconomyConfigSummary: jest.fn(() => ({ mode: 'task_fee' })),
  }));
  jest.doMock('../../services/agenticEconomy/jobEconomyService', () => ({
    getJobEconomyConfigSummary: jest.fn(() => ({ mode: 'job_fee' })),
  }));
  jest.doMock('../../services/agenticEconomy/logger', () => ({
    logOracleGateway: jest.fn(),
  }));

  let router;
  jest.isolateModules(() => {
    router = require('../oracle');
  });

  return {
    app: buildTestApp(router, '/api/oracle'),
    gatewayMiddleware,
    recordOracleSignal,
  };
}

describe('tasks route smoke', () => {
  test('rejects protected task results without auth', async () => {
    const { app } = loadTasksHarness();

    const response = await request(app).get(`/api/tasks/agents/${TEST_AGENT_ID}/tasks/results`);

    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/Authorization header/i);
  });

  test('returns the public task catalog', async () => {
    const { app, db } = loadTasksHarness();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'EXEC_ARB', title: 'Arb', description: 'Arb task', tier: 2, fee_usdc: '0.10' }],
    });

    const response = await request(app).get('/api/tasks/catalog');

    expect(response.status).toBe(200);
    expect(response.body.tasks).toHaveLength(1);
    expect(response.body.tasks[0].id).toBe('EXEC_ARB');
  });

  test('returns protected task results with a valid token', async () => {
    const { app, db, signToken } = loadTasksHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({ rows: [{ id: TEST_AGENT_ID }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'result-1',
          task_id: 'EXEC_ARB',
          payload: { ok: true },
          created_at: '2026-05-17T00:00:00.000Z',
          title: 'Arb',
          description: 'Arb task',
        }],
      });

    const response = await request(app)
      .get(`/api/tasks/agents/${TEST_AGENT_ID}/tasks/results?limit=5`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0].task_id).toBe('EXEC_ARB');
  });

  test('rejects paid rebalance runs with missing required params', async () => {
    const { app, db, signToken } = loadTasksHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query.mockResolvedValueOnce({
      rows: [{ id: 'EXEC_REBALANCE', tier: 2, fee_usdc: '0.10' }],
    });

    const response = await request(app)
      .post(`/api/tasks/agents/${TEST_AGENT_ID}/tasks/run`)
      .set('Authorization', `Bearer ${token}`)
      .send({ taskId: 'EXEC_REBALANCE', params: {} });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('rebalance_amount_required');
  });

  test('blocks queued task runs when the required strategy permission is disabled', async () => {
    const { app, db, queue, taskRunService, signToken } = loadTasksHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({
        rows: [{ id: 'DAILY_ARB_SCAN', tier: 1, fee_usdc: '0.00' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: TEST_AGENT_ID,
          daily_tasks_enabled: true,
          daily_free_task_count: 0,
          daily_paid_task_count: 0,
          daily_limit_reset_at: '2026-05-24T00:00:00.000Z',
          wallet_address: TEST_OWNER_ADDRESS,
        }],
      });
    queue.guardTaskPermission.mockResolvedValueOnce({
      ok: false,
      error: 'permission_blocked',
      reason: 'permission_blocked',
      permission: 'defi_scan',
      stageDetail: 'Task DAILY_ARB_SCAN is blocked because DeFi Protocol Scanner is disabled for this agent.',
    });

    const response = await request(app)
      .post(`/api/tasks/agents/${TEST_AGENT_ID}/tasks/run`)
      .set('Authorization', `Bearer ${token}`)
      .send({ taskId: 'DAILY_ARB_SCAN', params: {} });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('permission_blocked');
    expect(response.body.permission).toBe('defi_scan');
    expect(queue.queueManualTask).not.toHaveBeenCalled();
    expect(taskRunService.createTaskRun).not.toHaveBeenCalled();
  });

  test('rejects task runs for security-frozen agents', async () => {
    const { app, db, queue, taskRunService, signToken } = loadTasksHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({
        rows: [{ id: 'DAILY_ARB_SCAN', tier: 1, fee_usdc: '0.00' }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: TEST_AGENT_ID,
          daily_tasks_enabled: true,
          daily_free_task_count: 0,
          daily_paid_task_count: 0,
          daily_limit_reset_at: '2026-05-24T00:00:00.000Z',
          wallet_address: TEST_OWNER_ADDRESS,
          status: 'locked',
          is_active: false,
          security_frozen_at: '2026-05-24T19:00:00.000Z',
          security_freeze_reason: 'suspicious_agent_activity',
        }],
      });

    const response = await request(app)
      .post(`/api/tasks/agents/${TEST_AGENT_ID}/tasks/run`)
      .set('Authorization', `Bearer ${token}`)
      .send({ taskId: 'DAILY_ARB_SCAN', params: {} });

    expect(response.status).toBe(423);
    expect(response.body.error).toBe('Agent is frozen pending a security review.');
    expect(queue.guardTaskPermission).not.toHaveBeenCalled();
    expect(queue.queueManualTask).not.toHaveBeenCalled();
    expect(taskRunService.createTaskRun).not.toHaveBeenCalled();
  });
});

describe('jobs route smoke', () => {
  test('creates a funded job for an authenticated agent', async () => {
    const { app, db, gatewayAuditService, signToken } = loadJobsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: TEST_AGENT_ID,
          wallet_address: TEST_OWNER_ADDRESS,
          private_key_encrypted: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'funded',
          client_address: TEST_OWNER_ADDRESS,
          provider_address: '0x00000000000000000000000000000000000000CC',
          amount_usdc: 5,
          description: 'Test job',
          economy: {},
        }],
      });

    const response = await request(app)
      .post(`/api/agents/${TEST_AGENT_ID}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        providerAddress: '0x00000000000000000000000000000000000000CC',
        amountUsdc: 5,
        description: 'Test job',
      });

    expect(response.status).toBe(201);
    expect(response.body.job.status).toBe('funded');
    expect(gatewayAuditService.recordAgenticPaymentEventSafe).toHaveBeenCalled();
  });

  test('moves a job from funded to delivered to completed', async () => {
    const { app, db, recordReputationEvent, signToken } = loadJobsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({ rows: [{ id: TEST_AGENT_ID, private_key_encrypted: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'funded',
          job_id_onchain: null,
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          economy: {},
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'delivered',
          deliverable_hash: 'ipfs://deliverable',
          review_deadline_at: '2026-05-19T00:00:00.000Z',
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          economy: {},
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: TEST_AGENT_ID, private_key_encrypted: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'delivered',
          job_id_onchain: null,
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          economy: {},
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'completed',
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          tx_hash_settle: null,
          economy: {},
        }],
      });

    const deliveredResponse = await request(app)
      .put(`/api/agents/${TEST_AGENT_ID}/jobs/job-1/deliver`)
      .set('Authorization', `Bearer ${token}`)
      .send({ deliverableHash: 'ipfs://deliverable' });

    expect(deliveredResponse.status).toBe(200);
    expect(deliveredResponse.body.status).toBe('delivered');
    expect(deliveredResponse.body.review_deadline_at).toBe('2026-05-19T00:00:00.000Z');

    const completedResponse = await request(app)
      .put(`/api/agents/${TEST_AGENT_ID}/jobs/job-1/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(completedResponse.status).toBe(200);
    expect(completedResponse.body.status).toBe('completed');
    expect(recordReputationEvent).toHaveBeenCalled();
  });

  test('cancels a funded job before delivery', async () => {
    const { app, db, signToken } = loadJobsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({ rows: [{ id: TEST_AGENT_ID, private_key_encrypted: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'funded',
          job_id_onchain: null,
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          economy: {},
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'cancelled',
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          economy: {},
        }],
      });

    const response = await request(app)
      .put(`/api/agents/${TEST_AGENT_ID}/jobs/job-1/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('cancelled');
  });

  test('rejects delivered work through a separate reject route', async () => {
    const { app, db, signToken } = loadJobsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({ rows: [{ id: TEST_AGENT_ID, private_key_encrypted: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'delivered',
          job_id_onchain: null,
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          review_deadline_at: '2999-05-19T00:00:00.000Z',
          economy: {},
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'rejected',
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          review_deadline_at: null,
          economy: {},
        }],
      });

    const response = await request(app)
      .put(`/api/agents/${TEST_AGENT_ID}/jobs/job-1/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');
  });

  test('requires reject instead of cancel for delivered jobs', async () => {
    const { app, db, signToken } = loadJobsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({ rows: [{ id: TEST_AGENT_ID, private_key_encrypted: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          status: 'delivered',
          job_id_onchain: null,
          amount_usdc: 5,
          provider_address: '0x00000000000000000000000000000000000000CC',
          review_deadline_at: '2999-05-19T00:00:00.000Z',
          economy: {},
        }],
      });

    const response = await request(app)
      .put(`/api/agents/${TEST_AGENT_ID}/jobs/job-1/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('job_requires_reject');
    expect(response.body.status).toBe('delivered');
  });

  test('creates a manual-application job without a fixed provider', async () => {
    const { app, db, signToken } = loadJobsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: TEST_AGENT_ID,
          wallet_address: TEST_OWNER_ADDRESS,
          private_key_encrypted: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-open-1',
          agent_id: TEST_AGENT_ID,
          status: 'funded',
          client_address: TEST_OWNER_ADDRESS,
          provider_address: null,
          amount_usdc: 5,
          description: 'Open applicant job',
          economy: {
            applicationsOpen: true,
            applications: [],
          },
        }],
      });

    const response = await request(app)
      .post(`/api/agents/${TEST_AGENT_ID}/jobs`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        amountUsdc: 5,
        description: 'Open applicant job',
        acceptingApplications: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.job.provider_address).toBeNull();
    expect(response.body.job.economy.applicationsOpen).toBe(true);
  });

  test('assigns a provider to an open applicant job', async () => {
    const { app, db, signToken } = loadJobsHarness();
    const token = signToken(TEST_USER_ID, TEST_OWNER_ADDRESS.toLowerCase());
    const assignedProvider = '0x00000000000000000000000000000000000000CC';

    db.query
      .mockResolvedValueOnce({ rows: [{ id: TEST_AGENT_ID, private_key_encrypted: null }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-open-1',
          agent_id: TEST_AGENT_ID,
          status: 'funded',
          provider_address: null,
          economy: {
            applicationsOpen: true,
            applications: [{ applicantAddress: assignedProvider, note: 'Can take this job', createdAt: '2026-05-17T00:00:00.000Z' }],
          },
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-open-1',
          agent_id: TEST_AGENT_ID,
          status: 'funded',
          provider_address: assignedProvider,
          economy: {
            applicationsOpen: false,
            applications: [{ applicantAddress: assignedProvider, note: 'Can take this job', createdAt: '2026-05-17T00:00:00.000Z' }],
          },
        }],
      });

    const response = await request(app)
      .put(`/api/agents/${TEST_AGENT_ID}/jobs/job-open-1/assign-provider`)
      .set('Authorization', `Bearer ${token}`)
      .send({ providerAddress: assignedProvider });

    expect(response.status).toBe(200);
    expect(response.body.job.provider_address).toBe(assignedProvider);
    expect(response.body.job.economy.applicationsOpen).toBe(false);
  });
});

describe('public jobs route smoke', () => {
  test('returns active jobs on the public board without auth', async () => {
    const { app, db } = loadPublicJobsHarness();

    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        agent_id: TEST_AGENT_ID,
        job_id_onchain: null,
        client_address: TEST_OWNER_ADDRESS,
        provider_address: '0x00000000000000000000000000000000000000CC',
        amount_usdc: '5',
        description: 'Public research job',
        status: 'funded',
        deliverable_hash: null,
        tx_hash_create: null,
        tx_hash_settle: null,
        economy: {},
        created_at: '2026-05-17T00:00:00.000Z',
        updated_at: '2026-05-17T00:00:00.000Z',
      }],
    });

    const response = await request(app).get('/api/jobs/public/board');

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0].status).toBe('funded');
    expect(response.body.jobs[0].boardMode).toBe('locked_provider');
    expect(response.body.paymentRule).toBe('deliver_does_not_release_payout');
  });

  test('records a public provider delivery with a wallet signature', async () => {
    const { app, db, buildPublicJobDeliveryMessage } = loadPublicJobsHarness();
    const provider = Wallet.createRandom();
    const deliverableHash = 'ipfs://proof';

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          job_id_onchain: null,
          client_address: TEST_OWNER_ADDRESS,
          provider_address: provider.address,
          amount_usdc: '5',
          description: 'Public research job',
          status: 'funded',
          deliverable_hash: null,
          tx_hash_create: null,
          tx_hash_settle: null,
          economy: {},
          created_at: '2026-05-17T00:00:00.000Z',
          updated_at: '2026-05-17T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          job_id_onchain: null,
          client_address: TEST_OWNER_ADDRESS,
          provider_address: provider.address,
          amount_usdc: '5',
          description: 'Public research job',
          status: 'delivered',
          deliverable_hash: deliverableHash,
          tx_hash_create: null,
          tx_hash_settle: null,
          review_deadline_at: '2026-05-19T00:00:00.000Z',
          economy: {},
          created_at: '2026-05-17T00:00:00.000Z',
          updated_at: '2026-05-17T00:05:00.000Z',
        }],
      });

    const signature = await provider.signMessage(
      buildPublicJobDeliveryMessage({
        jobId: 'job-1',
        providerAddress: provider.address,
        deliverableHash,
      }),
    );

    const response = await request(app)
      .post('/api/jobs/public/job-1/deliver')
      .send({
        providerAddress: provider.address,
        deliverableHash,
        signature,
      });

    expect(response.status).toBe(200);
    expect(response.body.job.status).toBe('delivered');
    expect(response.body.job.reviewRequired).toBe(true);
    expect(response.body.job.reviewDeadlineAt).toBe('2026-05-19T00:00:00.000Z');
    expect(response.body.paymentRule).toBe('deliver_does_not_release_payout');
  });

  test('records a public manual application with a wallet signature', async () => {
    const { app, db, buildPublicJobApplicationMessage } = loadPublicJobsHarness();
    const applicant = Wallet.createRandom();
    const note = 'I can deliver this in markdown with source links.';

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-open-1',
          agent_id: TEST_AGENT_ID,
          job_id_onchain: null,
          client_address: TEST_OWNER_ADDRESS,
          provider_address: null,
          amount_usdc: '5',
          description: 'Open applicant job',
          status: 'funded',
          deliverable_hash: null,
          tx_hash_create: null,
          tx_hash_settle: null,
          economy: {
            applicationsOpen: true,
            applications: [],
          },
          created_at: '2026-05-17T00:00:00.000Z',
          updated_at: '2026-05-17T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-open-1',
          agent_id: TEST_AGENT_ID,
          job_id_onchain: null,
          client_address: TEST_OWNER_ADDRESS,
          provider_address: null,
          amount_usdc: '5',
          description: 'Open applicant job',
          status: 'funded',
          deliverable_hash: null,
          tx_hash_create: null,
          tx_hash_settle: null,
          economy: {
            applicationsOpen: true,
            applications: [{ applicantAddress: applicant.address, note, createdAt: '2026-05-17T00:05:00.000Z' }],
          },
          created_at: '2026-05-17T00:00:00.000Z',
          updated_at: '2026-05-17T00:05:00.000Z',
        }],
      });

    const signature = await applicant.signMessage(
      buildPublicJobApplicationMessage({
        jobId: 'job-open-1',
        applicantAddress: applicant.address,
        note,
      }),
    );

    const response = await request(app)
      .post('/api/jobs/public/job-open-1/apply')
      .send({
        applicantAddress: applicant.address,
        note,
        signature,
      });

    expect(response.status).toBe(200);
    expect(response.body.job.applicationsOpen).toBe(true);
    expect(response.body.job.applicationCount).toBe(1);
  });

  test('records a provider dispute during manual client review', async () => {
    const { app, db, buildPublicJobDisputeMessage } = loadPublicJobsHarness();
    const provider = Wallet.createRandom();
    const reason = 'Delivered the exact brief, but the client is not responding.';

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          job_id_onchain: null,
          client_address: TEST_OWNER_ADDRESS,
          provider_address: provider.address,
          amount_usdc: '5',
          description: 'Locked provider job',
          status: 'delivered',
          deliverable_hash: 'ipfs://proof',
          tx_hash_create: null,
          tx_hash_settle: null,
          review_deadline_at: '2999-05-19T00:00:00.000Z',
          economy: {},
          created_at: '2026-05-17T00:00:00.000Z',
          updated_at: '2026-05-17T00:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          agent_id: TEST_AGENT_ID,
          job_id_onchain: null,
          client_address: TEST_OWNER_ADDRESS,
          provider_address: provider.address,
          amount_usdc: '5',
          description: 'Locked provider job',
          status: 'delivered',
          deliverable_hash: 'ipfs://proof',
          tx_hash_create: null,
          tx_hash_settle: null,
          review_deadline_at: '2999-05-19T00:00:00.000Z',
          economy: {
            reviewPolicy: {
              disputeState: 'raised',
              disputeReason: reason,
              disputeRaisedBy: provider.address,
            },
          },
          created_at: '2026-05-17T00:00:00.000Z',
          updated_at: '2026-05-17T00:06:00.000Z',
        }],
      });

    const signature = await provider.signMessage(
      buildPublicJobDisputeMessage({
        jobId: 'job-1',
        providerAddress: provider.address,
        reason,
      }),
    );

    const response = await request(app)
      .post('/api/jobs/public/job-1/dispute')
      .send({
        providerAddress: provider.address,
        reason,
        signature,
      });

    expect(response.status).toBe(200);
    expect(response.body.job.reviewPolicy.disputeState).toBe('raised');
    expect(response.body.job.reviewPolicy.disputeReason).toBe(reason);
  });

  test('returns 410 for an expired delivered job detail', async () => {
    const { app, db } = loadPublicJobsHarness();

    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        agent_id: TEST_AGENT_ID,
        job_id_onchain: null,
        client_address: TEST_OWNER_ADDRESS,
        provider_address: '0x00000000000000000000000000000000000000CC',
        amount_usdc: '5',
        description: 'Expired delivered job',
        status: 'delivered',
        deliverable_hash: 'ipfs://proof',
        tx_hash_create: null,
        tx_hash_settle: null,
        review_deadline_at: '2000-05-19T00:00:00.000Z',
        economy: {},
        created_at: '2026-05-17T00:00:00.000Z',
        updated_at: '2026-05-17T00:05:00.000Z',
      }],
    });

    const response = await request(app).get('/api/jobs/public/job-1');

    expect(response.status).toBe(410);
    expect(response.body.error).toBe('job_review_window_expired');
  });
});

describe('oracle public payment guard smoke', () => {
  test('returns a payment challenge for the public pool-state route', async () => {
    const { app, gatewayMiddleware, recordOracleSignal } = loadOracleHarness();

    const response = await request(app).get('/api/oracle/public/pool-state?pool=USDC-EURC&venue=curve');

    expect(response.status).toBe(402);
    expect(response.headers['payment-required']).toBe('amount=5000');
    expect(gatewayMiddleware).toHaveBeenCalled();
    expect(recordOracleSignal).toHaveBeenCalledWith('payment_challenge', expect.any(Object));
  });
});