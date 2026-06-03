'use strict';

const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const TEST_WALLET_ADDRESS = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c';

function loadHarness() {
  jest.resetModules();

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

  jest.doMock('@circle-fin/x402-batching/client', () => ({
    GatewayClient: jest.fn(() => client),
  }));
  jest.doMock('../../cryptoService', () => ({
    decrypt: jest.fn(() => TEST_PRIVATE_KEY),
  }));
  jest.doMock('../../txSecurityService', () => ({
    runProtectedWrite,
  }));
  jest.doMock('../logger', () => ({
    logGateway: jest.fn(),
  }));

  const gatewayBuyer = require('../gatewayBuyer');
  return { gatewayBuyer, client, runProtectedWrite };
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
});
