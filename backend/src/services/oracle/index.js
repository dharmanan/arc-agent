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
const pools        = require('./pools');
const observability = require('./observability');
const alerts       = require('./alerts');
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
  getConstantProductPoolState: arcRpc.getConstantProductPoolState,
  getAaveReserveData:  arcRpc.getAaveReserveData,
  getBandFeed:         arcRpc.getBandFeed,
  getMockPoolState:    arcRpc.getMockPoolState,
  resolveOraclePoolStateTarget: pools.resolveOraclePoolStateTarget,
  resolveCurvePool:    pools.resolveCurvePool,
  resolveDirectSwapFallbackPool: pools.resolveDirectSwapFallbackPool,
  normalizeCurvePoolKey: pools.normalizeCurvePoolKey,
  normalizePoolVenue: pools.normalizePoolVenue,
  getOracleObservabilitySummary: observability.getOracleObservabilitySummary,
  recordOracleFallback: observability.recordOracleFallback,
  recordOracleSignal: observability.recordOracleSignal,
  dispatchOracleTestAlert: alerts.dispatchOracleTestAlert,

  // Arbitrage calculations (pure functions, no I/O)
  calculateSpread:       arbCalculator.calculateSpread,
  getConfidence:         arbCalculator.getConfidence,
  calcOptimalSwapSize:   arbCalculator.calcOptimalSwapSize,
  calcArbProfit:         arbCalculator.calcArbProfit,
  buildArbSignal:        arbCalculator.buildArbSignal,

  // Cache utilities
  TTL, getCache, setCache, clearCache, getCacheStats,
};
