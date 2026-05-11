/**
 * Arc Machina — Passkey / WebAuthn client helpers
 *
 * Uses the browser's native WebAuthn API (navigator.credentials).
 * Communicates with our backend to exchange challenges.
 *
 * FaceID / TouchID / Windows Hello / PIN all work via the same API.
 */
'use strict';

import { auth, setToken } from './api.js';

// ── Utility: buffers ──────────────────────────────────────────────────────────
function base64urlToBuffer(b64) {
  const str = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(str, c => c.charCodeAt(0)).buffer;
}

function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function encodeCredentialForServer(cred) {
  return {
    id:    cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type:  cred.type,
    response: {
      // Registration
      clientDataJSON:    cred.response.clientDataJSON    ? bufferToBase64url(cred.response.clientDataJSON)    : undefined,
      attestationObject: cred.response.attestationObject ? bufferToBase64url(cred.response.attestationObject) : undefined,
      // Authentication
      authenticatorData: cred.response.authenticatorData ? bufferToBase64url(cred.response.authenticatorData) : undefined,
      signature:         cred.response.signature          ? bufferToBase64url(cred.response.signature)         : undefined,
      userHandle:        cred.response.userHandle         ? bufferToBase64url(cred.response.userHandle)        : undefined,
    },
  };
}

function decodeServerOptions(options) {
  // Convert base64url fields to ArrayBuffer for browser API
  const decoded = { ...options };
  if (decoded.challenge)  decoded.challenge = base64urlToBuffer(decoded.challenge);
  if (decoded.user?.id)   decoded.user.id   = base64urlToBuffer(decoded.user.id);
  if (decoded.allowCredentials) {
    decoded.allowCredentials = decoded.allowCredentials.map(c => ({
      ...c, id: base64urlToBuffer(c.id),
    }));
  }
  if (decoded.excludeCredentials) {
    decoded.excludeCredentials = decoded.excludeCredentials.map(c => ({
      ...c, id: base64urlToBuffer(c.id),
    }));
  }
  return decoded;
}

// ── Register a new passkey ────────────────────────────────────────────────────
/**
 * @param {string} ownerAddress  - The user's EVM wallet address
 * @param {string} deviceName    - Label for this device ("My iPhone")
 * @returns {Promise<{token: string, userId: string}>}
 */
export async function registerPasskey(ownerAddress, deviceName = 'My Device') {
  if (!window.PublicKeyCredential) {
    throw new Error('This browser does not support Passkeys (WebAuthn)');
  }

  // Step 1 — get challenge from backend
  const options = await auth.startRegister(ownerAddress);
  const decodedOptions = decodeServerOptions(options);

  // Step 2 — create passkey on device (triggers FaceID / TouchID / PIN)
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: decodedOptions });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Passkey creation cancelled or timed out');
    throw err;
  }

  // Step 3 — send attestation to backend for verification
  const encoded = encodeCredentialForServer(credential);
  const result  = await auth.finishRegister(ownerAddress, encoded, deviceName);

  setToken(result.token);
  return result;
}

// ── Authenticate with existing passkey ────────────────────────────────────────
/**
 * @param {string} ownerAddress
 * @returns {Promise<{token: string, userId: string}>}
 */
export async function authenticatePasskey(ownerAddress) {
  if (!window.PublicKeyCredential) {
    throw new Error('This browser does not support Passkeys (WebAuthn)');
  }

  // Step 1 — get challenge
  const options = await auth.startLogin(ownerAddress);
  const decodedOptions = decodeServerOptions(options);

  // Step 2 — get assertion (biometric / PIN prompt)
  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey: decodedOptions });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Authentication cancelled');
    throw err;
  }

  // Step 3 — verify assertion
  const encoded = encodeCredentialForServer(credential);
  const result  = await auth.finishLogin(ownerAddress, encoded);

  setToken(result.token);
  return result;
}

/**
 * Prompt device biometrics for transaction signing.
 * The passkey assertion proves user consent — sent along with the tx to the backend.
 *
 * @param {string} ownerAddress
 * @returns {Promise<object>} encoded credential assertion
 */
export async function requestTransactionSignature(ownerAddress) {
  const options = await auth.startLogin(ownerAddress);
  const decodedOptions = decodeServerOptions(options);

  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey: decodedOptions });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Transaction signing cancelled');
    throw err;
  }

  return encodeCredentialForServer(credential);
}

/** True if this device has WebAuthn / platform authenticator support */
export async function isPasskeySupported() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}
