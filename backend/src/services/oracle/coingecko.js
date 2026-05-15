'use strict';

const axios = require('axios');
const { getCache, setCache, TTL } = require('./cache');
const { recordOracleFallback } = require('./observability');

const BASE_URL = 'https://api.coingecko.com/api/v3';

const COINGECKO_IDS = {
  USDC: 'usd-coin',
  EURC: 'euro-coin',
  USDT: 'tether',
  ETH:  'ethereum',
  BTC:  'bitcoin',
};

const TOKEN_PRICE_FALLBACK_USD = {
  USDC: 1.0,
  USDT: 1.0,
};

function buildFallbackPrice(symbol, fallbackReason) {
  const normalized = symbol.toUpperCase();
  return {
    symbol: normalized,
    usdPrice: TOKEN_PRICE_FALLBACK_USD[normalized] ?? null,
    change24h: 0,
    marketCap: 0,
    source: 'coingecko',
    isFallback: true,
    fallbackReason,
    fetchedAt: new Date().toISOString(),
  };
}

function buildHeaders() {
  const h = {};
  if (process.env.COINGECKO_API_KEY) {
    h['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }
  return h;
}

async function getTokenPrice(symbol) {
  const normalizedSymbol = symbol.toUpperCase();
  const coinId = COINGECKO_IDS[normalizedSymbol];
  if (!coinId) {
    console.warn(`[Oracle/CoinGecko] No ID for ${symbol} — forex fallback will be used`);
    recordOracleFallback('token_price', {
      symbol: normalizedSymbol,
      reason: 'symbol_not_mapped',
      provider: 'coingecko',
    });
    return buildFallbackPrice(normalizedSymbol, 'symbol_not_mapped');
  }

  const cacheKey = `cg_price_${coinId}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  let data;
  try {
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

    data = response.data[coinId];
  } catch (error) {
    recordOracleFallback('token_price', {
      symbol: normalizedSymbol,
      reason: 'api_unreachable',
      detail: error.message,
      provider: 'coingecko',
    });

    const result = buildFallbackPrice(normalizedSymbol, 'api_unreachable');
    setCache(cacheKey, result, TTL.TOKEN_PRICE);
    return result;
  }

  if (!data) {
    recordOracleFallback('token_price', {
      symbol: normalizedSymbol,
      reason: 'no_data',
      provider: 'coingecko',
    });

    const result = buildFallbackPrice(normalizedSymbol, 'no_data');
    setCache(cacheKey, result, TTL.TOKEN_PRICE);
    return result;
  }

  const result = {
    symbol:    normalizedSymbol,
    usdPrice:  data.usd,
    change24h: data.usd_24h_change ?? 0,
    marketCap: data.usd_market_cap  ?? 0,
    source:    'coingecko',
    isFallback: false,
    fallbackReason: null,
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

  const result = {};
  try {
    const ids = validSymbols.map((s) => COINGECKO_IDS[s.toUpperCase()]).join(',');
    const response = await axios.get(`${BASE_URL}/simple/price`, {
      params: { ids, vs_currencies: 'usd', include_24hr_change: true, include_market_cap: true },
      headers: buildHeaders(),
      timeout: 5000,
    });

    validSymbols.forEach((symbol) => {
      const normalizedSymbol = symbol.toUpperCase();
      const coinId = COINGECKO_IDS[normalizedSymbol];
      const data = response.data[coinId];

      if (data) {
        result[normalizedSymbol] = {
          symbol: normalizedSymbol,
          usdPrice: data.usd,
          change24h: data.usd_24h_change ?? 0,
          marketCap: data.usd_market_cap ?? 0,
          source: 'coingecko',
          isFallback: false,
          fallbackReason: null,
          fetchedAt: new Date().toISOString(),
        };
      }
    });
  } catch (error) {
    recordOracleFallback('token_price_batch', {
      symbols: validSymbols.map(symbol => symbol.toUpperCase()).join(','),
      reason: 'api_unreachable',
      detail: error.message,
      provider: 'coingecko',
    });

    validSymbols.forEach((symbol) => {
      const normalizedSymbol = symbol.toUpperCase();
      result[normalizedSymbol] = buildFallbackPrice(normalizedSymbol, 'api_unreachable');
    });
  }

  setCache(cacheKey, result, TTL.TOKEN_PRICE);
  return result;
}

// USDC peg control — how far from 1.000?
async function getUsdcPegDeviation() {
  const price = await getTokenPrice('USDC');
  if (!price || price.usdPrice == null) {
    return {
      price: 1.0,
      deviationPct: 0,
      isDepegRisk: false,
      source: 'coingecko',
      isFallback: true,
      fallbackReason: price?.fallbackReason || 'api_unreachable',
    };
  }

  const deviation = Math.abs(price.usdPrice - 1.0) * 100;
  return {
    price:        price.usdPrice,
    deviationPct: Math.round(deviation * 10000) / 10000,
    isDepegRisk:  deviation > 0.5,
    source:       price.source,
    isFallback:   Boolean(price.isFallback),
    fallbackReason: price.fallbackReason || null,
  };
}

module.exports = { getTokenPrice, getMultipleTokenPrices, getUsdcPegDeviation };
