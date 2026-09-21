import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { isTransientHttp } from './sevenrooms.js';

/**
 * Which HTTP statuses are worth waiting out.
 *
 * On 16, 17 and 18 September 2026 the reservations fetch failed with HTTP 502
 * on three consecutive nights, two of them at the same minute. Each failure
 * ended that venue's run outright, because the fetch had no retry at all —
 * while the Supabase upsert in the same file, on our own infrastructure,
 * retried three times with backoff. The resilient handling was on the call that
 * did not need it.
 *
 * The cost was never lost data: every run re-fetches seven days back to sixty
 * forward and upserts by id, so one success heals the window. The cost was a
 * stale FORWARD book until the next night, and the forward book is what "how
 * does next week look" and "is this event booking up" are answered from.
 */

test('a gateway wobble is retried', () => {
  for (const status of [502, 503, 504]) {
    assert.equal(isTransientHttp(status), true, `${status} should be retried`);
  }
});

test('a rate limit is retried, because backoff is exactly its remedy', () => {
  assert.equal(isTransientHttp(429), true);
});

test('a refusal is NOT retried', () => {
  // 401 and 403 are answers, not wobbles. Retrying them turns a credentials
  // problem into a slow credentials problem, and the auth path already has a
  // message explaining that both SevenRooms secrets are 128-char hex and look
  // identical, so a swap is the likely cause.
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isTransientHttp(status), false, `${status} must not be retried`);
  }
});

test('the result-set cap is not a wobble', () => {
  // A 400 carrying "limited to N results" is a SIGNAL — it means the window is
  // too busy and must be halved. Retrying it unchanged would fail four times
  // and then report a gateway problem for what is actually a busy venue.
  assert.equal(isTransientHttp(400), false);
});

test('success is never retried', () => {
  for (const status of [200, 201, 204]) {
    assert.equal(isTransientHttp(status), false);
  }
});
