'use strict';

/**
 * ARC DeFi Oracle — service barrel
 *
 * Exports all oracle sub-services for use by agentQueue and future routes.
 * All services cache results internally (TTL varies per data type).
 */

const forex        = require('./forex');
const defiLlama    = require('./defiLlama');
const coingecko    = require('./coingecko');
const arcRpc       = require('./arcRpc');
const arbCalculator = require('./arbCalculator');
const { TTL, getCache, setCache, clearCache, getCacheStats } = require('./cache');

module.exports = {
  // Forex rates (frankfurter.app · fallback included)
  getForexRate:        forex.getForexRate,
  getAllForexRates:     forex.getAllForexRates,

  // DeFi yield data (DefiLlama · fallback included)
  getYieldOpportunities: defiLlama.getYieldOpportunities,
  getProtocolTvl:        defiLlama.getProtocolTvl,

  // Token prices (CoinGecko · optional API key via COINGECKO_API_KEY)
  getTokenPrice:          coingecko.getTokenPrice,
  getMultipleTokenPrices: coingecko.getMultipleTokenPrices,
  getUsdcPegDeviation:    coingecko.getUsdcPegDeviation,

  // On-chain Curve/Aave/Band data (requires ARC_RPC_URL)
  getCurvePoolState:   arcRpc.getCurvePoolState,
  getAaveReserveData:  arcRpc.getAaveReserveData,
  getBandFeed:         arcRpc.getBandFeed,
  getMockPoolState:    arcRpc.getMockPoolState,

  // Arbitrage calculations (pure functions, no I/O)
  calculateSpread:       arbCalculator.calculateSpread,
  getConfidence:         arbCalculator.getConfidence,
  calcOptimalSwapSize:   arbCalculator.calcOptimalSwapSize,
  calcArbProfit:         arbCalculator.calcArbProfit,
  buildArbSignal:        arbCalculator.buildArbSignal,

  // Cache utilities
  TTL, getCache, setCache, clearCache, getCacheStats,
};
