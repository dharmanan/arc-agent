'use strict';

const {
  calcArbProfit,
  buildArbSignal,
} = require('../arbCalculator');

describe('arbCalculator', () => {
  test('keeps legacy bridge-fee calls backward compatible', () => {
    const result = calcArbProfit(1000, 1.1, 1.0, 1, 0.2);

    expect(result.expectedProfitUsdc).toBeCloseTo(89.8, 6);
    expect(result.costBreakdown.bridgeFeeUsdc).toBeCloseTo(0.2, 6);
    expect(result.pricing.exitMethod).toBe('forex_reference');
  });

  test('marks the opportunity blocked when the live exit quote does not clear costs', () => {
    const signal = buildArbSignal({
      strategy: 'stablecoin_fx',
      forexRate: 1.15,
      poolRate: 1.05,
      poolFee: 1,
      poolLiquidity: 500000,
      priceImpacts: { swap1k: 0.02, swap10k: 0.3 },
      baseToken: 'EURC',
      quoteToken: 'USDC',
      execution: {
        bridgeFeeUsdc: 0.1,
        gasEstimateUsdc: 0.15,
        exitFeePct: 0.3,
        exitVenue: 'Live ARC sell quote',
        liveExitQuote: {
          profitable: false,
          expectedUsdcOut: 995,
          executionRail: 'swap_kit',
        },
      },
    });

    expect(signal.opportunity.executionReadiness).toBe('blocked_by_live_exit');
    expect(signal.opportunity.found).toBe(false);
    expect(signal.opportunity.description).toMatch(/does not clear costs/i);
  });

  test('still returns a simulated bridge candidate when no live exit quote is available', () => {
    const signal = buildArbSignal({
      strategy: 'stablecoin_fx',
      forexRate: 1.15,
      poolRate: 1.05,
      poolFee: 0.04,
      poolLiquidity: 500000,
      priceImpacts: { swap1k: 0.02, swap10k: 0.3 },
      baseToken: 'EURC',
      quoteToken: 'USDC',
      execution: {
        bridgeFeeUsdc: 0.1,
        gasEstimateUsdc: 0.15,
        exitFeePct: 0.1,
        exitVenue: 'External exit venue',
      },
    });

    expect(signal.opportunity.executionReadiness).toBe('simulated_bridge_candidate');
    expect(signal.opportunity.found).toBe(true);
    expect(signal.opportunity.costBreakdown.totalExplicitCostUsdc).toBeGreaterThan(0);
  });

  test('keeps the bridge step when the live exit quote is on an external venue', () => {
    const signal = buildArbSignal({
      strategy: 'stablecoin_fx',
      forexRate: 1.15,
      poolRate: 1.05,
      poolFee: 0.04,
      poolLiquidity: 500000,
      priceImpacts: { swap1k: 0.02, swap10k: 0.3 },
      baseToken: 'EURC',
      quoteToken: 'USDC',
      execution: {
        bridgeFeeUsdc: 0.1,
        gasEstimateUsdc: 0.15,
        exitFeePct: 0,
        exitVenue: 'Uniswap V2 (Sepolia)',
        bridgeRequired: true,
        liveExitQuote: {
          profitable: true,
          expectedUsdcOut: 10200,
          chainName: 'Sepolia',
          bridgeProtocol: 'CCTP',
          executionRail: 'external_uniswap_v2_quote',
        },
      },
    });

    expect(signal.opportunity.executionReadiness).toBe('live_exit_candidate');
    expect(signal.opportunity.found).toBe(true);
    expect(signal.opportunity.steps.map(step => step.action)).toEqual(['BUY', 'BRIDGE', 'SELL']);
    expect(signal.opportunity.steps[1].chain).toBe('Sepolia');
  });
});