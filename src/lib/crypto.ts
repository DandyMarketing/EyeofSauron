import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption for credentials that rotate.
 *
 * Railway sealed variables are the right home for a secret that never changes
 * -- an API key, a client secret. Xero OAuth tokens are the opposite: the
 * access token lasts 30 minutes and every refresh issues a NEW refresh token
 * and invalidates the old one. A store you cannot write to at runtime cannot
 * hold them, so they live encrypted in Postgres with the master key in
 * Railway, exactly as the security model in CLAUDE.md describes.
 *
 * AES-256-GCM: authenticated, so a tampered or truncated ciphertext fails to
 * decrypt rather than silently yielding rubbish that then gets sent to Xero as
 * a token.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // GCM standard
const KEY_BYTES = 32;  // AES-256

/**
 * Read the master key from the environment.
 *
 * Fails loudly and specifically. A vague "decryption failed" three layers deep
 * at 4am is a much worse debugging experience than being told the variable is
 * missing or the wrong length.
 */
export function loadKey(envValue: string | undefined, varName = 'XERO_TOKEN_KEY'): Buffer {
  if (!envValue) {
    throw new Error(
      `${varName} is not set. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  const key = Buffer.from(envValue, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${varName} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
      `It should be base64 of 32 random bytes -- check for a truncated paste ` +
      `or stray whitespace (a credential broken by a newline in the middle ` +
      `has already cost this project a day; see BUILD_LOG).`,
    );
  }
  return key;
}

/** Encrypt to a self-describing string: v1.<iv>.<authTag>.<ciphertext>, base64url parts. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Versioned so the format can change later without guessing at old rows.
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Ciphertext is not in the expected v1.<iv>.<tag>.<data> format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
