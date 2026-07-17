'use strict';

const TEST_RECIPIENT = '0x1111111111111111111111111111111111111111';

function loadHarness({ executeGatewayTransferImpl } = {}) {
  jest.resetModules();

  const executeGatewayTransfer = jest.fn(executeGatewayTransferImpl);
  const recordAgenticPaymentEventSafe = jest.fn(async () => null);
  const logTaskEconomy = jest.fn();

  jest.doMock('../gatewayBuyer', () => ({
    executeGatewayTransfer,
  }));
  jest.doMock('../gatewayAuditService', () => ({
    recordAgenticPaymentEventSafe,
  }));
  jest.doMock('../logger', () => ({
    logTaskEconomy,
  }));
  jest.doMock('../revenuePoolConfig', () => ({
    getRevenuePoolAddress: jest.fn(() => TEST_RECIPIENT),
    getRevenuePoolSource: jest.fn(() => 'default'),
  }));

  const taskEconomyService = require('../taskEconomyService');
  return {
    taskEconomyService,
    executeGatewayTransfer,
    recordAgenticPaymentEventSafe,
    logTaskEconomy,
  };
}

describe('taskEconomyService', () => {
  test('defers fee settlement for ARC_RPC_COOLDOWN and preserves retry intent', async () => {
    const cooldownError = new Error('Arc RPC is cooling down');
    cooldownError.code = 'ARC_RPC_COOLDOWN';

    const {
      taskEconomyService,
      recordAgenticPaymentEventSafe,
    } = loadHarness({
      executeGatewayTransferImpl: async () => {
        throw cooldownError;
      },
    });

    const result = await taskEconomyService.settleExecutionFee({
      agent: { id: 'agent-1' },
      referenceId: 'tx-1',
      referenceType: 'automation',
      feeUsdc: 1.25,
      fromChain: 'Arc Testnet',
      toChain: 'Arc Testnet',
      mode: 'circle_gateway_automation_fee',
      rail: 'agentic_automation_economy',
    });

    expect(result).toMatchObject({
      status: 'deferred',
      reason: 'arc_rpc_cooldown',
      retryable: true,
      deferred: true,
      errorCode: 'ARC_RPC_COOLDOWN',
      feeUsdc: 1.25,
      referenceId: 'tx-1',
      referenceType: 'automation',
      retryIntent: {
        referenceId: 'tx-1',
        referenceType: 'automation',
        feeUsdc: 1.25,
        fromChain: 'Arc Testnet',
        toChain: 'Arc Testnet',
      },
    });
    expect(result.status).not.toBe('confirmed');
    expect(recordAgenticPaymentEventSafe).toHaveBeenCalledWith(expect.objectContaining({
      status: 'deferred',
      referenceId: 'tx-1',
    }));
  });

  test('keeps non-rate-limit gateway errors as real failures', async () => {
    const {
      taskEconomyService,
      recordAgenticPaymentEventSafe,
    } = loadHarness({
      executeGatewayTransferImpl: async () => {
        throw new Error('gateway write failed');
      },
    });

    await expect(taskEconomyService.settleExecutionFee({
      agent: { id: 'agent-2' },
      referenceId: 'tx-2',
      referenceType: 'automation',
      feeUsdc: 0.9,
    })).rejects.toThrow('gateway write failed');

    expect(recordAgenticPaymentEventSafe).not.toHaveBeenCalled();
  });

  test('does not mark settlement confirmed when mint transfer hash is missing', async () => {
    const {
      taskEconomyService,
      recordAgenticPaymentEventSafe,
    } = loadHarness({
      executeGatewayTransferImpl: async () => ({
        deposited: false,
        depositResult: {
          approvalTxHash: null,
          depositTxHash: null,
        },
        transferResult: {
          formattedAmount: '1.25',
          recipient: TEST_RECIPIENT,
          mintTxHash: null,
        },
      }),
    });

    const result = await taskEconomyService.settleExecutionFee({
      agent: { id: 'agent-3' },
      referenceId: 'tx-3',
      referenceType: 'automation',
      feeUsdc: 1.25,
    });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'gateway_transfer_unconfirmed',
    });
    expect(result.status).not.toBe('confirmed');
    expect(recordAgenticPaymentEventSafe).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      referenceId: 'tx-3',
    }));
  });
});
