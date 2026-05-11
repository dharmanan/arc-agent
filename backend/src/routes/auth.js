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

    const { rows } = await db.query('SELECT id FROM users WHERE owner_address = $1', [addr]);
    if (!rows.length) return res.status(404).json({ error: 'User not registered' });
    const userId = rows[0].id;

    const options = await passkeyService.generateAuthenticationOptions(userId);
    res.json(options);
  } catch (err) { next(err); }
});

// ── Login: Step 2 — verify assertion ─────────────────────────────────────────
router.post('/passkey/login/finish', async (req, res, next) => {
  try {
    const schema = z.object({
      ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      credential:   z.object({}).passthrough(),
    });
    const { ownerAddress, credential } = schema.parse(req.body);
    const addr = ownerAddress.toLowerCase();

    const { rows } = await db.query('SELECT id FROM users WHERE owner_address = $1', [addr]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const userId = rows[0].id;

    credential._requestOrigin = req.get('origin');
    await passkeyService.verifyAuthentication(userId, credential);
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
