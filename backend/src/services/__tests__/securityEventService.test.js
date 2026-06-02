'use strict';

function loadHarness(mockDb) {
  jest.resetModules();
  process.env.SECURITY_AGENT_FREEZE_THRESHOLD = '2';
  process.env.SECURITY_AGENT_EVENT_WINDOW_SEC = '900';
  process.env.SECURITY_AGENT_AUTO_UNFREEZE_ENABLED = 'true';
  process.env.SECURITY_AGENT_AUTO_UNFREEZE_COOLDOWN_SEC = '60';
  process.env.SECURITY_AGENT_AUTO_UNFREEZE_REASONS = 'suspicious_agent_activity';

  let service;
  jest.isolateModules(() => {
    jest.doMock('../../db', () => mockDb);
    service = require('../securityEventService');
  });

  return service;
}

describe('securityEventService', () => {
  test('freezes an agent after repeated suspicious tx events', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'evt-1' }] })
        .mockResolvedValueOnce({ rows: [{ total: 2 }] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'agent-1',
            user_id: 'user-1',
            wallet_address: '0x00000000000000000000000000000000000000AA',
            status: 'idle',
            is_active: true,
            security_frozen_at: null,
            security_freeze_reason: null,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'agent-1',
            user_id: 'user-1',
            wallet_address: '0x00000000000000000000000000000000000000AA',
            status: 'locked',
            is_active: false,
            security_frozen_at: '2026-05-24T19:00:00.000Z',
            security_freeze_reason: 'suspicious_agent_activity',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'evt-freeze' }] })
        .mockResolvedValueOnce(undefined),
      release: jest.fn(),
    };
    const db = {
      getClient: jest.fn().mockResolvedValue(client),
      query: jest.fn(),
    };

    const service = loadHarness(db);
    const result = await service.recordSuspiciousAgentActivity({
      agentId: 'agent-1',
      userId: 'user-1',
      walletAddress: '0x00000000000000000000000000000000000000AA',
      chainName: 'Arc Testnet',
      eventType: 'tx_replay_blocked',
      metadata: { code: 'TX_REPLAY_BLOCKED' },
    });

    expect(result.suspiciousCount).toBe(2);
    expect(result.frozen).toMatchObject({
      id: 'agent-1',
      status: 'locked',
      is_active: false,
      security_freeze_reason: 'suspicious_agent_activity',
    });
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('throws a frozen-agent error when agent status is locked', () => {
    const db = { getClient: jest.fn(), query: jest.fn() };
    const service = loadHarness(db);

    expect(() => service.assertAgentOperational({
      id: 'agent-1',
      status: 'locked',
      is_active: false,
      security_freeze_reason: 'suspicious_agent_activity',
      security_frozen_at: '2026-05-24T19:00:00.000Z',
    })).toThrow('Agent is frozen pending a security review.');
  });

  test('auto-unfreezes stale suspicious locks when recent suspicious traffic is clear', async () => {
    const frozenAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          rows: [{
            id: 'agent-1',
            user_id: 'user-1',
            wallet_address: '0x00000000000000000000000000000000000000AA',
            status: 'locked',
            is_active: false,
            security_frozen_at: frozenAt,
            security_freeze_reason: 'suspicious_agent_activity',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'agent-1',
            user_id: 'user-1',
            wallet_address: '0x00000000000000000000000000000000000000AA',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'evt-unfreeze' }] })
        .mockResolvedValueOnce(undefined),
      release: jest.fn(),
    };

    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'agent-1',
            user_id: 'user-1',
            wallet_address: '0x00000000000000000000000000000000000000AA',
            status: 'locked',
            is_active: false,
            security_frozen_at: frozenAt,
            security_freeze_reason: 'suspicious_agent_activity',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ total: 0 }] }),
      getClient: jest.fn().mockResolvedValue(client),
    };

    const service = loadHarness(db);
    const summary = await service.autoUnfreezeEligibleAgents({ limit: 10 });

    expect(summary.unfrozen).toBe(1);
    expect(summary.unfrozenAgentIds).toEqual(['agent-1']);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});