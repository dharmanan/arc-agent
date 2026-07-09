'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET = process.env.JWT_SECRET;
const TEST_REVOKED_TOKENS = new Map();
if (!SECRET || SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}

function getTokenTtlSeconds(exp) {
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
}

async function isTokenRevoked(jti) {
  if (!jti) return false;

  if (process.env.NODE_ENV === 'test') {
    const expiresAt = TEST_REVOKED_TOKENS.get(jti);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      TEST_REVOKED_TOKENS.delete(jti);
      return false;
    }
    return true;
  }

  const { rows } = await db.query(
    'SELECT 1 FROM revoked_tokens WHERE jti = $1 AND expires_at > NOW() LIMIT 1',
    [jti],
  );
  return rows.length > 0;
}

async function revokeToken({ jti, exp }) {
  if (!jti) {
    throw new Error('token_missing_jti');
  }

  const ttlSeconds = getTokenTtlSeconds(exp);
  if (ttlSeconds <= 0) {
    throw new Error('token_already_expired');
  }

  if (process.env.NODE_ENV === 'test') {
    TEST_REVOKED_TOKENS.set(jti, Date.now() + ttlSeconds * 1000);
    return ttlSeconds;
  }

  await db.query(
    `INSERT INTO revoked_tokens (jti, expires_at)
     VALUES ($1, to_timestamp($2))
     ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [jti, Number(exp)],
  );
  return ttlSeconds;
}

/**
 * Express middleware — verifies the Bearer JWT token.
 * Attaches { userId, ownerAddress } to req.user on success.
 */
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    try {
      const revoked = await isTokenRevoked(payload.jti);
      if (revoked) {
        return res.status(401).json({ error: 'Session expired' });
      }
    } catch (storeError) {
      console.error('[AUTH] revoked-token store check failed:', storeError.message || storeError);
      return res.status(503).json({ error: 'Auth session store unavailable' });
    }

    req.user = { userId: payload.sub, ownerAddress: payload.ownerAddress };
    req.auth = {
      token,
      jti: payload.jti || null,
      exp: payload.exp || null,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Sign a JWT for the given user.
 * @param {string} userId      - UUID
 * @param {string} ownerAddress - lowercase hex address
 */
function signToken(userId, ownerAddress) {
  return jwt.sign(
    { ownerAddress },
    SECRET,
    {
      subject: userId,
      jwtid: crypto.randomUUID(),
      algorithm: 'HS256',
      expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    },
  );
}

module.exports = {
  requireAuth,
  revokeToken,
  signToken,
};
