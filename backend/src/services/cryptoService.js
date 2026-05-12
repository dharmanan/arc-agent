'use strict';
/**
 * AES-256-GCM encryption for LLM API keys stored at rest.
 * ENCRYPTION_KEY must be a 64-char hex string (32 bytes).
 */
const crypto = require('crypto');

const ALGO   = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

if (!process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY environment variable is not set');
}
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
if (KEY.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');

/**
 * Encrypt plaintext → "<iv_hex>:<ciphertext_hex>:<tag_hex>"
 */
function encrypt(plaintext) {
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return [iv.toString('hex'), enc.toString('hex'), tag.toString('hex')].join(':');
}

/**
 * Decrypt a string produced by encrypt().
 */
function decrypt(ciphertext) {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');
  const [ivHex, encHex, tagHex] = parts;
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
