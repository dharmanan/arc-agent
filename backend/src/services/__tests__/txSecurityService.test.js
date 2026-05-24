'use strict';

const TEST_WALLET_ADDRESS = '0x00000000000000000000000000000000000000AA';
const TEST_TX_HASH = `0x${'1'.repeat(64)}`;
const SECOND_TX_HASH = `0x${'2'.repeat(64)}`;

function loadHarness() {
  jest.resetModules();
  process.env.NODE_ENV = 'test';

  let service;
  jest.isolateModules(() => {
    service = require('../txSecurityService');
  });

  service.__resetForTests();
  return service;
}

describe('txSecurityService', () => {
  test('blocks replay of a recently submitted protected write', async () => {
    const service = loadHarness();

    await service.runProtectedWrite({
      chainName: 'Arc Testnet',
      walletAddress: TEST_WALLET_ADDRESS,
      operation: 'gateway_nano_payment',
      replayFingerprint: ['same-payment'],
      replayTtlSec: 60,
    }, async () => ({ txHash: TEST_TX_HASH }));

    await expect(service.runProtectedWrite({
      chainName: 'Arc Testnet',
      walletAddress: TEST_WALLET_ADDRESS,
      operation: 'gateway_nano_payment',
      replayFingerprint: ['same-payment'],
      replayTtlSec: 60,
    }, async () => ({ txHash: SECOND_TX_HASH }))).rejects.toMatchObject({
      code: 'TX_REPLAY_BLOCKED',
      status: 409,
    });
  });

  test('rejects concurrent writes on the same chain for one agent', async () => {
    const service = loadHarness();

    let unblockFirstWrite;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });

    const firstWrite = service.runProtectedWrite({
      chainName: 'Arc Testnet',
      walletAddress: TEST_WALLET_ADDRESS,
      operation: 'agent_send',
      replayFingerprint: ['first-send'],
    }, async () => {
      markStarted();
      return new Promise((resolve) => {
        unblockFirstWrite = () => resolve({ txHash: TEST_TX_HASH });
      });
    });

    await started;

    await expect(service.runProtectedWrite({
      chainName: 'Arc Testnet',
      walletAddress: TEST_WALLET_ADDRESS,
      operation: 'agent_send',
      replayFingerprint: ['second-send'],
    }, async () => ({ txHash: SECOND_TX_HASH }))).rejects.toMatchObject({
      code: 'AGENT_TX_BUSY',
      status: 409,
    });

    unblockFirstWrite();
    await firstWrite;
  });

  test('estimates gas before sending protected contract writes', async () => {
    const service = loadHarness();
    const tx = {
      hash: TEST_TX_HASH,
      wait: jest.fn().mockResolvedValue({ hash: TEST_TX_HASH }),
    };
    const transfer = jest.fn().mockResolvedValue(tx);
    transfer.estimateGas = jest.fn().mockResolvedValue(1000n);

    const result = await service.sendProtectedContractTx({
      contract: {
        runner: { address: TEST_WALLET_ADDRESS },
        transfer,
      },
      methodName: 'transfer',
      args: [TEST_WALLET_ADDRESS, 1n],
      chainName: 'Arc Testnet',
      walletAddress: TEST_WALLET_ADDRESS,
      operation: 'agent_send',
      replayFingerprint: ['gas-check'],
    });

    expect(transfer.estimateGas).toHaveBeenCalledWith(TEST_WALLET_ADDRESS, 1n, {});
    expect(transfer).toHaveBeenCalledWith(
      TEST_WALLET_ADDRESS,
      1n,
      expect.objectContaining({ gasLimit: 1250n }),
    );
    expect(result.gasEstimate).toBe(1000n);
    expect(result.gasLimit).toBe(1250n);
    expect(tx.wait).toHaveBeenCalledWith(1);
  });
});