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

export function isPasskeySupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

export async function registerPasskey(ownerAddress, deviceName = 'My Device') {
  if (!isPasskeySupported()) throw new Error('This browser does not support Passkeys (WebAuthn)');
  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    throw new Error('Please connect your wallet first');
  }

  const options        = await auth.startRegister(ownerAddress);
  const decodedOptions = decodeServerOptions(options);

  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: decodedOptions });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Passkey creation cancelled or timed out');
    throw err;
  }

  const encoded = encodeCredentialForServer(credential);
  const result  = await auth.finishRegister(ownerAddress, encoded, deviceName);
  setToken(result.token);
  return result;
}

export async function authenticatePasskey(ownerAddress) {
  if (!isPasskeySupported()) throw new Error('This browser does not support Passkeys (WebAuthn)');
  if (!ownerAddress || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    throw new Error('Please connect your wallet first');
  }

  const options        = await auth.startLogin(ownerAddress);
  const decodedOptions = decodeServerOptions(options);

  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey: decodedOptions });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('Passkey authentication cancelled or timed out');
    throw err;
  }

  const encoded = encodeCredentialForServer(credential);
  const result  = await auth.finishLogin(ownerAddress, encoded);
  setToken(result.token);
  return result;
}

export async function requestTransactionSignature(ownerAddress) {
  if (!isPasskeySupported()) throw new Error('This browser does not support Passkeys (WebAuthn)');
  return authenticatePasskey(ownerAddress);
}
