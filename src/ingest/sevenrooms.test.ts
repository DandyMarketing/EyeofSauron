import '../tests/env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import { isTransientHttp, authenticate } from './sevenrooms.js';

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

// --- the auth call, which was the one thing the retry did not cover ---------

test('a transient auth failure is retried, not given up on', async () => {
  /**
   * 29 Sep 2026, 17:04: SevenRooms' auth endpoint returned HTTP 503 and the
   * whole run died for all three venues before a single reservation was read.
   * isTransientHttp() has listed 503 as retryable since 21 Sep, but the retry
   * was wrapped around the PAGE fetches only — the first call, whose failure
   * is the most expensive, was the one left unprotected by the mechanism built
   * for exactly its failure.
   */
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ data: { token: 'tok-123' } }), { status: 200 });
  }) as typeof fetch;

  try {
    const token = await authenticate('id', 'secret');
    assert.equal(token, 'tok-123');
    assert.equal(calls, 3, 'should have retried twice before succeeding');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a REJECTED credential fails immediately', async () => {
  // 401 is an answer, not a wobble. Retrying it turns a credentials problem
  // into a slow credentials problem — and four attempts against a bad secret
  // is also how an account gets locked.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('', { status: 401 });
  }) as typeof fetch;

  try {
    await assert.rejects(() => authenticate('id', 'bad'), /HTTP 401/);
    assert.equal(calls, 1, `401 was attempted ${calls} times; it must not be retried`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a persistent outage says how hard it tried', async () => {
  // "503 after 4 attempts" says they were down for a while, where a bare 503
  // could be a single blip. The difference decides whether anybody chases it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(() => authenticate('id', 'secret'), /HTTP 503 after 4 attempts/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
