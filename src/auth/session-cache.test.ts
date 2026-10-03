/**
 * The session cache decides, for up to thirty seconds, what somebody is allowed
 * to see. Every rule it relies on is asserted here, because the failure modes
 * are not the kind anybody notices: a revoked role that keeps working, or a
 * person who accepts the terms and is refused anyway.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCache, SESSION_TTL_MS, MAX_ENTRIES } from './session-cache.js';

interface U { id: string; isOwner?: boolean }

/** A clock we control, so no test sleeps and none is flaky. */
function withClock() {
  let now = 1_000_000;
  return {
    tick: (ms: number) => { now += ms; },
    cache: <T extends U>(ttl = SESSION_TTL_MS) => new SessionCache<T>(ttl, () => now),
  };
}

test('a hit returns the same session', () => {
  const { cache } = withClock();
  const c = cache<U>();
  const user = { id: 'u1' };
  c.set('token-a', user);
  assert.equal(c.get('token-a'), user);
});

test('a miss is null, not a throw and not a stale answer', () => {
  const c = withClock().cache<U>();
  assert.equal(c.get('never-seen'), null);
});

test('an entry expires, and expiring EVICTS it', () => {
  const { tick, cache } = withClock();
  const c = cache<U>();
  c.set('t', { id: 'u1' });

  tick(SESSION_TTL_MS - 1);
  assert.ok(c.get('t'), 'should still be valid just inside the window');

  tick(1);
  assert.equal(c.get('t'), null, 'should be gone exactly at the TTL');
  // Not merely reported as absent — actually removed, or the map grows for ever
  // with entries that can never be returned.
  assert.equal(c.size, 0);
});

test('forgetting one person leaves everybody else alone', () => {
  const c = withClock().cache<U>();
  c.set('a1', { id: 'alice' });
  c.set('a2', { id: 'alice' });   // a second device, or a refreshed token
  c.set('b1', { id: 'bob' });

  c.forget('alice');

  assert.equal(c.get('a1'), null, "alice's first token should be gone");
  assert.equal(c.get('a2'), null, "alice's second token should be gone too");
  assert.ok(c.get('b1'), 'bob should be untouched');
});

test('forgetting everybody clears everything', () => {
  // The answer used when a role row is deleted by its own id and we never learn
  // whose it was. It must really clear, or a revoked role keeps working.
  const c = withClock().cache<U>();
  c.set('a', { id: 'alice' });
  c.set('b', { id: 'bob' });
  c.forget();
  assert.equal(c.size, 0);
  assert.equal(c.get('a'), null);
  assert.equal(c.get('b'), null);
});

test('a REVOKED role cannot outlive the invalidation', () => {
  /**
   * The scenario this cache could plausibly get wrong: somebody is an owner,
   * their session is cached, an admin removes the role, and the cached copy
   * keeps saying owner. The invalidation is what prevents it, so it is asserted
   * as a sequence rather than as a method call.
   */
  const c = withClock().cache<U>();
  c.set('tok', { id: 'u1', isOwner: true });
  assert.equal(c.get('tok')?.isOwner, true);

  c.forget('u1');                       // what removeRole/assignRole trigger
  assert.equal(c.get('tok'), null, 'the stale owner session must be gone');

  // And re-validation stores the new truth, not the old.
  c.set('tok', { id: 'u1', isOwner: false });
  assert.equal(c.get('tok')?.isOwner, false);
});

test('a token that failed validation leaves nothing behind', () => {
  const c = withClock().cache<U>();
  c.set('tok', { id: 'u1' });
  c.drop('tok');
  assert.equal(c.get('tok'), null);
});

test('the cache cannot grow without bound', () => {
  /**
   * Every token refresh is a new key, so one person accumulates entries all day
   * even though only the newest is read. Unbounded, a long-lived process leaks.
   */
  const c = withClock().cache<U>();
  for (let i = 0; i < MAX_ENTRIES + 50; i++) c.set(`t${i}`, { id: `u${i}` });

  assert.ok(c.size <= MAX_ENTRIES, `size ${c.size} exceeded the ${MAX_ENTRIES} ceiling`);
  // The newest must survive — evicting what was just written would make the
  // cache useless at exactly the moment it is under load.
  assert.ok(c.get(`t${MAX_ENTRIES + 49}`), 'the most recent entry was evicted');
});

test('re-setting an existing token does not evict anybody', () => {
  // A refresh of a key already present is not a new entry, so the ceiling must
  // not treat it as one.
  const c = new SessionCache<U>(SESSION_TTL_MS, () => 1);
  for (let i = 0; i < MAX_ENTRIES; i++) c.set(`t${i}`, { id: `u${i}` });
  const before = c.size;
  c.set('t0', { id: 'u0-updated' });
  assert.equal(c.size, before);
  assert.equal(c.get('t0')?.id, 'u0-updated');
});

test('the TTL is short enough to be defensible', () => {
  // Not a style check. This number is the length of time a revoked permission
  // keeps working when the change was made outside the app, and it should not
  // drift upward quietly.
  assert.ok(SESSION_TTL_MS <= 60_000, `TTL of ${SESSION_TTL_MS}ms is too long for an authorisation cache`);
  assert.ok(SESSION_TTL_MS >= 5_000, `TTL of ${SESSION_TTL_MS}ms is too short to be worth the risk`);
});
