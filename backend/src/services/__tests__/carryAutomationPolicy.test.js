'use strict';

process.env.CARRY_AUTOMATION_MIN_ACTION_USD = '25';
process.env.CARRY_AUTOMATION_MIN_NET_APY_PCT = '1.5';
process.env.CARRY_AUTOMATION_TARGET_HF = '1.45';
process.env.CARRY_AUTOMATION_UNWIND_HF = '1.2';
process.env.CARRY_AUTOMATION_MAX_AVAILABLE_BORROW_SHARE_PCT = '35';
process.env.CARRY_AUTOMATION_MAX_POSITION_USD = '250';

const { evaluateCarryAutomationPolicy } = require('../carryAutomationPolicy');

function buildCarryFixture(overrides = {}) {
  const eurcBorrowUsd = overrides.eurcBorrowUsd ?? 0.040402;
  const eurcBorrowAmount = overrides.eurcBorrowAmount ?? 0.034844;

  return {
    lendingSurface: {
      execution: { ready: true },
      risk: {
        availableBorrowUsd: 559.99088,
        healthFactor: 15063.3432,
        liquidationCapacityUsd: 608.589191,
      },
      assets: [
        {
          symbol: 'USDC',
          price: { priceUsd: 1 },
          wallet: { amount: 2471.243969 },
          reserve: {
            supported: true,
            paused: false,
            borrowEnabled: true,
            borrowAprPct: 2,
            borrowApyPct: 2.0201,
            supplyAprPct: 0,
            supplyApyPct: 0,
            utilizationPct: 0,
          },
          position: {
            borrowAmount: 0,
            borrowUsd: 0,
          },
        },
        {
          symbol: 'EURC',
          price: { priceUsd: 1.1595 },
          wallet: { amount: 95.578191 },
          reserve: {
            supported: true,
            paused: false,
            borrowEnabled: true,
            borrowAprPct: 2.0035,
            borrowApyPct: 2.0236,
            supplyAprPct: 0.0006,
            supplyApyPct: 0.0006,
            utilizationPct: 0.0348,
          },
          position: {
            borrowAmount: eurcBorrowAmount,
            borrowUsd: eurcBorrowUsd,
          },
        },
      ],
    },
    stablePoolState: {
      liquidityState: 'active',
      fee: 1,
      priceImpact: {
        swap10k: 0.2482,
      },
    },
    stableCurvePosition: overrides.stableCurvePosition === undefined
      ? {
          valuation: { totalUsd: 77.0669 },
          lpToken: { balance: '64.214574185315994054' },
        }
      : overrides.stableCurvePosition,
    walletBalances: {
      usdc: 2471.243969,
      eurc: 95.578191,
    },
    maxTradeUsdc: 250,
    walletReserveUsdc: 40,
  };
}

describe('carryAutomationPolicy', () => {
  test('treats dust borrow plus existing LP as a manual stable LP conflict, not active carry', () => {
    const policy = evaluateCarryAutomationPolicy(buildCarryFixture());

    expect(policy.verdict.execute).toBe(false);
    expect(policy.verdict.blockedBy).toBe('manual_stable_lp_conflict');
    expect(policy.metrics.carryState).toBe('manual_lp_conflict');
    expect(policy.metrics.currentCarryModeActive).toBe(false);
  });

  test('ignores dust borrow when no LP position exists and can still open a fresh carry leg', () => {
    const policy = evaluateCarryAutomationPolicy(buildCarryFixture({ stableCurvePosition: null }));

    expect(policy.verdict.execute).toBe(true);
    expect(policy.verdict.operationType).toBe('open_carry');
    expect(['USDC', 'EURC']).toContain(policy.verdict.actionAssetSymbol);
    expect(Number(policy.verdict.suggestedAmountUsdc)).toBeGreaterThanOrEqual(25);
    expect(Number(policy.verdict.actionParams?.borrowAmount)).toBeGreaterThan(0);
  });

  test('does not treat zero-debt health factor as an unwind blocker for a fresh carry open', () => {
    const fixture = buildCarryFixture({
      stableCurvePosition: null,
      eurcBorrowUsd: 0,
      eurcBorrowAmount: 0,
    });

    fixture.lendingSurface.risk.healthFactor = 0;

    const policy = evaluateCarryAutomationPolicy(fixture);

    expect(policy.verdict.execute).toBe(true);
    expect(policy.verdict.operationType).toBe('open_carry');
    expect(policy.checks.currentHealth.passed).toBe(true);
  });

  test('holds active carry when the LP already covers the visible debt', () => {
    const policy = evaluateCarryAutomationPolicy(buildCarryFixture({
      eurcBorrowUsd: 40,
      eurcBorrowAmount: 34.482759,
    }));

    expect(policy.metrics.currentCarryModeActive).toBe(true);
    expect(policy.verdict.execute).toBe(false);
    expect(policy.verdict.operationType).toBeNull();
    expect(policy.metrics.lpShortfallUsd).toBe(0);
  });

  test('marks carry as active for exclusivity only when managed state is active-like', () => {
    const activePolicy = evaluateCarryAutomationPolicy(buildCarryFixture({
      eurcBorrowUsd: 40,
      eurcBorrowAmount: 34.482759,
    }));
    expect(activePolicy.metrics.carryState).toBe('active');

    const inactivePolicy = evaluateCarryAutomationPolicy(buildCarryFixture({
      stableCurvePosition: null,
      eurcBorrowUsd: 0,
      eurcBorrowAmount: 0,
    }));
    expect(inactivePolicy.metrics.carryState).toBe('inactive');
  });

  test('deploys wallet balance only when borrowed carry is sitting outside the LP', () => {
    const policy = evaluateCarryAutomationPolicy(buildCarryFixture({
      eurcBorrowUsd: 40,
      eurcBorrowAmount: 34.482759,
      stableCurvePosition: {
        valuation: { totalUsd: 0 },
        lpToken: { balance: '0' },
      },
    }));

    expect(policy.metrics.currentDebtIdle).toBe(true);
    expect(policy.metrics.lpShortfallUsd).toBe(40);
    expect(policy.verdict.execute).toBe(true);
    expect(policy.verdict.operationType).toBe('deploy_wallet_balance');
    expect(Number(policy.verdict.suggestedAmountUsdc)).toBe(40);
  });
});