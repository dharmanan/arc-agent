'use strict';
/**
 * POST /api/auth/passkey/register/start
 * POST /api/auth/passkey/register/finish
 * POST /api/auth/passkey/login/start
 * POST /api/auth/passkey/login/finish
 * POST /api/auth/refresh
 */
const router   = require('express').Router();
const { z }    = require('zod');
const { authRateLimit } = require('../middleware/rateLimit');
const { requireAuth, signToken } = require('../middleware/auth');
const passkeyService = require('../services/passkeyService');
const db = require('../db');

router.use(authRateLimit);

// ── Register: Step 1 — generate challenge ─────────────────────────────────────
router.post('/passkey/register/start', async (req, res, next) => {
  try {
    const schema = z.object({ ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
    const { ownerAddress } = schema.parse(req.body);
    const addr = ownerAddress.toLowerCase();

    // Upsert user row
    const { rows } = await db.query(
      `INSERT INTO users (owner_address) VALUES ($1)
       ON CONFLICT (owner_address) DO UPDATE SET owner_address = EXCLUDED.owner_address
       RETURNING id`,
      [addr],
    );
    const userId = rows[0].id;

    const options = await passkeyService.generateRegistrationOptions(userId, addr);
    res.json(options);
  } catch (err) { next(err); }
});

// ── Register: Step 2 — verify attestation ────────────────────────────────────
router.post('/passkey/register/finish', async (req, res, next) => {
  try {
    const schema = z.object({
      ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      credential:   z.object({}).passthrough(),
      deviceName:   z.string().max(100).optional(),
    });
    const { ownerAddress, credential, deviceName } = schema.parse(req.body);
    const addr = ownerAddress.toLowerCase();

    const { rows } = await db.query('SELECT id FROM users WHERE owner_address = $1', [addr]);
    if (!rows.length) return res.status(404).json({ error: 'User not found, start registration first' });
    const userId = rows[0].id;

    await passkeyService.verifyRegistration(userId, credential, deviceName, req.get('origin'));
    const token = signToken(userId, addr);
    res.json({ token, userId });
  } catch (err) { next(err); }
});

// ── Login: Step 1 — generate challenge ───────────────────────────────────────
router.post('/passkey/login/start', async (req, res, next) => {
  try {
    const schema = z.object({ ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
    const { ownerAddress } = schema.parse(req.body);
    const addr = ownerAddress.toLowerCase();

    const { rows } = await db.query(
      'SELECT id, locked_until FROM users WHERE owner_address = $1', [addr]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not registered' });

    // Lockout check — return generic message to avoid user enumeration
    if (rows[0].locked_until && new Date(rows[0].locked_until) > new Date()) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }

    const options = await passkeyService.generateAuthenticationOptions(rows[0].id);
    res.json(options);
  } catch (err) { next(err); }
});

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES     = 15;

// ── Login: Step 2 — verify assertion ─────────────────────────────────────────
router.post('/passkey/login/finish', async (req, res, next) => {
  try {
    const schema = z.object({
      ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      credential:   z.object({}).passthrough(),
    });
    const { ownerAddress, credential } = schema.parse(req.body);
    const addr = ownerAddress.toLowerCase();

    const { rows } = await db.query(
      'SELECT id, failed_auth_count, locked_until FROM users WHERE owner_address = $1', [addr]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const { id: userId, locked_until } = rows[0];

    // Lockout check
    if (locked_until && new Date(locked_until) > new Date()) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }

    credential._requestOrigin = req.get('origin');
    try {
      await passkeyService.verifyAuthentication(userId, credential);
    } catch (verifyErr) {
      // Increment failure counter; lock if threshold reached
      await db.query(
        `UPDATE users
         SET failed_auth_count = failed_auth_count + 1,
             locked_until = CASE
               WHEN failed_auth_count + 1 >= $1
               THEN NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes'
               ELSE locked_until
             END
         WHERE id = $2`,
        [MAX_FAILED_ATTEMPTS, userId]
      );
      return res.status(401).json({ error: 'Passkey verification failed' });
    }

    // Success — reset failure counter
    await db.query(
      'UPDATE users SET failed_auth_count = 0, locked_until = NULL WHERE id = $1', [userId]
    );
    const token = signToken(userId, addr);
    res.json({ token, userId });
  } catch (err) { next(err); }
});

// ── Refresh token ─────────────────────────────────────────────────────────────
router.post('/refresh', requireAuth, (req, res) => {
  const token = signToken(req.user.userId, req.user.ownerAddress);
  res.json({ token });
});

module.exports = router;
