import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRedirect } from './canonical-host.js';

const on = { REDIRECT_TO_PUBLIC_URL: 'true', PUBLIC_APP_URL: 'https://sauron.staydandy.com/' };
const old = 'https://eyeofsauron-production.up.railway.app';

test('the old Railway address sends people to sauron.staydandy.com, path and all', () => {
  assert.equal(canonicalRedirect(`${old}/chat.html?c=1`, on), 'https://sauron.staydandy.com/chat.html?c=1');
  assert.equal(canonicalRedirect(`${old}/xero/callback?code=a&state=b`, on), 'https://sauron.staydandy.com/xero/callback?code=a&state=b');
  assert.equal(canonicalRedirect('https://sauron.staydandy.com/chat.html', on), null, 'already there');
  assert.equal(canonicalRedirect(`${old}/version`, on), null, 'deploy checks work on both');
  assert.equal(canonicalRedirect('http://localhost:4891/chat.html', on), null, 'only the Railway address moves');
});

test('nothing moves until the switch is on', () => {
  /** Switched on before the new address answers, it would send everyone to a dead page. */
  assert.equal(canonicalRedirect(`${old}/`, { PUBLIC_APP_URL: 'https://sauron.staydandy.com' }), null);
  assert.equal(canonicalRedirect(`${old}/`, { REDIRECT_TO_PUBLIC_URL: 'true' }), null, 'no target, no redirect');
  assert.equal(canonicalRedirect(`${old}/`, { REDIRECT_TO_PUBLIC_URL: 'true', PUBLIC_APP_URL: 'http://sauron.staydandy.com' }), null, 'never to plain http');
});
