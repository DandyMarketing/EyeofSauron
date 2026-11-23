import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xeroFetch, isRetryableXero, retryDelayMs, XERO_RETRIES } from './xero-fetch.js';

const reply = (status: number, headers: Record<string, string> = {}) =>
  new Response(status === 200 ? '{"ok":true}' : '{"Title":"An error occurred"}', { status, headers });

function harness(statuses: Array<number | 'drop'>) {
  const calls: string[] = [];
  const waits: number[] = [];
  const queue = [...statuses];
  return {
    calls, waits,
    deps: {
      fetch: (async (url: string) => {
        calls.push(url);
        const s = queue.shift() ?? 200;
        if (s === 'drop') throw new Error('socket hang up');
        return reply(s, s === 429 ? { 'retry-after': '5' } : {});
      }) as unknown as typeof fetch,
      sleep: async (ms: number) => { waits.push(ms); },
      log: () => {},
    },
  };
}

test('which statuses are worth asking again', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(isRetryableXero(s), true, String(s));
  for (const s of [400, 401, 403, 404]) assert.equal(isRetryableXero(s), false, String(s));
});

test('a Xero 500 is retried and the second answer is used (the 22 Nov failure)', async () => {
  const h = harness([500, 200]);
  const res = await xeroFetch('u', {}, h.deps);
  assert.equal(res.status, 200);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.waits, [2000]);
});

test('a rate limit waits as long as Xero asks', async () => {
  const h = harness([429, 200]);
  await xeroFetch('u', {}, h.deps);
  assert.deepEqual(h.waits, [5000]);
  assert.equal(retryDelayMs(1, '600'), 60000, 'capped at a minute');
});

test('a refused request is not retried', async () => {
  const h = harness([401]);
  const res = await xeroFetch('u', {}, h.deps);
  assert.equal(res.status, 401);
  assert.equal(h.calls.length, 1);
});

test('it gives up after the retries and hands back the last answer', async () => {
  const h = harness([500, 500, 500, 500, 500]);
  const res = await xeroFetch('u', {}, h.deps);
  assert.equal(res.status, 500);
  assert.equal(h.calls.length, XERO_RETRIES + 1);
  assert.deepEqual(h.waits, [2000, 4000, 8000]);
});

test('a dropped connection is retried too', async () => {
  const h = harness(['drop', 200]);
  const res = await xeroFetch('u', {}, h.deps);
  assert.equal(res.status, 200);
});
