'use strict';

const axios = require('axios');
const { getCache, setCache, TTL } = require('./cache');
const { recordOracleFallback } = require('./observability');

const BASE_URL   = 'https://api.llama.fi';
const YIELDS_URL = 'https://yields.llama.fi';

const ARC_PROTOCOLS = ['aave', 'maple', 'morpho', 'centrifuge', 'superform'];

function assessRisk(tvl, apy) {
  if (tvl > 100_000_000 && apy < 8)  return 'LOW';
  if (tvl > 10_000_000  && apy < 15) return 'LOW-MEDIUM';
  if (tvl > 1_000_000   && apy < 30) return 'MEDIUM';
  return 'HIGH';
}

function getFallbackYields(asset, fallbackReason = 'api_unreachable') {
  const now = new Date().toISOString();
  return [
    { name: 'Aave V3',       chain: 'ARC Testnet', apy: 4.2, tvlUsd: 45_000_000, asset, risk: 'LOW',        contractHint: 'deploy-from-arcscan', source: 'defillama', isFallback: true, fallbackReason, fetchedAt: now },
    { name: 'Morpho',        chain: 'ARC Testnet', apy: 5.1, tvlUsd: 8_900_000,  asset, risk: 'LOW-MEDIUM', contractHint: 'deploy-from-arcscan', source: 'defillama', isFallback: true, fallbackReason, fetchedAt: now },
    { name: 'Maple Finance', chain: 'ARC Testnet', apy: 6.8, tvlUsd: 12_500_000, asset, risk: 'MEDIUM',     contractHint: 'deploy-from-arcscan', source: 'defillama', isFallback: true, fallbackReason, fetchedAt: now },
  ];
}

async function getYieldOpportunities(asset = 'USDC', minApy = 1.0) {
  const cacheKey = `llama_yields_${asset}_${minApy}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  let pools = [];
  try {
    const response = await axios.get(`${YIELDS_URL}/pools`, { timeout: 8000 });
    pools = response.data.data;
  } catch (error) {
    console.warn('[Oracle/DefiLlama] API unreachable — using fallback yield data');
    recordOracleFallback('yield_rank', {
      asset,
      reason: 'api_unreachable',
      detail: error.message,
      provider: 'defillama',
    });
    const result = getFallbackYields(asset, 'api_unreachable');
    setCache(cacheKey, result, TTL.YIELD_RANK);
    return result;
  }

  const filtered = pools
    .filter((pool) => {
      const symbolMatch =
        pool.symbol?.toUpperCase().includes(asset.toUpperCase()) ||
        pool.underlyingTokens?.some((t) => t.toUpperCase().includes(asset.toUpperCase()));
      const apyOk      = (pool.apy ?? 0) >= minApy;
      const protocolOk = ARC_PROTOCOLS.some((p) => pool.project?.toLowerCase().includes(p));
      return symbolMatch && apyOk && protocolOk;
    })
    .slice(0, 10)
    .map((pool) => ({
      name:         pool.project,
      chain:        pool.chain,
      apy:          Math.round((pool.apy ?? 0) * 100) / 100,
      tvlUsd:       pool.tvlUsd ?? 0,
      asset:        pool.symbol ?? asset,
      risk:         assessRisk(pool.tvlUsd ?? 0, pool.apy ?? 0),
      contractHint: pool.pool,
      source:       'defillama',
      isFallback:   false,
      fallbackReason: null,
      fetchedAt:    new Date().toISOString(),
    }))
    .sort((a, b) => b.apy - a.apy);

  if (filtered.length === 0) {
    recordOracleFallback('yield_rank', {
      asset,
      reason: 'no_matching_protocols',
      provider: 'defillama',
    });
  }

  const result = filtered.length > 0 ? filtered : getFallbackYields(asset, 'no_matching_protocols');
  setCache(cacheKey, result, TTL.YIELD_RANK);
  return result;
}

async function getProtocolTvl(protocol) {
  const cacheKey = `llama_tvl_${protocol}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  try {
    const response   = await axios.get(`${BASE_URL}/protocol/${protocol}`, { timeout: 5000 });
    const tvlHistory = response.data.tvl;
    if (!tvlHistory?.length) return null;

    const latest = tvlHistory[tvlHistory.length - 1];
    const prev   = tvlHistory[tvlHistory.length - 2];
    const change24h = prev
      ? ((latest.totalLiquidityUSD - prev.totalLiquidityUSD) / prev.totalLiquidityUSD) * 100
      : 0;

    const result = {
      protocol,
      tvl:      latest.totalLiquidityUSD,
      change24h: Math.round(change24h * 100) / 100,
      source: 'defillama',
      isFallback: false,
      fallbackReason: null,
    };

    setCache(cacheKey, result, TTL.YIELD_RANK);
    return result;
  } catch (error) {
    recordOracleFallback('protocol_tvl', {
      protocol,
      reason: 'api_unreachable',
      detail: error.message,
      provider: 'defillama',
    });

    const result = {
      protocol,
      tvl: null,
      change24h: null,
      source: 'defillama',
      isFallback: true,
      fallbackReason: 'api_unreachable',
      fetchedAt: new Date().toISOString(),
    };
    setCache(cacheKey, result, TTL.YIELD_RANK);
    return result;
  }
}

module.exports = { getYieldOpportunities, getProtocolTvl };
