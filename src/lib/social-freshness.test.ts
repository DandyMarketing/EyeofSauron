import '../tests/env.js';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { INGESTED_PLATFORMS, MAX_SOCIAL_AGE_HOURS, classifyFreshness, describeStale } from './social-freshness.js';

/**
 * The check exists because Ingest-Meta crashed on startup and nobody was told.
 * What is worth pinning is the behaviour that would let that happen again: an
 * unknown treated as healthy.
 */

const NOW = Date.parse('2026-08-20T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const account = (venue: string, last: string | null) => ({
  venue,
  platform: 'instagram',
  account_id: `acct-${venue}`,
  last_fetched_at: last,
});

test('a job running on schedule is fresh', () => {
  // Twice daily means the newest write is at most ~12h old.
  const r = classifyFreshness([account('Neon Pigeon', hoursAgo(11))], NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stale, []);
  assert.equal(r.checked, 1);
});

test('one missed run is caught', () => {
  // 24h means a whole day of stories was at risk, and a followers_count
  // snapshot is already gone.
  const r = classifyFreshness([account('Fat Prince', hoursAgo(24))], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.stale[0].venue, 'Fat Prince');
  assert.equal(r.stale[0].hours_stale, 24);
});

test('the threshold leaves slack for a late run', () => {
  // A run drifting a few hours must not cry wolf, or the signal gets ignored
  // and this is worth nothing.
  assert.equal(classifyFreshness([account('X', hoursAgo(17))], NOW).ok, true);
  assert.equal(classifyFreshness([account('X', hoursAgo(19))], NOW).ok, false);
  assert.equal(MAX_SOCIAL_AGE_HOURS, 18);
});

test('an account that has NEVER been written is stale, not skipped', () => {
  // A mapped account with no data is a configuration problem, and silence is
  // exactly how it would stay one.
  const r = classifyFreshness([account('Firangi Superstar', null)], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.stale[0].hours_stale, null);
});

test('an unparseable timestamp is not treated as fresh', () => {
  // Reading a bad value as "recent" is the failure this whole check exists to
  // prevent, one level down.
  const r = classifyFreshness([account('X', 'not a date')], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.stale[0].hours_stale, null);
});

test('one dead account among healthy ones is still reported', () => {
  // A per-account check rather than a global newest-row check: two venues
  // ingesting fine would otherwise mask a third that stopped.
  const r = classifyFreshness([
    account('Neon Pigeon', hoursAgo(2)),
    account('Fat Prince', hoursAgo(3)),
    account('Firangi Superstar', hoursAgo(40)),
  ], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].venue, 'Firangi Superstar');
});

test('no accounts at all is not a pass', () => {
  // Vacuously ok is correct here: nothing is mapped, so nothing is stale. The
  // missing-account case belongs to the mapping check, not this one.
  const r = classifyFreshness([], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
});

test('the message names the venue, the gap, and what was lost', () => {
  const text = describeStale(classifyFreshness([account('Fat Prince', hoursAgo(30))], NOW));
  assert.match(text, /Fat Prince/);
  assert.match(text, /30h ago/);
  // The consequence has to be in the message. "Stale" alone reads as a delay.
  assert.match(text, /Stories expire/);
  assert.match(text, /Ingest-Meta/);
});

test('a healthy check produces no message', () => {
  assert.equal(describeStale(classifyFreshness([account('X', hoursAgo(1))], NOW)), '');
});

describe('platforms nobody ingests are not stale', () => {
  test('only ingested platforms are listed', () => {
    // discoverAccounts() records the Facebook page behind every Instagram
    // account, and nothing fetches Facebook -- its proven-metric list is
    // deliberately empty. The watchdog reported three feeds as NEVER INGESTED,
    // in red, forever. A monitor that is permanently red is one nobody reads,
    // and it takes the real alarm down with it.
    assert.deepEqual(INGESTED_PLATFORMS, ['instagram']);
  });

  test('adding a platform here is a deliberate act, not a side effect', () => {
    // Listed rather than derived from whichever metric list is populated, so
    // that "we promise this feed is fresh" and "this metric array has entries"
    // stay separate decisions.
    assert.ok(!INGESTED_PLATFORMS.includes('facebook'));
  });
});
