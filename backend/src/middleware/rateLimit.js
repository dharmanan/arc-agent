'use strict';
const rateLimit = require('express-rate-limit');

function buildRateLimit(options) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
  });
}

/** 100 requests / 15 min per IP  — applied globally */
const globalRateLimit = buildRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: (req) => {
    if (req.path.startsWith('/api/auth/')) return true;
    if (req.method === 'GET' && req.path.startsWith('/api/')) return true;
    return false;
  },
  message: { error: 'Too many requests, please try again later.' },
});

/** 8 requests / 1 min per IP — for passkey challenge creation */
const authStartRateLimit = buildRateLimit({
  windowMs: 60 * 1000,
  max: 8,
  message: { error: 'Too many authentication attempts. Please wait a moment and try again.' },
});

/** 5 failed requests / 10 min per IP — for passkey verification */
const authFinishRateLimit = buildRateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed authentication attempts. Please try again later.' },
});

/** 20 requests / 5 min per IP — for token refresh */
const authRefreshRateLimit = buildRateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: 'Too many session refresh attempts. Please try again later.' },
});

/** 30 requests / 1 min per IP  — for transaction endpoints */
const txRateLimit = buildRateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Transaction rate limit reached.' },
});

module.exports = {
  globalRateLimit,
  authStartRateLimit,
  authFinishRateLimit,
  authRefreshRateLimit,
  txRateLimit,
};
