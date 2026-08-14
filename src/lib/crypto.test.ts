import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, loadKey } from './crypto.js';

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString('base64');

describe('encrypt / decrypt', () => {
  test('a token survives a round trip', () => {
    const token = 'refresh-token-with-a-realistic-length-0123456789abcdef';
    assert.equal(decrypt(encrypt(token, KEY), KEY), token);
  });

  test('the same plaintext encrypts differently every time', () => {
    // A fresh IV per encryption. Identical ciphertexts would leak that a
    // token had not changed between refreshes.
    const a = encrypt('same', KEY);
    const b = encrypt('same', KEY);
    assert.notEqual(a, b);
    assert.equal(decrypt(a, KEY), 'same');
    assert.equal(decrypt(b, KEY), 'same');
  });

  test('the ciphertext does not contain the plaintext', () => {
    assert.ok(!encrypt('neon-pigeon-secret', KEY).includes('neon-pigeon-secret'));
  });

  test('the wrong key fails rather than returning rubbish', () => {
    const payload = encrypt('token', KEY);
    assert.throws(() => decrypt(payload, randomBytes(32)));
  });

  test('a tampered ciphertext fails to decrypt', () => {
    // The reason for GCM: without authentication a modified ciphertext
    // decrypts to garbage that then gets sent to Xero as a token.
    const payload = encrypt('token', KEY);
    const parts = payload.split('.');
    const data = Buffer.from(parts[3], 'base64url');
    data[0] ^= 0xff;
    parts[3] = data.toString('base64url');
    assert.throws(() => decrypt(parts.join('.'), KEY));
  });

  test('a malformed payload is rejected clearly', () => {
    assert.throws(() => decrypt('not-a-ciphertext', KEY), /v1\./);
    assert.throws(() => decrypt('v2.a.b.c', KEY), /v1\./);
  });

  test('unicode and empty strings round trip', () => {
    assert.equal(decrypt(encrypt('', KEY), KEY), '');
    assert.equal(decrypt(encrypt('café — 東京', KEY), KEY), 'café — 東京');
  });
});

describe('loadKey', () => {
  test('accepts a correct base64 32-byte key', () => {
    assert.equal(loadKey(KEY_B64).length, 32);
  });

  test('names the variable when it is missing', () => {
    assert.throws(() => loadKey(undefined), /XERO_TOKEN_KEY is not set/);
  });

  test('rejects a key of the wrong length and says so', () => {
    // The failure this guards against is a truncated paste, which otherwise
    // surfaces as an opaque crypto error far from the cause.
    assert.throws(() => loadKey(randomBytes(16).toString('base64')), /must decode to 32 bytes, got 16/);
  });

  test('uses the caller’s variable name in the message', () => {
    assert.throws(() => loadKey(undefined, 'MASTER_KEY'), /MASTER_KEY is not set/);
  });
});
