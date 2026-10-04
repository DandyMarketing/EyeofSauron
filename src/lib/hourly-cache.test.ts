/**
 * The dashboard cache. Every test is a way a cache serves the wrong thing while
 * looking like it works — which is worse than the slow page it replaced.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HourlyCache, settleWithin } from './hourly-cache.js';

const later = <T>(v: T, ms = 5) => new Promise<T>(r => setTimeout(() => r(v), ms));

describe('the cache', () => {
  test('a first load waits; the same hour is then a hit', async () => {
    const c = new HourlyCache<number>();
    let calls = 0;
    const load = () => { calls++; return later(42); };

    const a = c.get('k', '2026-10-04|17', load);
    assert.equal(a.state, 'miss');
    assert.equal(await a.value, 42);

    const b = c.get('k', '2026-10-04|17', load);
    assert.equal(b.state, 'hit');
    assert.equal(await b.value, 42);
    assert.equal(calls, 1);
  });

  test('a new hour serves the old value AT ONCE and refreshes behind it', async () => {
    const c = new HourlyCache<string>();
    await c.get('k', '17', () => later('five o\'clock')).value;

    const r = c.get('k', '18', () => later('six o\'clock', 20));
    assert.equal(r.state, 'stale');
    assert.equal(await r.value, 'five o\'clock', 'the turn of the hour made somebody wait');

    await later(null, 40);
    const next = c.get('k', '18', () => later('should not run'));
    assert.equal(next.state, 'hit');
    assert.equal(await next.value, 'six o\'clock');
  });

  test('different keys never share a value', async () => {
    // A manager scoped to one venue must never be served the owner's three.
    const c = new HourlyCache<string>();
    await c.get('venue-a', '17', () => later('A')).value;
    const b = c.get('venue-a,venue-b', '17', () => later('A+B'));
    assert.equal(b.state, 'miss');
    assert.equal(await b.value, 'A+B');
  });

  test('concurrent callers share one load', async () => {
    // Four managers at five o'clock must not start four identical queries.
    const c = new HourlyCache<number>();
    let calls = 0;
    const load = () => { calls++; return later(7, 15); };
    const all = await Promise.all([1, 2, 3, 4].map(() => c.get('k', '17', load).value));
    assert.deepEqual(all, [7, 7, 7, 7]);
    assert.equal(calls, 1);
  });

  test('a failed refresh keeps the value we had', async () => {
    const c = new HourlyCache<string>();
    await c.get('k', '17', () => later('good')).value;
    const r = c.get('k', '18', () => Promise.reject(new Error('timeout')));
    assert.equal(await r.value, 'good');
    await later(null, 10);
    // Still the good value, still stale — so the next load tries again.
    const again = c.get('k', '18', () => later('recovered'));
    assert.equal(again.state, 'stale');
    assert.equal(await again.value, 'good');
  });

  test('a failed FIRST load is a failure, not a cached nothing', async () => {
    const c = new HourlyCache<string>();
    await assert.rejects(c.get('k', '17', () => Promise.reject(new Error('boom'))).value);
    assert.equal(c.size(), 0);
    const r = c.get('k', '17', () => later('second try'));
    assert.equal(r.state, 'miss');
    assert.equal(await r.value, 'second try');
  });

  test('it stays bounded', async () => {
    const c = new HourlyCache<number>(3);
    for (let i = 0; i < 10; i++) await c.get(`k${i}`, '17', () => later(i, 0)).value;
    assert.equal(c.size(), 3);
  });
});

describe('waiting only so long', () => {
  test('a value that arrives in time is returned', async () => {
    assert.deepEqual(await settleWithin(later('x', 5), 100), { timedOut: false, value: 'x' });
  });

  test('a slow value times out — and is NOT cancelled', async () => {
    // The work must keep going so the next load finds it in the cache.
    let finished = false;
    const slow = later('x', 40).then(v => { finished = true; return v; });
    assert.deepEqual(await settleWithin(slow, 5), { timedOut: true });
    await later(null, 60);
    assert.equal(finished, true);
  });

  test('a failure is reported as a failure, not as slowness', async () => {
    await assert.rejects(settleWithin(Promise.reject(new Error('no such function')), 100), /no such function/);
  });

  test('a late failure after the deadline does not crash the process', async () => {
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 10));
    assert.deepEqual(await settleWithin(late, 1), { timedOut: true });
    await later(null, 30);   // an unhandled rejection here would fail the run
  });
});
