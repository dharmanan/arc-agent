'use strict';
const rateLimit = require('express-rate-limit');

/** 100 requests / 15 min per IP  — applied globally */
const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.path.startsWith('/api/auth/')) return true;
    if (req.method === 'GET' && req.path.startsWith('/api/')) return true;
    return false;
  },
  message: { error: 'Too many requests, please try again later.' },
});

/** 10 requests / 1 min per IP  — for auth endpoints */
const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts.' },
});

/** 30 requests / 1 min per IP  — for transaction endpoints */
const txRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Transaction rate limit reached.' },
});

module.exports = { globalRateLimit, authRateLimit, txRateLimit };
