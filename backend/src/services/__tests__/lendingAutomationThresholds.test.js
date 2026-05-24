'use strict';

describe('lending automation minimum action threshold', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.LENDING_AUTOMATION_MIN_ACTION_USD = '1';
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  test('holds utilization repay below the minimum automatic action size', () => {
    let evaluateLendingAutomationPolicy;
    jest.isolateModules(() => {
      ({ evaluateLendingAutomationPolicy } = require('../lendingAutomationPolicy'));
    });

    const verdict = evaluateLendingAutomationPolicy({
      lendingSurface: {
        risk: {
          healthFactor: 1.5,
          totalBorrowUsd: 10,
          totalSuppliedUsd: 100,
        },
        recovery: { status: 'not_required', execute: false, repayUsdNeeded: 0, repayUsdShortfall: 0, steps: [] },
        collateralTopUp: { status: 'not_required', execute: false, collateralUsdNeeded: 0, steps: [] },
        safeExit: { status: 'idle' },
        execution: { ready: true },
        assets: [
          {
            symbol: 'EURC',
            price: { priceUsd: 1 },
            position: { borrowAmount: 10, borrowUsd: 10 },
            wallet: { amount: 10, amountUsd: 10 },
            reserve: { totalSupplied: 100, totalBorrowed: 85.5 },
          },
        ],
      },
    });

    expect(verdict.verdict.execute).toBe(false);
    expect(verdict.verdict.reason).toMatch(/below the minimum automatic action size/i);
    expect(verdict.metrics.requiredRepayUsd).toBeUndefined();
    expect(verdict.metrics.minAutomationActionUsd).toBe(1);
  });

  test('guards tiny deleverage and collateral top-up plans below one dollar', () => {
    let evaluateEmergencyDeleverage;
    let evaluateCollateralTopUp;

    jest.isolateModules(() => {
      ({ evaluateEmergencyDeleverage, evaluateCollateralTopUp } = require('../nativeLendingRiskService'));
    });

    const deleverage = evaluateEmergencyDeleverage({
      risk: { healthFactor: 1.1, totalBorrowUsd: 100, liquidationCapacityUsd: 129.61 },
      assets: [
        {
          symbol: 'EURC',
          wallet: { amount: 5, amountUsd: 5 },
          position: { borrowAmount: 100, borrowUsd: 100 },
          price: { priceUsd: 1 },
        },
      ],
    });

    const topUp = evaluateCollateralTopUp({
      risk: { healthFactor: 1.1, totalBorrowUsd: 10, liquidationCapacityUsd: 12.7 },
      assets: [
        {
          symbol: 'USDC',
          wallet: { amount: 10, amountUsd: 10 },
          price: { priceUsd: 1 },
          reserve: { supported: true, paused: false, collateralEnabled: true, liquidationThresholdBps: 9000 },
        },
      ],
    });

    expect(deleverage.execute).toBe(false);
    expect(deleverage.status).toBe('dust_guarded');
    expect(deleverage.repayUsdNeeded).toBe(0.3);

    expect(topUp.execute).toBe(false);
    expect(topUp.status).toBe('dust_guarded');
    expect(topUp.collateralUsdNeeded).toBe(0.3);
  });
});