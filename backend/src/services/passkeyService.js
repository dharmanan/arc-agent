'use strict';
/**
 * WebAuthn / FIDO2 Passkey service using @simplewebauthn/server.
 * Challenges are stored in PostgreSQL with a 5-min TTL.
 */
const {
  generateRegistrationOptions: swanGenReg,
  verifyRegistrationResponse,
  generateAuthenticationOptions: swanGenAuth,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const db = require('../db');

const RP_ID     = process.env.WEBAUTHN_RP_ID     || 'localhost';
const RP_NAME   = process.env.WEBAUTHN_RP_NAME   || 'Arc Machina';
// Support multiple origins (comma-separated) + auto-detect dev Codespace origins
const _configuredOrigins = (process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
function getAllowedOrigins(requestOrigin) {
  if (!requestOrigin) return _configuredOrigins;
  // In dev, also accept the actual request origin if it looks like Codespace/localhost
  if (process.env.NODE_ENV !== 'production') {
    if (requestOrigin.endsWith('.app.github.dev') ||
        requestOrigin.startsWith('http://localhost:') ||
        requestOrigin.startsWith('https://localhost:')) {
      return [..._configuredOrigins, requestOrigin];
    }
  }
  return _configuredOrigins;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function saveChallenge(userId, challenge, purpose) {
  // Delete any previous challenge for this user+purpose first (UPSERT semantics)
  // This prevents stale challenges from being replayed by password managers
  await db.query(
    `DELETE FROM passkey_challenges WHERE user_id = $1 AND purpose = $2`,
    [userId, purpose],
  );
  await db.query(
    `INSERT INTO passkey_challenges (user_id, challenge, purpose)
     VALUES ($1, $2, $3)`,
    [userId, challenge, purpose],
  );
}

async function consumeChallenge(userId, purpose) {
  const { rows } = await db.query(
    `DELETE FROM passkey_challenges
     WHERE user_id = $1 AND purpose = $2 AND expires_at > NOW()
     RETURNING challenge`,
    [userId, purpose],
  );
  if (!rows.length) throw new Error('Challenge expired or not found');
  return rows[0].challenge;
}

async function getCredentials(userId) {
  const { rows } = await db.query(
    'SELECT credential_id, public_key, counter FROM passkey_credentials WHERE user_id = $1',
    [userId],
  );
  return rows.map(r => ({
    id:        r.credential_id,
    publicKey: Buffer.from(r.public_key, 'base64url'),
    counter:   Number(r.counter),
    transports: [],
  }));
}

// ── Registration ──────────────────────────────────────────────────────────────
async function generateRegistrationOptions(userId, ownerAddress) {
  const existingCreds = await getCredentials(userId);

  const options = await swanGenReg({
    rpName:              RP_NAME,
    rpID:                RP_ID,
    userID:              Buffer.from(userId),
    userName:            ownerAddress,
    userDisplayName:     ownerAddress,
    attestationType:     'none',
    excludeCredentials:  existingCreds.map(c => ({ id: c.id, type: 'public-key' })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',   // Force device-local: Face ID, Touch ID, Windows Hello
      residentKey:             'preferred',  // Prefer discoverable credential; 'required' breaks Safari iOS 15
      requireResidentKey:      false,        // false = max compatibility across Safari versions
      userVerification:        'preferred',  // preferred = works on Safari iOS 15 and 16+
    },
    supportedAlgorithmIDs: [-7, -257],    // ES256, RS256
  });

  await saveChallenge(userId, options.challenge, 'register');
  return options;
}

async function verifyRegistration(userId, credentialResponse, deviceName, requestOrigin) {
  const expectedChallenge = await consumeChallenge(userId, 'register');

  const verification = await verifyRegistrationResponse({
    response:           credentialResponse,
    expectedChallenge,
    expectedOrigin:     getAllowedOrigins(requestOrigin),
    expectedRPID:       RP_ID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey registration verification failed');
  }

  const { credential } = verification.registrationInfo;

  await db.query(
    `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, device_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (credential_id) DO UPDATE
       SET counter = EXCLUDED.counter`,
    [
      userId,
      credential.id,
      Buffer.from(credential.publicKey).toString('base64url'),
      credential.counter,
      deviceName || 'My Device',
    ],
  );
}

// ── Authentication ────────────────────────────────────────────────────────────
async function generateAuthenticationOptions(userId) {
  const creds = await getCredentials(userId);
  if (!creds.length) throw new Error('No passkey registered for this user');

  const options = await swanGenAuth({
    rpID:                RP_ID,
    allowCredentials:    creds.map(c => ({ id: c.id, type: 'public-key' })),
    userVerification:    'required',
  });

  await saveChallenge(userId, options.challenge, 'authenticate');
  return options;
}

async function verifyAuthentication(userId, credentialResponse) {
  const expectedChallenge = await consumeChallenge(userId, 'authenticate');
  const creds = await getCredentials(userId);

  const matchingCred = creds.find(c => c.id === credentialResponse.id);
  if (!matchingCred) throw new Error('Passkey credential not found');

  const verification = await verifyAuthenticationResponse({
    response:           credentialResponse,
    expectedChallenge,
    expectedOrigin:     getAllowedOrigins(credentialResponse._requestOrigin),
    expectedRPID:       RP_ID,
    credential: {
      id:        matchingCred.id,
      publicKey: matchingCred.publicKey,
      counter:   matchingCred.counter,
    },
    requireUserVerification: true,
  });

  if (!verification.verified) throw new Error('Passkey authentication failed');

  // Update counter (replay attack protection)
  await db.query(
    'UPDATE passkey_credentials SET counter = $1 WHERE credential_id = $2',
    [verification.authenticationInfo.newCounter, credentialResponse.id],
  );
}

module.exports = {
  generateRegistrationOptions,
  verifyRegistration,
  generateAuthenticationOptions,
  verifyAuthentication,
};
