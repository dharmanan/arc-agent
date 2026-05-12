'use strict';

const axios = require('axios');
const { getCache, setCache, TTL } = require('./cache');

const BASE_URL = 'https://api.coingecko.com/api/v3';

const COINGECKO_IDS = {
  USDC: 'usd-coin',
  EURC: 'euro-coin',
  USDT: 'tether',
  ETH:  'ethereum',
  BTC:  'bitcoin',
};

function buildHeaders() {
  const h = {};
  if (process.env.COINGECKO_API_KEY) {
    h['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }
  return h;
}

async function getTokenPrice(symbol) {
  const coinId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!coinId) {
    console.warn(`[Oracle/CoinGecko] No ID for ${symbol} — forex fallback will be used`);
    return null;
  }

  const cacheKey = `cg_price_${coinId}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const response = await axios.get(`${BASE_URL}/simple/price`, {
    params: {
      ids:                coinId,
      vs_currencies:      'usd',
      include_24hr_change: true,
      include_market_cap:  true,
    },
    headers: buildHeaders(),
    timeout: 5000,
  });

  const data = response.data[coinId];
  if (!data) return null;

  const result = {
    symbol:    symbol.toUpperCase(),
    usdPrice:  data.usd,
    change24h: data.usd_24h_change ?? 0,
    marketCap: data.usd_market_cap  ?? 0,
    source:    'coingecko',
    fetchedAt: new Date().toISOString(),
  };

  setCache(cacheKey, result, TTL.TOKEN_PRICE);
  return result;
}

async function getMultipleTokenPrices(symbols) {
  const validSymbols = symbols.filter((s) => COINGECKO_IDS[s.toUpperCase()]);
  if (validSymbols.length === 0) return {};

  const cacheKey = `cg_multi_${validSymbols.slice().sort().join('_')}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  const ids      = validSymbols.map((s) => COINGECKO_IDS[s.toUpperCase()]).join(',');
  const response = await axios.get(`${BASE_URL}/simple/price`, {
    params: { ids, vs_currencies: 'usd', include_24hr_change: true, include_market_cap: true },
    headers: buildHeaders(),
    timeout: 5000,
  });

  const result = {};
  validSymbols.forEach((symbol) => {
    const coinId = COINGECKO_IDS[symbol.toUpperCase()];
    const data   = response.data[coinId];
    if (data) {
      result[symbol.toUpperCase()] = {
        symbol:    symbol.toUpperCase(),
        usdPrice:  data.usd,
        change24h: data.usd_24h_change ?? 0,
        marketCap: data.usd_market_cap  ?? 0,
        source:    'coingecko',
        fetchedAt: new Date().toISOString(),
      };
    }
  });

  setCache(cacheKey, result, TTL.TOKEN_PRICE);
  return result;
}

// USDC peg control — how far from 1.000?
async function getUsdcPegDeviation() {
  const price = await getTokenPrice('USDC');
  if (!price) return { price: 1.0, deviationPct: 0, isDepegRisk: false };

  const deviation = Math.abs(price.usdPrice - 1.0) * 100;
  return {
    price:        price.usdPrice,
    deviationPct: Math.round(deviation * 10000) / 10000,
    isDepegRisk:  deviation > 0.5,
  };
}

module.exports = { getTokenPrice, getMultipleTokenPrices, getUsdcPegDeviation };
