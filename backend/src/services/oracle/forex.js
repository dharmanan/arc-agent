'use strict';

const axios = require('axios');
const { getCache, setCache, TTL } = require('./cache');
const { recordOracleFallback } = require('./observability');

const BASE_URL = 'https://api.frankfurter.app';

// Stablecoin → real fiat code mapping
const STABLECOIN_TO_FIAT = {
  EURC: 'EUR',
  BRLA: 'BRL',
  MXNB: 'MXN',
  JPYC: 'JPY',
  PHPC: 'PHP',
  USDC: 'USD',
  WUSDC: 'USD',
};

// Fallback rates when API is unreachable (testnet environment)
const FALLBACK_RATES = {
  'EUR/USD': 1.0912,
  'BRL/USD': 0.1821,
  'MXN/USD': 0.0578,
  'JPY/USD': 0.00671,
  'PHP/USD': 0.01751,
};

async function getForexRate(baseStablecoin, quoteStablecoin = 'USDC') {
  const baseFiat  = STABLECOIN_TO_FIAT[baseStablecoin];
  const quoteFiat = STABLECOIN_TO_FIAT[quoteStablecoin];

  if (!baseFiat || !quoteFiat) {
    throw new Error(`Unknown stablecoin: ${baseStablecoin} or ${quoteStablecoin}`);
  }

  const cacheKey = `forex_${baseFiat}_${quoteFiat}`;
  const cached   = getCache(cacheKey);
  if (cached) return cached;

  let finalRate;
  try {
    const baseResponse = await axios.get(`${BASE_URL}/latest?from=${baseFiat}&to=USD`, { timeout: 5000 });
    const baseToUsd = baseResponse.data.rates['USD'];

    finalRate = baseToUsd;
    if (quoteFiat !== 'USD') {
      const quoteResponse = await axios.get(`${BASE_URL}/latest?from=${quoteFiat}&to=USD`, { timeout: 5000 });
      const quoteToUsd = quoteResponse.data.rates['USD'];
      finalRate = baseToUsd / quoteToUsd;
    }
  } catch (err) {
    console.warn(`[Oracle/Forex] ${baseFiat}/${quoteFiat} fetch failed (${err.message}) — using fallback`);
    recordOracleFallback('forex', {
      pair: `${baseStablecoin}/${quoteStablecoin}`,
      reason: 'api_unreachable',
      detail: err.message,
      provider: 'frankfurter',
    });

    const fallbackBaseToUsd = FALLBACK_RATES[`${baseFiat}/USD`] ?? 1.0;
    const fallbackQuoteToUsd = quoteFiat === 'USD'
      ? 1.0
      : (FALLBACK_RATES[`${quoteFiat}/USD`] ?? 1.0);
    finalRate = fallbackBaseToUsd / fallbackQuoteToUsd;

    const result = {
      base: baseStablecoin, quote: quoteStablecoin,
      rate: Math.round(finalRate * 100000) / 100000,
      source: 'frankfurter',
      isFallback: true,
      fallbackReason: 'api_unreachable',
      fetchedAt: new Date().toISOString(),
    };
    setCache(cacheKey, result, TTL.FX_RATE);
    return result;
  }

  const result = {
    base:      baseStablecoin,
    quote:     quoteStablecoin,
    rate:      Math.round(finalRate * 100000) / 100000,
    source:    'frankfurter',
    isFallback: false,
    fallbackReason: null,
    fetchedAt: new Date().toISOString(),
  };

  setCache(cacheKey, result, TTL.FX_RATE);
  return result;
}

async function getAllForexRates() {
  const pairs = [
    ['EURC', 'USDC'],
    ['BRLA', 'USDC'],
    ['MXNB', 'USDC'],
    ['JPYC', 'USDC'],
  ];

  const results = await Promise.allSettled(
    pairs.map(([base, quote]) => getForexRate(base, quote)),
  );

  const rates = {};
  results.forEach((result, i) => {
    const key = `${pairs[i][0]}/${pairs[i][1]}`;
    if (result.status === 'fulfilled') {
      rates[key] = result.value;
    } else {
      console.error(`[Oracle/Forex] Failed to fetch ${key}:`, result.reason?.message);
    }
  });

  return rates;
}

module.exports = { getForexRate, getAllForexRates };
