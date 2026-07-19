'use strict';

const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const TEST_WALLET_ADDRESS = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c';
const ENDPOINT_A = 'https://rpc-a.testnet.arc.network';
const ENDPOINT_B = 'https://rpc-b.testnet.arc.network';

function loadHarness({ safeArcRpcCallImpl, clientFactory } = {}) {
  jest.resetModules();

  const gatewayClientCtor = jest.fn();
  const defaultClient = {
    getUsdcBalance: jest.fn(),
    getGatewayBalance: jest.fn(),
    deposit: jest.fn(),
    withdraw: jest.fn(),
  };
  let gatewayFunded = false;

  defaultClient.getUsdcBalance.mockResolvedValue({
    balance: 5_000_000n,
    formatted: '5',
  });
  defaultClient.getGatewayBalance.mockImplementation(async () => (gatewayFunded
    ? {
        available: 3_000_000n,
        formattedAvailable: '3',
        total: 3_000_000n,
        formattedTotal: '3',
        withdrawing: 0n,
        formattedWithdrawing: '0',
        withdrawable: 3_000_000n,
        formattedWithdrawable: '3',
      }
    : {
        available: 0n,
        formattedAvailable: '0',
        total: 0n,
        formattedTotal: '0',
        withdrawing: 0n,
        formattedWithdrawing: '0',
        withdrawable: 0n,
        formattedWithdrawable: '0',
      }));
  defaultClient.deposit.mockImplementation(async (amount) => {
    gatewayFunded = true;
    return { depositTxHash: `deposit-${amount}` };
  });

  const runProtectedWrite = jest.fn(async (options, execute) => execute());
  const safeArcRpcCall = jest.fn(safeArcRpcCallImpl || (async (_label, fn) => fn({}, ENDPOINT_A)));
  const arcProvider = {
    getHealthyArcRpcUrl: jest.fn(() => ENDPOINT_A),
    safeArcRpcCall,
    isArcRpcRateLimitError: jest.fn((error) => /request limit reached|rate limit|too many requests/i.test(String(error?.message || ''))),
  };

  jest.doMock('@circle-fin/x402-batching/client', () => ({
    GatewayClient: gatewayClientCtor.mockImplementation((config) => {
      if (typeof clientFactory === 'function') {
        return clientFactory(config);
      }
      return defaultClient;
    }),
  }));
  jest.doMock('../../cryptoService', () => ({
    decrypt: jest.fn(() => TEST_PRIVATE_KEY),
  }));
  jest.doMock('../../txSecurityService', () => ({
    runProtectedWrite,
  }));
  jest.doMock('../../arcProvider', () => arcProvider);
  jest.doMock('../logger', () => ({
    logGateway: jest.fn(),
  }));

  const gatewayBuyer = require('../gatewayBuyer');
  return {
    gatewayBuyer,
    defaultClient,
    runProtectedWrite,
    arcProvider,
    gatewayClientCtor,
    safeArcRpcCall,
  };
}

describe('gatewayBuyer', () => {
  test('serializes auto-warm deposits with the shared wallet transaction lock', async () => {
    const { gatewayBuyer, defaultClient, runProtectedWrite, safeArcRpcCall } = loadHarness();

    const result = await gatewayBuyer.ensureGatewayWarmBalance({
      id: 'agent-1',
      wallet_address: TEST_WALLET_ADDRESS,
      private_key_encrypted: 'encrypted-key',
    }, {
      chainName: 'Arc Testnet',
      minAvailableUsdc: 1,
      targetAvailableUsdc: 3,
    });

    expect(result).toMatchObject({
      attempted: true,
      deposited: true,
      reason: 'funded',
      amountUsdc: '3',
    });
    expect(defaultClient.deposit).toHaveBeenCalledWith('3');
    expect(runProtectedWrite).toHaveBeenCalledTimes(1);
    expect(safeArcRpcCall).toHaveBeenCalledWith(
      expect.stringContaining('gateway_'),
      expect.any(Function),
      expect.objectContaining({ trafficClass: 'gateway_write' }),
    );
    expect(runProtectedWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        chainName: 'Arc Testnet',
        walletAddress: TEST_WALLET_ADDRESS,
        operation: 'gateway_warm_balance',
        waitForLockMs: 0,
      }),
      expect.any(Function),
    );
  });

  test('tries the next configured endpoint before succeeding', async () => {
    const {
      gatewayBuyer,
      gatewayClientCtor,
      safeArcRpcCall,
    } = loadHarness();

    const firstClient = {
      getUsdcBalance: jest.fn().mockResolvedValue({ balance: 5_000_000n, formatted: '5' }),
      getGatewayBalance: jest.fn().mockRejectedValue(new Error('request limit reached')),
      deposit: jest.fn(),
      withdraw: jest.fn(),
    };
    const secondClient = {
      getUsdcBalance: jest.fn().mockResolvedValue({ balance: 5_000_000n, formatted: '5' }),
      getGatewayBalance: jest.fn().mockResolvedValue({
        available: 2_000_000n,
        formattedAvailable: '2',
        total: 2_000_000n,
        formattedTotal: '2',
        withdrawing: 0n,
        formattedWithdrawing: '0',
        withdrawable: 2_000_000n,
        formattedWithdrawable: '2',
      }),
      deposit: jest.fn(),
      withdraw: jest.fn(),
    };

    gatewayClientCtor.mockImplementation((config) => {
      if (config.rpcUrl === ENDPOINT_A) return firstClient;
      if (config.rpcUrl === ENDPOINT_B) return secondClient;
      return secondClient;
    });

    safeArcRpcCall.mockImplementation(async (_label, fn, options) => {
      expect(options).toMatchObject({ trafficClass: 'gateway_read' });
      const endpoints = [ENDPOINT_A, ENDPOINT_B];
      let lastError = null;

      for (const endpoint of endpoints) {
        try {
          return await fn({}, endpoint);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError || new Error('gateway_failover_failed');
    });

    const balances = await gatewayBuyer.getAgentGatewayBalances({
      id: 'agent-2',
      wallet_address: TEST_WALLET_ADDRESS,
      private_key_encrypted: 'encrypted-key',
    }, {
      chainName: 'Arc Testnet',
      address: TEST_WALLET_ADDRESS,
    });

    expect(gatewayClientCtor).toHaveBeenCalledWith(expect.objectContaining({ rpcUrl: ENDPOINT_A }));
    expect(gatewayClientCtor).toHaveBeenCalledWith(expect.objectContaining({ rpcUrl: ENDPOINT_B }));
    expect(secondClient.getGatewayBalance).toHaveBeenCalledTimes(1);
    expect(balances.gateway.formattedAvailable).toBe('2');
  });

  test('returns ARC_RPC_COOLDOWN only after every gateway endpoint fails', async () => {
    const { gatewayBuyer, safeArcRpcCall } = loadHarness();

    safeArcRpcCall.mockImplementation(async (_label, fn, options) => {
      expect(options).toMatchObject({ trafficClass: 'gateway_read' });
      const endpoints = [ENDPOINT_A, ENDPOINT_B];

      for (const endpoint of endpoints) {
        try {
          await fn({}, endpoint);
        } catch (_) {
          // continue trying all endpoints
        }
      }

      throw new Error('[ARC_RPC] safeArcRpcCall failed label=gateway_balances');
    });

    await expect(gatewayBuyer.getAgentGatewayBalances({
      id: 'agent-3',
      wallet_address: TEST_WALLET_ADDRESS,
      private_key_encrypted: 'encrypted-key',
    }, {
      chainName: 'Arc Testnet',
      address: TEST_WALLET_ADDRESS,
    })).rejects.toMatchObject({
      code: 'ARC_RPC_COOLDOWN',
      message: 'Arc RPC is cooling down',
      statusCode: 503,
      retryable: true,
      deferred: true,
    });
  });
});
