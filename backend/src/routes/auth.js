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
const crypto = require('crypto');
const { ethers } = require('ethers');
const {
  authStartRateLimit,
  authFinishRateLimit,
  authRefreshRateLimit,
} = require('../middleware/rateLimit');
const { requireAuth, revokeToken, signToken } = require('../middleware/auth');
const passkeyService = require('../services/passkeyService');
const { recordAuthFailure, recordAuthLockout } = require('../services/securityEventService');
const db = require('../db');

const WALLET_REGISTER_CHALLENGE_PURPOSE = 'wallet_register';
const WALLET_REGISTER_CHALLENGE_TTL_SECONDS = 5 * 60;

function buildPasskeyRegistrationMessage(ownerAddress, challengeId) {
  return [
    'Arc Machina passkey registration',
    `Owner: ${ownerAddress}`,
    `Nonce: ${challengeId}`,
    'Sign this message to prove wallet ownership before creating a passkey.',
  ].join('\n');
}

async function createWalletRegisterChallenge() {
  const challengeId = crypto.randomUUID();

  await db.query(
    `INSERT INTO passkey_challenges (user_id, challenge, purpose, expires_at)
     VALUES (NULL, $1, $2, NOW() + ($3 * INTERVAL '1 second'))`,
    [challengeId, WALLET_REGISTER_CHALLENGE_PURPOSE, WALLET_REGISTER_CHALLENGE_TTL_SECONDS],
  );

  return challengeId;
}

async function consumeWalletRegisterChallenge(challengeId) {
  const { rows } = await db.query(
    `DELETE FROM passkey_challenges
     WHERE user_id IS NULL
       AND challenge = $1
       AND purpose = $2
       AND expires_at > NOW()
     RETURNING challenge`,
    [challengeId, WALLET_REGISTER_CHALLENGE_PURPOSE],
  );

  return rows.length > 0;
}

// ── Register: wallet ownership proof challenge ──────────────────────────────
router.post('/passkey/register/challenge', authStartRateLimit, async (req, res, next) => {
  try {
    const schema = z.object({ ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
    const { ownerAddress } = schema.parse(req.body);
    const addr = ownerAddress.toLowerCase();
    const challengeId = await createWalletRegisterChallenge();

    res.json({
      challengeId,
      message: buildPasskeyRegistrationMessage(addr, challengeId),
      expiresInSeconds: WALLET_REGISTER_CHALLENGE_TTL_SECONDS,
    });
  } catch (err) { next(err); }
});

// ── Register: Step 1 — generate challenge ─────────────────────────────────────
router.post('/passkey/register/start', authStartRateLimit, async (req, res, next) => {
  try {
    const schema = z.object({
      ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      challengeId: z.string().uuid(),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    });
    const { ownerAddress, challengeId, signature } = schema.parse(req.body);
    const addr = ownerAddress.toLowerCase();

    let recoveredAddress;
    try {
      recoveredAddress = ethers.verifyMessage(
        buildPasskeyRegistrationMessage(addr, challengeId),
        signature,
      ).toLowerCase();
    } catch {
      return res.status(401).json({ error: 'invalid_wallet_signature' });
    }

    if (recoveredAddress !== addr) {
      return res.status(401).json({ error: 'invalid_wallet_signature' });
    }

    const challengeConsumed = await consumeWalletRegisterChallenge(challengeId);
    if (!challengeConsumed) {
      return res.status(400).json({ error: 'wallet_challenge_expired' });
    }

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
router.post('/passkey/register/finish', authFinishRateLimit, async (req, res, next) => {
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
router.post('/passkey/login/start', authStartRateLimit, async (req, res, next) => {
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
  } catch (err) {
    if (err.message === 'No passkey registered for this user') {
      return res.status(404).json({ error: 'No passkey registered for this wallet. Please register first.' });
    }
    next(err);
  }
});

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES     = 15;

// ── Login: Step 2 — verify assertion ─────────────────────────────────────────
router.post('/passkey/login/finish', authFinishRateLimit, async (req, res, next) => {
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
      const { rows: [updatedFailureState] } = await db.query(
        `UPDATE users
         SET failed_auth_count = failed_auth_count + 1,
             locked_until = CASE
               WHEN failed_auth_count + 1 >= $1
               THEN NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes'
               ELSE locked_until
             END
         RETURNING failed_auth_count, locked_until::text AS locked_until
         WHERE id = $2`,
        [MAX_FAILED_ATTEMPTS, userId]
      );

      const auditMetadata = {
        failedAttempts: updatedFailureState?.failed_auth_count || null,
        userAgent: req.get('user-agent') || null,
      };
      recordAuthFailure({
        userId,
        ownerAddress: addr,
        ipAddress: req.ip || null,
        metadata: auditMetadata,
      }).catch(() => {});

      if (updatedFailureState?.locked_until && new Date(updatedFailureState.locked_until) > new Date()) {
        recordAuthLockout({
          userId,
          ownerAddress: addr,
          ipAddress: req.ip || null,
          metadata: {
            ...auditMetadata,
            lockoutMinutes: LOCKOUT_MINUTES,
            lockedUntil: updatedFailureState.locked_until,
          },
        }).catch(() => {});
      }

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
router.post('/logout', authRefreshRateLimit, requireAuth, async (req, res, next) => {
  try {
    await revokeToken({ jti: req.auth?.jti, exp: req.auth?.exp });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'token_already_expired') {
      return res.json({ ok: true });
    }
    if (err.message === 'token_missing_jti') {
      return res.status(400).json({ error: 'token_missing_jti' });
    }
    next(err);
  }
});

router.post('/refresh', authRefreshRateLimit, requireAuth, (req, res) => {
  const token = signToken(req.user.userId, req.user.ownerAddress);
  res.json({ token });
});

module.exports = router;
