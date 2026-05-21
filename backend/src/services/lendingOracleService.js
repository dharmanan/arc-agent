'use strict';

const oracle = require('./oracle');

const DEFAULT_LENDING_PRICE_SNAPSHOT = {
  reference: 'USD',
  fetchedAt: null,
  assets: [
    {
      symbol: 'USDC',
      priceUsd: 1,
      source: 'stable_par',
      isFallback: false,
      fallbackReason: null,
    },
    {
      symbol: 'EURC',
      priceUsd: 1,
      source: 'stable_par_fallback',
      isFallback: true,
      fallbackReason: 'oracle_forex_unavailable',
    },
  ],
};

function _cloneDefaultAsset(symbol) {
  return DEFAULT_LENDING_PRICE_SNAPSHOT.assets.find((asset) => asset.symbol === symbol) || null;
}

async function _readEurcUsdPrice() {
  try {
    const quote = await oracle.getForexRate('EURC', 'USDC');
    const priceUsd = Number(quote?.rate);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error('invalid_eurc_usd_rate');
    }

    return {
      symbol: 'EURC',
      priceUsd,
      source: 'oracle_forex',
      isFallback: false,
      fallbackReason: null,
    };
  } catch (error) {
    return {
      symbol: 'EURC',
      priceUsd: 1,
      source: 'stable_par_fallback',
      isFallback: true,
      fallbackReason: error?.message || 'oracle_forex_unavailable',
    };
  }
}

async function getLendingPriceSnapshot(requestedSymbols = ['USDC', 'EURC']) {
  const normalizedSymbols = Array.from(new Set(
    (Array.isArray(requestedSymbols) ? requestedSymbols : [requestedSymbols])
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean),
  ));

  if (normalizedSymbols.length === 0) {
    normalizedSymbols.push('USDC', 'EURC');
  }

  const eurcQuote = normalizedSymbols.includes('EURC')
    ? await _readEurcUsdPrice()
    : null;

  const assets = normalizedSymbols
    .map((symbol) => {
      if (symbol === 'USDC') {
        return {
          symbol: 'USDC',
          priceUsd: 1,
          source: 'stable_par',
          isFallback: false,
          fallbackReason: null,
        };
      }

      if (symbol === 'EURC') {
        return eurcQuote;
      }

      const fallback = _cloneDefaultAsset(symbol);
      if (fallback) return fallback;

      return {
        symbol,
        priceUsd: 1,
        source: 'unsupported_fallback',
        isFallback: true,
        fallbackReason: 'unsupported_lending_price_asset',
      };
    })
    .filter(Boolean);

  return {
    reference: 'USD',
    fetchedAt: new Date().toISOString(),
    assets,
  };
}

module.exports = {
  DEFAULT_LENDING_PRICE_SNAPSHOT,
  getLendingPriceSnapshot,
};