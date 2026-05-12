'use strict';

const NodeCache = require('node-cache');

// TTL seconds — different per endpoint type
const cache = new NodeCache({ useClones: false });

const TTL = {
  FX_RATE:    30,  // Forex rates 30s
  POOL_STATE: 15,  // Onchain pool 15s
  YIELD_RANK: 60,  // APY data 60s
  ARB_SIGNAL: 20,  // Arb opportunity 20s
  TOKEN_PRICE: 45, // Token prices 45s
};

function getCache(key) {
  return cache.get(key);
}

function setCache(key, value, ttlSeconds) {
  cache.set(key, value, ttlSeconds);
}

function clearCache(key) {
  if (key) {
    cache.del(key);
  } else {
    cache.flushAll();
  }
}

function getCacheStats() {
  return cache.getStats();
}

module.exports = { TTL, getCache, setCache, clearCache, getCacheStats };
