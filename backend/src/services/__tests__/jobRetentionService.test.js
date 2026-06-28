'use strict';

describe('jobRetentionService', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.JOB_REVIEW_TIMEOUT_HOURS = '48';
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    delete process.env.AGENTIC_COMMERCE_ADDRESS;
  });

  test('builds a 48-hour review policy with delete-and-penalty defaults', () => {
    const db = { query: jest.fn() };

    jest.doMock('../../db', () => db);

    let service;
    jest.isolateModules(() => {
      service = require('../jobRetentionService');
    });

    const policy = service.buildJobReviewPolicy();

    expect(service.JOB_REVIEW_TIMEOUT_HOURS).toBe(48);
    expect(policy.timeoutHours).toBe(48);
    expect(policy.timeoutAction).toBe('delete_without_payout');
    expect(policy.autoPenalty).toBe(true);
    expect(policy.clientPenaltyEvent).toBe('JOB_REVIEW_TIMEOUT');
  });

  test('prunes expired delivered jobs and records audit plus reputation penalty', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'job-1',
            agent_id: 'agent-1',
            job_id_onchain: null,
            provider_address: '0x00000000000000000000000000000000000000CC',
            amount_usdc: '5',
            review_deadline_at: '2026-05-15T00:00:00.000Z',
            private_key_encrypted: null,
          }],
        })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const gatewayAuditService = {
      recordAgenticPaymentEventSafe: jest.fn().mockResolvedValue(undefined),
    };
    const recordReputationEvent = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../../db', () => db);
    jest.doMock('../agenticEconomy/gatewayAuditService', () => gatewayAuditService);
    jest.doMock('../reputationService', () => ({
      recordReputationEvent,
      EVENT_TYPES: {
        JOB_REVIEW_TIMEOUT: 'JOB_REVIEW_TIMEOUT',
      },
    }));
    jest.doMock('../cryptoService', () => ({ decrypt: jest.fn(() => '0x') }));

    let service;
    jest.isolateModules(() => {
      service = require('../jobRetentionService');
    });

    const result = await service.pruneExpiredJobs();

    expect(result.deletedCount).toBe(1);
    expect(gatewayAuditService.recordAgenticPaymentEventSafe).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      eventType: 'job_review_timeout',
      status: 'expired',
      referenceId: 'job-1',
    }));
    expect(recordReputationEvent).toHaveBeenCalledWith('agent-1', 'JOB_REVIEW_TIMEOUT');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM agent_jobs'),
      [['job-1']],
    );
  });
});
