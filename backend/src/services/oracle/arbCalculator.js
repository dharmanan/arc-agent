'use strict';

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function roundPct(value) {
  return Math.round(value * 10000) / 10000;
}

function normalizeExecutionOptions(options = {}) {
  if (typeof options === 'number') {
    return {
      bridgeFeeUsdc: Number.isFinite(options) ? options : 0,
      gasEstimateUsdc: 0,
      exitFeePct: 0,
      exitVenue: null,
      liveExitQuote: null,
      requireLiveExit: false,
      bridgeRequired: true,
    };
  }

  const bridgeFeeUsdc = Number(options.bridgeFeeUsdc);
  const gasEstimateUsdc = Number(options.gasEstimateUsdc);
  const exitFeePct = Number(options.exitFeePct);

  return {
    bridgeFeeUsdc: Number.isFinite(bridgeFeeUsdc) && bridgeFeeUsdc > 0 ? bridgeFeeUsdc : 0,
    gasEstimateUsdc: Number.isFinite(gasEstimateUsdc) && gasEstimateUsdc > 0 ? gasEstimateUsdc : 0,
    exitFeePct: Number.isFinite(exitFeePct) && exitFeePct > 0 ? exitFeePct : 0,
    exitVenue: options.exitVenue || null,
    liveExitQuote: options.liveExitQuote && typeof options.liveExitQuote === 'object'
      ? options.liveExitQuote
      : null,
    requireLiveExit: options.requireLiveExit === true,
    bridgeRequired: options.bridgeRequired !== false,
  };
}

// FX spread: forex rate vs on-chain pool rate
function calculateSpread(forexRate, poolRate) {
  const spreadPct = ((poolRate - forexRate) / forexRate) * 100;
  return roundPct(spreadPct);
}

function getConfidence(spreadPct, poolLiquidity) {
  const abs = Math.abs(spreadPct);
  if (abs > 0.5 && poolLiquidity > 100_000) return 'HIGH';
  if (abs > 0.2 && poolLiquidity > 50_000)  return 'MEDIUM';
  return 'LOW';
}

// Optimal swap size — max amount that keeps price impact below 1%
function calcOptimalSwapSize(priceImpact1k, priceImpact10k) {
  if (priceImpact10k < 1.0) return 10_000;
  if (priceImpact1k  < 1.0) return 5_000;
  return 1_000;
}

// Profit calculation: enter USDC → buy EURC from pool → back to USDC at forex or live exit quote
function calcArbProfit(amountUsdc, forexRate, poolRate, feePct, options = {}) {
  const execution = normalizeExecutionOptions(options);
  const eurcReceived  = amountUsdc / poolRate;
  const quotedExitUsdc = Number(execution.liveExitQuote?.expectedUsdcOut);
  const hasLiveExitQuote = Number.isFinite(quotedExitUsdc) && quotedExitUsdc > 0;
  const usdcFromEurc  = hasLiveExitQuote
    ? quotedExitUsdc
    : (eurcReceived * forexRate);
  const poolFee       = amountUsdc * (feePct / 100);
  const exitFeeUsdc   = hasLiveExitQuote ? 0 : usdcFromEurc * (execution.exitFeePct / 100);
  const explicitCostsUsdc = poolFee + execution.bridgeFeeUsdc + exitFeeUsdc;
  const grossProfit   = usdcFromEurc - amountUsdc - explicitCostsUsdc;
  const profitPct     = (grossProfit / amountUsdc) * 100;
  const gasEstimate   = execution.gasEstimateUsdc;

  return {
    amountUsdc: roundMoney(amountUsdc),
    entryAmountBase: roundMoney(eurcReceived),
    expectedExitUsdc: roundMoney(usdcFromEurc),
    expectedProfitUsdc: roundMoney(grossProfit),
    expectedProfitPct: roundPct(profitPct),
    netProfitUsdc: roundMoney(grossProfit - gasEstimate),
    gasEstimateUsdc:    gasEstimate,
    costBreakdown: {
      poolFeeUsdc: roundMoney(poolFee),
      bridgeFeeUsdc: roundMoney(execution.bridgeFeeUsdc),
      exitFeeUsdc: roundMoney(exitFeeUsdc),
      gasEstimateUsdc: roundMoney(gasEstimate),
      totalExplicitCostUsdc: roundMoney(explicitCostsUsdc + gasEstimate),
    },
    pricing: {
      baseTokenOut: roundMoney(eurcReceived),
      exitMethod: hasLiveExitQuote ? 'live_exit_quote' : 'forex_reference',
      exitVenue: execution.exitVenue || null,
      bridgeRequired: execution.bridgeRequired !== false,
    },
  };
}

// Build a full arbitrage signal object
function buildArbSignal({
  strategy,
  forexRate,
  poolRate,
  poolFee,
  poolLiquidity,
  priceImpacts,
  baseToken,
  quoteToken,
  execution = {},
}) {
  const executionOptions = normalizeExecutionOptions(execution);
  const spreadPct  = calculateSpread(forexRate, poolRate);
  const confidence = getConfidence(spreadPct, poolLiquidity);
  const optimalSwap = calcOptimalSwapSize(priceImpacts.swap1k, priceImpacts.swap10k);
  const profitCalc  = calcArbProfit(optimalSwap, forexRate, poolRate, poolFee, executionOptions);
  const liveExitQuoteAvailable = Number.isFinite(Number(executionOptions.liveExitQuote?.expectedUsdcOut));
  const liveExitProfitable = executionOptions.liveExitQuote?.profitable === true;
  const executionReadiness = liveExitQuoteAvailable
    ? (liveExitProfitable ? 'live_exit_candidate' : 'blocked_by_live_exit')
    : (executionOptions.requireLiveExit ? 'live_exit_required' : 'simulated_bridge_candidate');
  const found = confidence !== 'LOW'
    && profitCalc.netProfitUsdc > 0
    && executionReadiness !== 'blocked_by_live_exit'
    && executionReadiness !== 'live_exit_required';
  const bridgeSteps = executionOptions.bridgeRequired !== false
    ? [{
        step: 2,
        action: 'BRIDGE',
        asset: baseToken,
        protocol: executionOptions.liveExitQuote?.bridgeProtocol || 'CCTP',
        chain: executionOptions.liveExitQuote?.chainName || 'Sepolia',
      }]
    : [];
  const sellStepNumber = bridgeSteps.length ? 3 : 2;

  const steps = found
    ? [
        {
          step: 1,
          action: 'BUY',
          asset: baseToken,
          protocol: 'Curve (ARC Testnet)',
          amountUsdc: optimalSwap,
          expectedOut: roundMoney(profitCalc.entryAmountBase),
        },
        ...(liveExitQuoteAvailable
          ? [
              ...bridgeSteps,
              {
              step: sellStepNumber,
              action: 'SELL',
              asset: baseToken,
              protocol: executionOptions.exitVenue || 'Live exit quote',
              amountUsdc: optimalSwap,
              expectedOut: roundMoney(profitCalc.expectedExitUsdc),
            }]
          : [{
              step: 2,
              action: 'BRIDGE',
              asset: baseToken,
              protocol: 'CCTP',
              chain: 'Sepolia',
            }, {
              step: 3,
              action: 'SELL',
              asset: baseToken,
              protocol: executionOptions.exitVenue || 'External exit venue',
              amountUsdc: optimalSwap,
              expectedOut: roundMoney(profitCalc.expectedExitUsdc),
            }]),
      ]
    : [];

  const description = executionReadiness === 'blocked_by_live_exit'
    ? `${baseToken} still looks discounted versus real FX, but the current live ${baseToken} -> ${quoteToken} exit quote does not clear costs.`
    : found
      ? `${baseToken} is ${Math.abs(spreadPct).toFixed(2)}% ${spreadPct < 0 ? 'below' : 'above'} real FX rate on Curve`
      : 'No profitable arbitrage opportunity at this time';

  return {
    timestamp: new Date().toISOString(),
    strategy,
    opportunity: {
      found,
      type:               'FX_CURVE_ARB',
      fromChain:          'arc-testnet',
      amountUsdc:         optimalSwap,
      spreadPct,
      description,
      steps,
      expectedProfitUsdc: profitCalc.expectedProfitUsdc,
      expectedProfitPct:  profitCalc.expectedProfitPct,
      gasEstimateUsdc:    profitCalc.gasEstimateUsdc,
      netProfitUsdc:      profitCalc.netProfitUsdc,
      confidence,
      executionReadiness,
      costBreakdown: profitCalc.costBreakdown,
      executionPricing: profitCalc.pricing,
      liveExitQuote: executionOptions.liveExitQuote || null,
      expiresSeconds:     30,
    },
  };
}

module.exports = { calculateSpread, getConfidence, calcOptimalSwapSize, calcArbProfit, buildArbSignal };
