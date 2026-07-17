'use strict';

const TEST_AGENT = {
  id: 'agent-1',
  private_key_encrypted: 'encrypted-key',
  gateway_auto_topup_enabled: true,
};

function loadHarness({ ensureGatewayWarmBalanceImpl } = {}) {
  jest.resetModules();

  const ensureGatewayWarmBalance = jest.fn(ensureGatewayWarmBalanceImpl);
  jest.doMock('../../services/agenticEconomy/gatewayBuyer', () => ({
    ensureGatewayWarmBalance,
  }));

  const gatewayAutoWarmService = require('../gatewayAutoWarmService');
  gatewayAutoWarmService.__resetGatewayAutoWarmDebounceForTests();

  return {
    gatewayAutoWarmService,
    ensureGatewayWarmBalance,
  };
}

describe('gatewayAutoWarmService', () => {
  test('returns deferred when ARC_RPC_COOLDOWN is raised during auto-warm', async () => {
    const arcCooldownError = new Error('Arc RPC is cooling down');
    arcCooldownError.code = 'ARC_RPC_COOLDOWN';

    const { gatewayAutoWarmService } = loadHarness({
      ensureGatewayWarmBalanceImpl: async () => {
        throw arcCooldownError;
      },
    });

    const result = await gatewayAutoWarmService.maybeWarmAgentGatewayBalance(TEST_AGENT, 'defi_loop');

    expect(result).toMatchObject({
      attempted: false,
      deposited: false,
      reason: 'deferred',
      errorCode: 'ARC_RPC_COOLDOWN',
    });
  });

  test('classifies request limit reached as an expected deferred auto-warm condition', async () => {
    const requestLimitError = new Error('request limit reached');

    const { gatewayAutoWarmService } = loadHarness({
      ensureGatewayWarmBalanceImpl: async () => {
        throw requestLimitError;
      },
    });

    expect(gatewayAutoWarmService.isGatewayAutoWarmExpectedSkipError(requestLimitError)).toBe(true);

    const result = await gatewayAutoWarmService.maybeWarmAgentGatewayBalance(TEST_AGENT, 'oracle_query');
    expect(result.reason).toBe('deferred');
  });

  test('preserves main DeFi result when optional auto-warm is deferred', async () => {
    const arcCooldownError = new Error('Arc RPC is cooling down');
    arcCooldownError.code = 'ARC_RPC_COOLDOWN';

    const { gatewayAutoWarmService } = loadHarness({
      ensureGatewayWarmBalanceImpl: async () => {
        throw arcCooldownError;
      },
    });

    const mainDefiResult = {
      ok: true,
      txHash: '0xabc',
      action: 'rebalance',
    };

    await expect(gatewayAutoWarmService.maybeWarmAgentGatewayBalance(TEST_AGENT, 'defi_loop')).resolves.toMatchObject({
      reason: 'deferred',
    });

    expect(mainDefiResult).toEqual({
      ok: true,
      txHash: '0xabc',
      action: 'rebalance',
    });
  });

  test('keeps non-rate-limit auto-warm errors as real failures', async () => {
    const { gatewayAutoWarmService } = loadHarness({
      ensureGatewayWarmBalanceImpl: async () => {
        throw new Error('invalid gateway signer');
      },
    });

    const result = await gatewayAutoWarmService.maybeWarmAgentGatewayBalance(TEST_AGENT, 'incoming_transfer');

    expect(result).toMatchObject({
      attempted: false,
      deposited: false,
      reason: 'error',
    });
  });
});
