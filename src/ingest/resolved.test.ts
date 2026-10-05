import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolutionFor, countUnresolved } from './resolved.js';

const run = (o: Partial<Parameters<typeof resolutionFor>[0]> & { created_at: string }) =>
  ({ venue_id: 'v1', report_type: 'sevenrooms', business_date: null, ...o });

test('THE CASE THIS WAS BUILT FOR: a run failure a later run repaired', () => {
  /**
   * SevenRooms' auth returned 503 on 29 Sep and the run died. On 3 Oct a run of
   * the same report succeeded, re-reading the same rolling window. The console
   * went on showing the 29 Sep failure as a live problem for four days.
   */
  const failure = run({ created_at: '2026-09-29T09:04:00Z' });
  const successes = [run({ created_at: '2026-10-03T14:03:00Z' })];

  const r = resolutionFor(failure, successes);
  assert.ok(r, 'should be resolved by the later successful run');
  assert.equal(r!.at, '2026-10-03T14:03:00Z');
  assert.match(r!.because, /later run/);
});

test('a DATED failure needs that date, not just any later success', () => {
  /**
   * The distinction that makes this safe. A Revel file for 29 Sep that would
   * not parse is repaired only by 29 Sep loading. The 30th loading proves
   * nothing about it, and treating it as proof would close a real gap on screen
   * while leaving it open in the warehouse.
   */
  const failure = run({ report_type: 'operations', business_date: '2026-09-29', created_at: '2026-09-29T09:00:00Z' });

  const wrongDay = [run({ report_type: 'operations', business_date: '2026-09-30', created_at: '2026-10-01T09:00:00Z' })];
  assert.equal(resolutionFor(failure, wrongDay), null, 'a different date must not resolve it');

  const rightDay = [run({ report_type: 'operations', business_date: '2026-09-29', created_at: '2026-10-01T09:00:00Z' })];
  const r = resolutionFor(failure, rightDay);
  assert.ok(r);
  assert.match(r!.because, /2026-09-29/);
});

test('another venue or another report never resolves it', () => {
  const failure = run({ created_at: '2026-09-29T09:00:00Z' });
  assert.equal(
    resolutionFor(failure, [run({ venue_id: 'v2', created_at: '2026-10-01T09:00:00Z' })]),
    null,
    "another venue's success must not resolve this venue's failure",
  );
  assert.equal(
    resolutionFor(failure, [run({ report_type: 'staffany', created_at: '2026-10-01T09:00:00Z' })]),
    null,
    "another report's success must not resolve this one",
  );
});

test('an EARLIER success does not resolve a later failure', () => {
  // The direction matters and is easy to get backwards: a run that succeeded
  // before the failure says nothing about the ground the failure missed.
  const failure = run({ created_at: '2026-09-29T09:00:00Z' });
  const earlier = [run({ created_at: '2026-09-28T09:00:00Z' })];
  assert.equal(resolutionFor(failure, earlier), null);
});

test('the EARLIEST repairing success is the one reported', () => {
  // Otherwise the panel says it was put right days after it actually was.
  const failure = run({ created_at: '2026-09-29T09:00:00Z' });
  const successes = [
    run({ created_at: '2026-10-03T09:00:00Z' }),
    run({ created_at: '2026-09-30T09:00:00Z' }),
    run({ created_at: '2026-10-01T09:00:00Z' }),
  ];
  assert.equal(resolutionFor(failure, successes)!.at, '2026-09-30T09:00:00Z');
});

test('an unrepaired failure stays unrepaired', () => {
  const failure = run({ created_at: '2026-09-29T09:00:00Z' });
  assert.equal(resolutionFor(failure, []), null);
});

test('the count the badge uses matches what the panel marks', () => {
  /**
   * The badge and the panel must agree. One counting repaired failures while
   * the other greys them out is the disagreement this codebase already treats
   * as worse than no badge at all.
   */
  const failures = [
    run({ created_at: '2026-09-29T09:00:00Z' }),                                   // repaired
    run({ report_type: 'staffany', created_at: '2026-10-02T09:00:00Z' }),          // not
  ];
  const successes = [run({ created_at: '2026-10-03T09:00:00Z' })];
  assert.equal(countUnresolved(failures, successes), 1);
  assert.equal(countUnresolved([], successes), 0);
  assert.equal(countUnresolved(failures, []), 2);
});

test('a PARSE failure, logged with only the report key, is resolved by that key', () => {
  /**
   * Neon Pigeon, 29 Sep 2026. The file could not be read, so the failure was
   * logged with the filename's report key and no venue id — resolving the key
   * is a database lookup, and this is the failure path. Every success carries
   * both. Matching on venue id alone compared a blank with an id, and the day
   * sat at "Needs fixing" for a week whatever happened to it afterwards.
   */
  const failure = {
    venue_id: null, venue_key: 'neon-pigeon_neon-pigeon', report_type: 'operations',
    business_date: '2026-09-29', created_at: '2026-10-04T00:46:00Z',
  };
  const success = {
    venue_id: 'v-np', venue_key: 'neon-pigeon_neon-pigeon', report_type: 'operations',
    business_date: '2026-09-29', created_at: '2026-10-04T09:00:00Z',
  };
  assert.ok(resolutionFor(failure, [success]), 'a successful reload of the same day did not resolve it');

  // Another venue's success of the same date must not resolve it.
  const other = { ...success, venue_id: 'v-fp', venue_key: 'fatprince_fatprince' };
  assert.equal(resolutionFor(failure, [other]), null);

  // Nor must a success that carries no identity at all.
  const anonymous = { ...success, venue_id: null, venue_key: null };
  assert.equal(resolutionFor(failure, [anonymous]), null);
});
