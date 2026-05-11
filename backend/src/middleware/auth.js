'use strict';
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}

/**
 * Express middleware — verifies the Bearer JWT token.
 * Attaches { userId, ownerAddress } to req.user on success.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.user = { userId: payload.sub, ownerAddress: payload.ownerAddress };
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
    { subject: userId, algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '24h' },
  );
}

module.exports = { requireAuth, signToken };
