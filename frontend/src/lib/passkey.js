/**
 * Arc Machina — Passkey / WebAuthn client helpers
 */
import { auth, setToken } from './api.js';

function base64urlToBuffer(b64) {
  const str = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(str, c => c.charCodeAt(0)).buffer;
}

function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  bytes.forEach(b => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function createPasskeyError(message, code) {
  const error = new Error(message);
  error.name = 'PasskeyError';
  error.code = code;
  return error;
}

function encodeCredentialForServer(cred) {
  return {
    id:    cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type:  cred.type,
    response: {
      clientDataJSON:    cred.response.clientDataJSON    ? bufferToBase64url(cred.response.clientDataJSON)    : undefined,
      attestationObject: cred.response.attestationObject ? bufferToBase64url(cred.response.attestationObject) : undefined,
      authenticatorData: cred.response.authenticatorData ? bufferToBase64url(cred.response.authenticatorData) : undefined,
      signature:         cred.response.signature          ? bufferToBase64url(cred.response.signature)         : undefined,
      userHandle:        cred.response.userHandle         ? bufferToBase64url(cred.response.userHandle)        : undefined,
    },
  };
}

function decodeServerOptions(options) {
  const decoded = { ...options };
  if (decoded.challenge)  decoded.challenge = base64urlToBuffer(decoded.challenge);
  if (decoded.user?.id)   decoded.user.id   = base64urlToBuffer(decoded.user.id);
  if (decoded.allowCredentials) {
    decoded.allowCredentials = decoded.allowCredentials.map(c => ({ ...c, id: base64urlToBuffer(c.id) }));
  }
  if (decoded.excludeCredentials) {
    decoded.excludeCredentials = decoded.excludeCredentials.map(c => ({ ...c, id: base64urlToBuffer(c.id) }));
  }
  return decoded;
}

function normalizePasskeyError(err, mode) {
  if (err?.name === 'PasskeyError') return err;

  const name = String(err?.name || '');
  const message = String(err?.message || '');

  if (message === 'Please connect your wallet first') {
    return createPasskeyError(message, 'WALLET_REQUIRED');
  }

  if (message === 'Passkeys require a secure supported browser.') {
    return createPasskeyError(message, 'UNSUPPORTED_BROWSER');
  }

  if (mode === 'register' && (name === 'UserRejectedRequestError' || /rejected|denied|cancelled/i.test(message))) {
    return createPasskeyError(
      'Wallet signature was cancelled before passkey registration could start.',
      'WALLET_SIGNATURE_CANCELLED'
    );
  }

  if (mode === 'register' && (name === 'InvalidStateError' || message.toLowerCase().includes('already registered'))) {
    return createPasskeyError(
      'A passkey is already registered on this device for this wallet. Continue with sign in.',
      'PASSKEY_ALREADY_REGISTERED'
    );
  }

  if (name === 'NotAllowedError') {
    return createPasskeyError(
      mode === 'register'
        ? 'Passkey registration was cancelled or could not be completed.'
        : 'Passkey authentication was cancelled or could not be completed.',
      'PASSKEY_CANCELLED'
    );
  }

  return createPasskeyError(
    mode === 'register'
      ? 'Passkey registration could not be completed securely.'
      : 'Passkey authentication could not be completed securely.',
    'PASSKEY_OPERATION_FAILED'
  );
}

export function isPasskeySupported() {
  return typeof window !== 'undefined' && window.isSecureContext !== false && !!window.PublicKeyCredential;
}

export async function registerPasskey(ownerAddress, deviceName = 'My Device', signMessageAsync) {
  if (!isPasskeySupported()) throw createPasskeyError('Passkeys require a secure supported browser.', 'UNSUPPORTED_BROWSER');
  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    throw createPasskeyError('Please connect your wallet first', 'WALLET_REQUIRED');
  }
  if (typeof signMessageAsync !== 'function') {
    throw createPasskeyError('Wallet signature is required before registering a passkey.', 'WALLET_SIGNATURE_REQUIRED');
  }

  try {
    const challenge = await auth.registerChallenge(ownerAddress);
    const signature = await signMessageAsync({ message: challenge.message });
    const options = await auth.startRegister(ownerAddress, challenge.challengeId, signature);
    const decodedOptions = decodeServerOptions(options);
    const credential = await navigator.credentials.create({ publicKey: decodedOptions });
    const encoded = encodeCredentialForServer(credential);
    const result = await auth.finishRegister(ownerAddress, encoded, deviceName);
    setToken(result.token);
    return result;
  } catch (err) {
    throw normalizePasskeyError(err, 'register');
  }
}

export async function authenticatePasskey(ownerAddress) {
  if (!isPasskeySupported()) throw createPasskeyError('Passkeys require a secure supported browser.', 'UNSUPPORTED_BROWSER');
  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    throw createPasskeyError('Please connect your wallet first', 'WALLET_REQUIRED');
  }

  try {
    const options = await auth.startLogin(ownerAddress);
    const decodedOptions = decodeServerOptions(options);
    const credential = await navigator.credentials.get({ publicKey: decodedOptions });
    const encoded = encodeCredentialForServer(credential);
    const result = await auth.finishLogin(ownerAddress, encoded);
    setToken(result.token);
    return result;
  } catch (err) {
    throw normalizePasskeyError(err, 'authenticate');
  }
}

export async function requestTransactionSignature(ownerAddress) {
  if (!isPasskeySupported()) throw new Error('This browser does not support Passkeys (WebAuthn)');
  return authenticatePasskey(ownerAddress);
}
