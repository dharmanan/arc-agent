'use strict';

const path = require('path');
const assert = require('node:assert/strict');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);

const executionService = require('../src/services/agenticEconomy/agenticTaskExecutionService');
const nativeLendingRiskService = require('../src/services/nativeLendingRiskService');
const { evaluateStableAutomationPolicy } = require('../src/services/stableAutomationPolicy');
const { evaluateCirbtcLpAutomationPolicy } = require('../src/services/cirbtcLpAutomationPolicy');
const { evaluateLendingAutomationPolicy } = require('../src/services/lendingAutomationPolicy');

const SMOKE_WALLET_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const MOCK_ASSETS = {
  USDC: {
    symbol: 'USDC',
    assetAddress: process.env.USDC_ADDRESS_ARC || '0x0000000000000000000000000000000000001001',
    decimals: 6,
  },
  EURC: {
    symbol: 'EURC',
    assetAddress: process.env.EURC_ADDRESS_ARC || '0x0000000000000000000000000000000000001002',
    decimals: 6,
  },
};

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
  };
}

function buildStableCurveFixture() {
  return evaluateStableAutomationPolicy({
    agent: { max_trade_usdc: 200 },
    forexRate: { rate: 1.001, isFallback: false },
    poolState: {
      impliedRate: 1.0005,
      liquidityState: 'active',
      reserves: {
        token0: 12_000,
        token1: 11_500,
      },
      priceImpact: {
        swap1k: 0.18,
      },
    },
    pricingPool: {
      protocol: 'curve',
      key: 'EURC-USDC',
      baseToken: { symbol: 'EURC' },
      quoteToken: { symbol: 'USDC' },
    },
    swapPool: {
      protocol: 'curve',
      key: 'USDC-EURC',
      baseToken: { symbol: 'USDC' },
      quoteToken: { symbol: 'EURC' },
      address: '0x0000000000000000000000000000000000002001',
      source: 'verified_default',
    },
    walletBalances: {
      usdc: 90,
      eurc: 6,
    },
    walletReserveUsdc: 10,
    requestedAmountUsdc: 25,
    position: null,
    marketAnalysis: {
      recordedAt: new Date().toISOString(),
      engine: 'smoke_fixture',
      signal: {
        lane: 'stable_curve',
        stableLpMinAllocationPct: 20,
        stableLpTargetAllocationPct: 25,
        stableLpMaxAllocationPct: 30,
      },
    },
  });
}

function buildCirbtcFixture() {
  return evaluateCirbtcLpAutomationPolicy({
    pairContexts: [
      {
        stableToken: 'USDC',
        walletStableBalance: 24,
        pool: {
          protocol: 'uniswap_v2_like',
          poolModel: 'constant_product',
          key: 'USDC-CIRBTC',
          address: '0x0000000000000000000000000000000000003001',
          feePct: 0.3,
          baseToken: { symbol: 'USDC' },
          quoteToken: { symbol: 'CIRBTC' },
        },
        poolState: {
          liquidityState: 'active',
          impliedRate: 0.00002,
          fee: 0.3,
          reserves: {
            token0: 2_000,
            token1: 0.04,
          },
          priceImpact: {
            swap1k: 0.55,
          },
        },
        position: null,
        growthHistory: {
          totalAddsToday: 0,
          lastAddAt: null,
        },
      },
    ],
  });
}

function buildLendingHealthySurface() {
  return {
    execution: {
      ready: true,
      source: 'smoke_fixture',
      buildState: 'live_v1',
    },
    risk: {
      healthFactor: 1.62,
      totalBorrowUsd: 42,
      totalSuppliedUsd: 120,
    },
    recovery: {
      status: 'idle',
      execute: false,
      steps: [],
    },
    collateralTopUp: {
      status: 'idle',
      execute: false,
      steps: [],
    },
    safeExit: {
      status: 'idle',
      execute: false,
      steps: [],
    },
    assets: [
      {
        symbol: 'USDC',
        price: { priceUsd: 1 },
        position: { borrowAmount: 42, borrowUsd: 42 },
        wallet: { amount: 2, amountUsd: 2 },
        reserve: { totalSupplied: 1_000, totalBorrowed: 400 },
      },
    ],
  };
}

function buildLendingDeleverageSurface() {
  return {
    execution: {
      ready: true,
      source: 'smoke_fixture',
      buildState: 'live_v1',
    },
    risk: {
      healthFactor: 1.05,
      totalBorrowUsd: 50,
      totalSuppliedUsd: 110,
    },
    recovery: {
      status: 'execute',
      execute: true,
      currentHealthFactor: 1.05,
      targetHealthFactor: 1.25,
      projectedHealthFactor: 1.29,
      repayUsdNeeded: 15,
      repayUsdPlanned: 12,
      repayUsdShortfall: 3,
      steps: [
        {
          action: 'repay',
          asset: 'USDC',
          amount: '12',
          usdAmount: 12,
        },
      ],
    },
    collateralTopUp: {
      status: 'idle',
      execute: false,
      steps: [],
    },
    safeExit: {
      status: 'idle',
      execute: false,
      steps: [],
    },
    assets: [
      {
        symbol: 'USDC',
        price: { priceUsd: 1 },
        position: { borrowAmount: 50, borrowUsd: 50 },
        wallet: { amount: 12, amountUsd: 12 },
        reserve: { totalSupplied: 1_000, totalBorrowed: 860 },
      },
    ],
  };
}

function buildForcedReductionSurface() {
  return {
    execution: {
      ready: true,
      source: 'smoke_fixture',
      buildState: 'live_v1',
    },
    risk: {
      healthFactor: 1.04,
      totalBorrowUsd: 55,
      totalSuppliedUsd: 118,
    },
    recovery: {
      status: 'blocked',
      execute: false,
      currentHealthFactor: 1.04,
      targetHealthFactor: 1.25,
      projectedHealthFactor: 1.04,
      repayUsdNeeded: 20,
      repayUsdPlanned: 0,
      repayUsdShortfall: 20,
      steps: [],
    },
    collateralTopUp: {
      status: 'blocked',
      execute: false,
      collateralUsdNeeded: 20,
      collateralUsdPlanned: 0,
      collateralUsdShortfall: 20,
      steps: [],
    },
    safeExit: {
      status: 'idle',
      execute: false,
      steps: [],
    },
    assets: [
      {
        symbol: 'USDC',
        price: { priceUsd: 1 },
        position: { borrowAmount: 55, borrowUsd: 55 },
        wallet: { amount: 0, amountUsd: 0 },
        reserve: { totalSupplied: 1_000, totalBorrowed: 850 },
      },
    ],
  };
}

function buildStableCurveLpPosition() {
  return {
    poolKey: 'USDC-EURC',
    lpToken: {
      balance: '4.5',
    },
    valuation: {
      totalUsd: 36,
    },
    underlying: [
      {
        symbol: 'USDC',
        amount: '22',
        usdValue: 22,
      },
      {
        symbol: 'EURC',
        amount: '14',
        usdValue: 14,
      },
    ],
  };
}

function createManualValidation(action, assetSymbol, amount) {
  const asset = MOCK_ASSETS[assetSymbol] || MOCK_ASSETS.USDC;
  return {
    ok: true,
    asset,
    surface: {
      execution: {
        source: 'smoke_fixture',
        buildState: 'live_v1',
      },
      risk: {
        band: action === 'borrow' ? 'warning' : 'healthy',
        healthFactor: action === 'borrow' ? 1.34 : 1.86,
        availableBorrowUsd: 48,
      },
    },
    verdict: {
      detail: null,
      action,
      amount,
    },
  };
}

function createDeleverageValidation() {
  return {
    ok: true,
    surface: {
      execution: {
        source: 'smoke_fixture',
        buildState: 'live_v1',
      },
      assets: [MOCK_ASSETS.USDC, MOCK_ASSETS.EURC],
    },
    verdict: {
      status: 'execute',
      currentHealthFactor: 1.05,
      targetHealthFactor: 1.25,
      projectedHealthFactor: 1.29,
      repayUsdNeeded: 15,
      repayUsdPlanned: 12,
      repayUsdShortfall: 3,
      steps: [
        {
          action: 'repay',
          asset: 'USDC',
          amount: '12',
          usdAmount: 12,
        },
      ],
    },
  };
}

async function withMockedLendingGuards(fn) {
  const originalManual = nativeLendingRiskService.guardAgentManualLendingAction;
  const originalDeleverage = nativeLendingRiskService.guardAgentEmergencyDeleverage;

  nativeLendingRiskService.guardAgentManualLendingAction = async ({ action, asset, amount }) => {
    const normalizedAction = String(action || '').trim().toLowerCase();
    const fallbackAsset = normalizedAction === 'borrow' || normalizedAction === 'repay' ? 'EURC' : 'USDC';
    const assetSymbol = String(asset || fallbackAsset).trim().toUpperCase();
    return createManualValidation(normalizedAction, assetSymbol, String(amount ?? '0'));
  };

  nativeLendingRiskService.guardAgentEmergencyDeleverage = async () => createDeleverageValidation();

  try {
    return await fn();
  } finally {
    nativeLendingRiskService.guardAgentManualLendingAction = originalManual;
    nativeLendingRiskService.guardAgentEmergencyDeleverage = originalDeleverage;
  }
}

async function runScenario(label, fn) {
  try {
    const details = await fn();
    return {
      label,
      ok: true,
      details,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      error: error.stack || error.message,
    };
  }
}

async function main() {
  const options = parseArgs();
  const smokeAgent = {
    id: 'defi-smoke-agent',
    walletAddress: SMOKE_WALLET_ADDRESS,
    wallet_address: SMOKE_WALLET_ADDRESS,
  };

  const results = [];

  results.push(await runScenario('stable_curve_policy_add', async () => {
    const stable = buildStableCurveFixture();
    assert.equal(stable.verdict.execute, true, 'Stable Curve fixture should execute.');
    assert.equal(stable.verdict.operationType, 'add_liquidity');
    assert.equal(stable.verdict.actionParams?.mode, 'balanced');
    assert.ok(Number(stable.verdict.actionParams?.amountUsdc) > 0, 'Balanced stable add should include a USDC side.');
    assert.ok(Number(stable.verdict.actionParams?.amountEurc) > 0, 'Balanced stable add should include a EURC side.');
    assert.ok(Number(stable.verdict.suggestedAmountUsdc) >= 10, 'Stable Curve deploy size should stay positive.');

    return {
      operationType: stable.verdict.operationType,
      suggestedAmountUsdc: stable.verdict.suggestedAmountUsdc,
      addMode: stable.verdict.actionParams?.mode,
      reason: stable.verdict.reason,
    };
  }));

  results.push(await runScenario('cirbtc_direct_pair_policy_add', async () => {
    const cirbtc = buildCirbtcFixture();
    assert.equal(cirbtc.verdict.execute, true, 'cirBTC direct-pair fixture should execute.');
    assert.equal(cirbtc.verdict.operationType, 'add_liquidity');
    assert.equal(cirbtc.verdict.actionParams?.stableToken, 'USDC');
    assert.equal(cirbtc.metrics.selectedPoolKey, 'USDC-CIRBTC');

    return {
      operationType: cirbtc.verdict.operationType,
      selectedPoolKey: cirbtc.metrics.selectedPoolKey,
      suggestedAmountUsdc: cirbtc.verdict.suggestedAmountUsdc,
      reason: cirbtc.verdict.reason,
    };
  }));

  results.push(await runScenario('lending_manual_task_dry_runs', async () => withMockedLendingGuards(async () => {
    const supply = await executionService.executeNativeLendingSupplyTask({
      agent: smokeAgent,
      params: { asset: 'USDC', amount: '5' },
      dryRun: true,
    });
    assert.equal(supply.ok, true);
    assert.equal(supply.payload?.action, 'supply');
    assert.equal(supply.payload?.asset, 'USDC');
    assert.equal(supply.payload?.dryRun, true);

    const withdraw = await executionService.executeNativeLendingWithdrawTask({
      agent: smokeAgent,
      params: { asset: 'USDC', amount: '2' },
      dryRun: true,
    });
    assert.equal(withdraw.ok, true);
    assert.equal(withdraw.payload?.action, 'withdraw');
    assert.equal(withdraw.payload?.amount, '2');

    const borrow = await executionService.executeNativeLendingBorrowTask({
      agent: smokeAgent,
      params: { asset: 'EURC', amount: '4' },
      dryRun: true,
    });
    assert.equal(borrow.ok, true);
    assert.equal(borrow.payload?.action, 'borrow');
    assert.equal(borrow.payload?.asset, 'EURC');

    const repay = await executionService.executeNativeLendingRepayTask({
      agent: smokeAgent,
      params: { asset: 'EURC', amount: '4' },
      dryRun: true,
    });
    assert.equal(repay.ok, true);
    assert.equal(repay.payload?.action, 'repay');
    assert.equal(repay.payload?.asset, 'EURC');

    return {
      supply: supply.payload?.summary,
      withdraw: withdraw.payload?.summary,
      borrow: borrow.payload?.summary,
      repay: repay.payload?.summary,
    };
  })));

  results.push(await runScenario('lending_deleverage_dry_run', async () => withMockedLendingGuards(async () => {
    const deleverage = await executionService.executeNativeLendingEmergencyDeleverageTask({
      agent: smokeAgent,
      dryRun: true,
    });

    assert.equal(deleverage.ok, true);
    assert.equal(deleverage.payload?.action, 'deleverage');
    assert.equal(deleverage.payload?.dryRun, true);
    assert.equal(Array.isArray(deleverage.payload?.plannedSteps), true);
    assert.equal(deleverage.payload?.plannedSteps?.[0]?.asset, 'USDC');

    return {
      summary: deleverage.payload?.summary,
      repayUsdPlanned: deleverage.payload?.repayUsdPlanned,
      plannedSteps: deleverage.payload?.plannedSteps,
    };
  })));

  results.push(await runScenario('lending_guard_deleverage_policy', async () => {
    const verdict = evaluateLendingAutomationPolicy({
      lendingSurface: buildLendingDeleverageSurface(),
    });

    assert.equal(verdict.verdict.execute, true);
    assert.equal(verdict.verdict.operationType, 'deleverage');
    assert.equal(verdict.verdict.actionAssetSymbol, 'USDC');

    return {
      operationType: verdict.verdict.operationType,
      suggestedAmountUsdc: verdict.verdict.suggestedAmountUsdc,
      reason: verdict.verdict.reason,
    };
  }));

  results.push(await runScenario('lending_guard_forced_lp_reduce_policy', async () => {
    const verdict = evaluateLendingAutomationPolicy({
      lendingSurface: buildForcedReductionSurface(),
      stableCurvePosition: buildStableCurveLpPosition(),
    });

    assert.equal(verdict.verdict.execute, true);
    assert.equal(verdict.verdict.operationType, 'forced_lp_reduce');
    assert.equal(verdict.verdict.actionParams?.tokenOut, 'USDC');
    assert.equal(verdict.metrics?.forcedLpReduction?.source, 'stable_curve');

    return {
      operationType: verdict.verdict.operationType,
      suggestedAmountUsdc: verdict.verdict.suggestedAmountUsdc,
      actionParams: verdict.verdict.actionParams,
      forcedLpReduction: verdict.metrics?.forcedLpReduction,
    };
  }));

  results.push(await runScenario('lending_guard_noop_policy', async () => {
    const verdict = evaluateLendingAutomationPolicy({
      lendingSurface: buildLendingHealthySurface(),
    });

    assert.equal(verdict.verdict.execute, false);
    assert.equal(verdict.verdict.operationType, null);
    assert.match(verdict.verdict.reason, /holding because health factor and reserve utilization/i);

    return {
      execute: verdict.verdict.execute,
      blockedBy: verdict.verdict.blockedBy,
      reason: verdict.verdict.reason,
    };
  }));

  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const summary = {
    timestamp: new Date().toISOString(),
    suite: 'defi_full_smoke_v1',
    passed,
    failed,
    results,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const result of results) {
      if (result.ok) {
        console.log(`PASS ${result.label}`);
      } else {
        console.log(`FAIL ${result.label}`);
        console.log(result.error);
      }
    }
    console.log('');
    console.log(JSON.stringify(summary, null, 2));
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});