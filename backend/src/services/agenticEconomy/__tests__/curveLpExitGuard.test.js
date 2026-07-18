'use strict';

const TEST_AGENT = {
  id: 'agent-curve',
  wallet_address: '0x00000000000000000000000000000000000000AA',
  private_key_encrypted: 'enc-key',
  slippage_percent: '0.5',
};

const TEST_POOL = {
  address: '0x2D84D79C852f6842AbE0304b70bBaA1506AdD457',
  source: 'verified_default',
  baseToken: {
    symbol: 'USDC',
    address: '0x3600000000000000000000000000000000000000',
    index: 0,
    decimals: 6,
  },
  quoteToken: {
    symbol: 'EURC',
    address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    index: 1,
    decimals: 6,
  },
};

function buildSnapshot(lpBalance = '163.160304697860494645') {
  return {
    positions: [
      {
        poolAddress: TEST_POOL.address,
        poolKey: 'USDC-EURC',
        lpToken: {
          balance: lpBalance,
        },
      },
    ],
    warnings: [],
    stale: true,
    dataFreshness: 'cached',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };
}

function loadHarness({
  snapshot = buildSnapshot(),
  liveRead = {
    ok: true,
    balance: '10',
    executionRead: {
      source: 'live_rpc',
      stale: false,
      executable: true,
      checkedAt: '2026-07-18T10:01:00.000Z',
    },
  },
  beforeExecuteResult = null,
} = {}) {
  jest.resetModules();

  const protocols = {
    buildCurveRemoveLiquidityOneCoinPreflight: jest.fn().mockResolvedValue({
      simulationFingerprint: '0xfingerprint',
      calldataHash: '0xcalldatahash',
    }),
    executeCurveRemoveLiquidityOneCoin: jest.fn().mockResolvedValue({
      txHash: '0xabc',
      amountOut: '12.3',
      minAmountOut: '12.0',
      simulationFingerprint: '0xfingerprint',
      calldataHash: '0xcalldatahash',
    }),
  };

  const positionsService = {
    getWalletPositions: jest.fn().mockResolvedValue(snapshot),
    readCurveLiveLpBalance: jest.fn().mockResolvedValue(liveRead),
    invalidateWalletPositionCache: jest.fn().mockReturnValue({ removedSnapshotKeys: 1, removedAgentCaches: 0 }),
  };

  jest.doMock('../../protocols', () => protocols);
  jest.doMock('../../positionsService', () => positionsService);
  jest.doMock('../../oracle', () => ({
    resolveCurvePool: jest.fn((poolKey) => {
      if (poolKey === 'USDC-EURC' || poolKey === 'EURC-USDC') {
        return TEST_POOL;
      }
      return null;
    }),
  }));
  jest.doMock('../../cryptoService', () => ({
    decrypt: jest.fn().mockReturnValue('0x59c6995e998f97a5a0044966f0945382d7e7b6f90f7cf8f0e39d5f1d2f8b3d4a'),
  }));

  jest.doMock('../../agentWalletService', () => ({}));
  jest.doMock('../../nativeLendingRiskService', () => ({}));
  jest.doMock('../../arcProvider', () => ({
    createArcRpcProvider: jest.fn(),
  }));
  jest.doMock('../../agentService', () => ({
    readOracleEntryCooldown: jest.fn(),
  }));
  jest.doMock('../../oracle/pools', () => ({
    resolveDirectSwapFallbackPool: jest.fn(),
  }));
  jest.doMock('../../oracleStrategyPolicy', () => ({
    evaluateOracleStrategyPolicy: jest.fn(),
  }));

  let service;
  jest.isolateModules(() => {
    service = require('../agenticTaskExecutionService');
  });

  return {
    service,
    protocols,
    positionsService,
    beforeExecute: jest.fn().mockImplementation(async () => beforeExecuteResult),
  };
}

describe('agenticTaskExecutionService curve LP exit live guard', () => {
  test('skips remove when snapshot shows LP but live balance is zero and invalidates cache', async () => {
    const { service, protocols, positionsService } = loadHarness({
      liveRead: {
        ok: true,
        balance: '0',
        executionRead: {
          source: 'live_rpc',
          stale: false,
          executable: true,
          checkedAt: '2026-07-18T10:01:00.000Z',
        },
      },
    });

    const result = await service.executeCurveLiquidityRemoveTask({
      agent: TEST_AGENT,
      params: {
        lpAmount: '163.160304697860494645',
        tokenOut: 'USDC',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'no_live_lp_position',
      status: 'skipped',
    });
    expect(positionsService.invalidateWalletPositionCache).toHaveBeenCalledWith(TEST_AGENT.wallet_address, {
      poolKeys: ['USDC-EURC'],
    });
    expect(protocols.buildCurveRemoveLiquidityOneCoinPreflight).not.toHaveBeenCalled();
    expect(protocols.executeCurveRemoveLiquidityOneCoin).not.toHaveBeenCalled();
  });

  test('returns deferred when live LP read is unavailable due to ARC RPC cooldown', async () => {
    const { service, protocols } = loadHarness({
      liveRead: {
        ok: false,
        reason: 'live_lp_balance_unavailable',
        errorCode: 'ARC_RPC_COOLDOWN',
        error: 'Arc RPC is cooling down',
        executionRead: {
          source: 'live_rpc',
          stale: false,
          executable: false,
          checkedAt: '2026-07-18T10:01:00.000Z',
        },
      },
    });

    const result = await service.executeCurveLiquidityRemoveTask({
      agent: TEST_AGENT,
      params: {
        lpAmount: '163.160304697860494645',
        tokenOut: 'USDC',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'live_lp_balance_unavailable',
      status: 'deferred',
      errorCode: 'ARC_RPC_COOLDOWN',
    });
    expect(protocols.buildCurveRemoveLiquidityOneCoinPreflight).not.toHaveBeenCalled();
    expect(protocols.executeCurveRemoveLiquidityOneCoin).not.toHaveBeenCalled();
  });

  test('uses live LP balance when live balance is lower than snapshot and recomputes preflight', async () => {
    const { service, protocols } = loadHarness({
      liveRead: {
        ok: true,
        balance: '120.5',
        executionRead: {
          source: 'live_rpc',
          stale: false,
          executable: true,
          checkedAt: '2026-07-18T10:01:00.000Z',
        },
      },
    });

    const result = await service.executeCurveLiquidityRemoveTask({
      agent: TEST_AGENT,
      params: {
        lpAmount: '163.160304697860494645',
        tokenOut: 'USDC',
      },
    });

    expect(protocols.buildCurveRemoveLiquidityOneCoinPreflight).toHaveBeenCalledWith(expect.objectContaining({
      poolAddress: TEST_POOL.address,
      lpAmount: '120.5',
      indexOut: 0,
    }));
    expect(protocols.executeCurveRemoveLiquidityOneCoin).toHaveBeenCalledWith(expect.objectContaining({
      lpAmount: '120.5',
      preflight: expect.objectContaining({
        simulationFingerprint: '0xfingerprint',
        calldataHash: '0xcalldatahash',
      }),
    }));
    expect(result).toMatchObject({
      ok: true,
      payload: {
        liveLpBalance: '120.5',
        snapshotLpBalance: '163.160304697860494645',
        simulationFingerprint: '0xfingerprint',
        calldataHash: '0xcalldatahash',
      },
    });
  });

  test('skips before simulation when cooldown callback blocks identical fingerprint', async () => {
    const { service, protocols, beforeExecute } = loadHarness({
      liveRead: {
        ok: true,
        balance: '120.5',
        executionRead: {
          source: 'live_rpc',
          stale: false,
          executable: true,
          checkedAt: '2026-07-18T10:01:00.000Z',
        },
      },
      beforeExecuteResult: {
        skip: true,
        reason: 'stable_lp_exit_failure_cooldown',
        retryAfterMs: 1000,
      },
    });

    const result = await service.executeCurveLiquidityRemoveTask({
      agent: TEST_AGENT,
      params: {
        lpAmount: '120.5',
        tokenOut: 'USDC',
      },
      beforeExecute,
    });

    expect(beforeExecute).toHaveBeenCalledWith(expect.objectContaining({
      simulationFingerprint: '0xfingerprint',
      errorCode: 'TX_SIMULATION_FAILED',
    }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'stable_lp_exit_failure_cooldown',
      status: 'skipped',
      retryAfterMs: 1000,
    });
    expect(protocols.executeCurveRemoveLiquidityOneCoin).not.toHaveBeenCalled();
  });
});
