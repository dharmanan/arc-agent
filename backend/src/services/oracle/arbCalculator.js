'use strict';

// FX spread: forex rate vs on-chain pool rate
function calculateSpread(forexRate, poolRate) {
  const spreadPct = ((poolRate - forexRate) / forexRate) * 100;
  return Math.round(spreadPct * 10000) / 10000;
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

// Profit calculation: enter USDC → buy EURC from pool → back to USDC at forex
function calcArbProfit(amountUsdc, forexRate, poolRate, feePct, bridgeFeeUsdc = 0) {
  const eurcReceived  = amountUsdc / poolRate;
  const usdcFromEurc  = eurcReceived * forexRate;
  const poolFee       = amountUsdc * (feePct / 100);
  const grossProfit   = usdcFromEurc - amountUsdc - poolFee - bridgeFeeUsdc;
  const profitPct     = (grossProfit / amountUsdc) * 100;
  const gasEstimate   = 0; // testnet: 0; mainnet: calculate separately

  return {
    expectedProfitUsdc: Math.round(grossProfit * 100) / 100,
    expectedProfitPct:  Math.round(profitPct * 10000) / 10000,
    netProfitUsdc:      Math.round((grossProfit - gasEstimate) * 100) / 100,
    gasEstimateUsdc:    gasEstimate,
  };
}

// Build a full arbitrage signal object
function buildArbSignal({ strategy, forexRate, poolRate, poolFee, poolLiquidity, priceImpacts, baseToken, quoteToken }) {
  const spreadPct  = calculateSpread(forexRate, poolRate);
  const confidence = getConfidence(spreadPct, poolLiquidity);
  const optimalSwap = calcOptimalSwapSize(priceImpacts.swap1k, priceImpacts.swap10k);
  const profitCalc  = calcArbProfit(optimalSwap, forexRate, poolRate, poolFee);
  const found       = confidence !== 'LOW' && profitCalc.netProfitUsdc > 0;

  const steps = found
    ? [
        { step: 1, action: 'BUY',    asset: baseToken,  protocol: 'Curve (ARC Testnet)',  amountUsdc: optimalSwap,    expectedOut: Math.round((optimalSwap / poolRate) * 1000) / 1000 },
        { step: 2, action: 'BRIDGE', asset: baseToken,  protocol: 'CCTP',                 chain: 'Sepolia' },
        { step: 3, action: 'SELL',   asset: baseToken,  protocol: 'Uniswap (Sepolia)',    amountUsdc: optimalSwap,    expectedOut: Math.round(optimalSwap + profitCalc.expectedProfitUsdc) },
      ]
    : [];

  return {
    timestamp: new Date().toISOString(),
    strategy,
    opportunity: {
      found,
      type:               'FX_CURVE_ARB',
      description:        found
        ? `${baseToken} is ${Math.abs(spreadPct).toFixed(2)}% ${spreadPct < 0 ? 'below' : 'above'} real FX rate on Curve`
        : 'No profitable arbitrage opportunity at this time',
      steps,
      expectedProfitUsdc: profitCalc.expectedProfitUsdc,
      expectedProfitPct:  profitCalc.expectedProfitPct,
      gasEstimateUsdc:    profitCalc.gasEstimateUsdc,
      netProfitUsdc:      profitCalc.netProfitUsdc,
      confidence,
      expiresSeconds:     30,
    },
  };
}

module.exports = { calculateSpread, getConfidence, calcOptimalSwapSize, calcArbProfit, buildArbSignal };
