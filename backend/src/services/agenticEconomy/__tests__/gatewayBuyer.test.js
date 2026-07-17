'use strict';

const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const TEST_WALLET_ADDRESS = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c';

function loadHarness() {
  jest.resetModules();

  const gatewayClientCtor = jest.fn();
  const client = {
    getUsdcBalance: jest.fn(),
    getGatewayBalance: jest.fn(),
    deposit: jest.fn(),
  };
  let gatewayFunded = false;

  client.getUsdcBalance.mockResolvedValue({
    balance: 5_000_000n,
    formatted: '5',
  });
  client.getGatewayBalance.mockImplementation(async () => (gatewayFunded
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
  client.deposit.mockImplementation(async (amount) => {
    gatewayFunded = true;
    return { depositTxHash: `deposit-${amount}` };
  });

  const runProtectedWrite = jest.fn(async (options, execute) => execute());
  const arcProvider = {
    getHealthyArcRpcUrl: jest.fn(() => 'https://rpc.testnet.arc.network'),
    isArcRpcRateLimitError: jest.fn((error) => /request limit reached|rate limit|too many requests/i.test(String(error?.message || ''))),
  };

  jest.doMock('@circle-fin/x402-batching/client', () => ({
    GatewayClient: gatewayClientCtor.mockImplementation(() => client),
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
    client,
    runProtectedWrite,
    arcProvider,
    gatewayClientCtor,
  };
}

describe('gatewayBuyer', () => {
  test('serializes auto-warm deposits with the shared wallet transaction lock', async () => {
    const { gatewayBuyer, client, runProtectedWrite } = loadHarness();

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
    expect(client.deposit).toHaveBeenCalledWith('3');
    expect(runProtectedWrite).toHaveBeenCalledTimes(1);
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

  test('does not construct Gateway client or read balances when Arc RPC is cooling down', async () => {
    const {
      gatewayBuyer,
      client,
      arcProvider,
      gatewayClientCtor,
    } = loadHarness();
    arcProvider.getHealthyArcRpcUrl.mockReturnValue(null);

    await expect(gatewayBuyer.ensureGatewayWarmBalance({
      id: 'agent-2',
      wallet_address: TEST_WALLET_ADDRESS,
      private_key_encrypted: 'encrypted-key',
    }, {
      chainName: 'Arc Testnet',
      minAvailableUsdc: 1,
      targetAvailableUsdc: 3,
    })).rejects.toMatchObject({
      code: 'ARC_RPC_COOLDOWN',
      message: 'Arc RPC is cooling down',
      retryable: true,
    });

    expect(gatewayClientCtor).not.toHaveBeenCalled();
    expect(client.getUsdcBalance).not.toHaveBeenCalled();
    expect(client.getGatewayBalance).not.toHaveBeenCalled();
  });

  test('classifies request limit reached as retryable Arc cooldown', async () => {
    const { gatewayBuyer, client } = loadHarness();
    client.getGatewayBalance.mockRejectedValue(new Error('request limit reached'));

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
      retryable: true,
      deferred: true,
    });
  });
});
