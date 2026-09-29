import { test } from 'node:test';
import assert from 'node:assert';
import {
  sharedAttributes,
  rankComparable,
  previousOccurrence,
  comparabilityCaveats,
  COMPARISON_ATTRIBUTES,
  type EventLike,
} from './events.js';

/**
 * Two things decide whether this is useful. Whether a shared occasion a year
 * and three weeks ago is found — because a date window misses it — and whether
 * an empty result reads as "no record" rather than "never done".
 */

const ev = (over: Partial<EventLike> & { id: string; start_date: string }): EventLike => ({
  name: 'An event',
  end_date: over.start_date,
  occasion: null,
  concept_type: null,
  partner: null,
  format: null,
  demographic: null,
  venue_slugs: [],
  ...over,
});

test('an attribute matches loosely on case and punctuation', () => {
  const shared = sharedAttributes(
    { occasion: "Valentine's Day" },
    ev({ id: 'a', start_date: '2025-02-14', occasion: 'valentines day' }),
  );
  assert.deepEqual(shared, ['occasion']);
});

test('a blank on either side is NOT a shared attribute', () => {
  /**
   * Two events with no partner recorded do not share a partner, they share a
   * blank. Counting it would rank every unspecified event above a real match,
   * and most early rows will be half-specified.
   */
  assert.deepEqual(sharedAttributes({ partner: null }, ev({ id: 'a', start_date: '2025-01-01' })), []);
  assert.deepEqual(sharedAttributes({ partner: 'Vicky Ratnani' }, ev({ id: 'a', start_date: '2025-01-01' })), []);
  assert.deepEqual(sharedAttributes({ partner: '' }, ev({ id: 'a', start_date: '2025-01-01', partner: '' })), []);
});

test('venues match on any overlap, not on the whole set', () => {
  const shared = sharedAttributes(
    { venue_slugs: ['neon-pigeon'] },
    ev({ id: 'a', start_date: '2025-01-01', venue_slugs: ['fat-prince', 'neon-pigeon'] }),
  );
  assert.deepEqual(shared, ['venue']);
});

test('ranking is by overlap first, recency second', () => {
  // An event sharing three attributes two years ago tells you more than one
  // sharing a format last month, and sorting by date would bury it.
  const old3 = ev({ id: 'old3', start_date: '2024-11-01', occasion: 'Deepavali', partner: 'Vicky Ratnani', format: 'set menu' });
  const new1 = ev({ id: 'new1', start_date: '2026-08-01', format: 'set menu' });

  const ranked = rankComparable(
    { occasion: 'Deepavali', partner: 'Vicky Ratnani', format: 'set menu' },
    [new1, old3],
  );

  assert.deepEqual(ranked.map(m => m.event.id), ['old3', 'new1']);
  assert.equal(ranked[0].shared.length, 3);
  assert.deepEqual(ranked[1].shared, ['format']);
});

test('an event sharing nothing is not returned at all', () => {
  const ranked = rankComparable({ occasion: 'Deepavali' }, [ev({ id: 'x', start_date: '2025-01-01', occasion: 'CNY' })]);
  assert.deepEqual(ranked, []);
});

test('an event is never its own comparison', () => {
  const me = ev({ id: 'me', start_date: '2026-11-08', occasion: 'Deepavali' });
  assert.deepEqual(rankComparable({ occasion: 'Deepavali', exclude_id: 'me' }, [me]), []);
});

test('THE 384-DAY CASE: last Deepavali is found, which a year window misses', () => {
  /**
   * Deepavali 2026 falls on 8 November; Deepavali 2025 was 20 October. That is
   * 384 days. A 365-day lookback reaches back to 8 November 2025 and misses it
   * by nineteen days — the most valuable comparison there is, on the kind of
   * day this group most reliably repeats.
   */
  const last = ev({ id: 'd25', start_date: '2025-10-20', occasion: 'Deepavali' });
  const found = previousOccurrence('Deepavali', [last], '2026-11-08');

  assert.equal(found?.id, 'd25');

  const gap = (Date.parse('2026-11-08') - Date.parse('2025-10-20')) / 86_400_000;
  assert.equal(gap, 384, 'the gap this test exists for');
  assert.ok(gap > 365, 'a 365-day window would have excluded it');
});

test('the previous occurrence is the most recent earlier one, not the oldest', () => {
  const found = previousOccurrence('Deepavali', [
    ev({ id: 'd24', start_date: '2024-10-31', occasion: 'Deepavali' }),
    ev({ id: 'd25', start_date: '2025-10-20', occasion: 'Deepavali' }),
  ], '2026-11-08');
  assert.equal(found?.id, 'd25');
});

test('a later event is never the previous occurrence', () => {
  const found = previousOccurrence('Deepavali', [
    ev({ id: 'd27', start_date: '2027-10-28', occasion: 'Deepavali' }),
  ], '2026-11-08');
  assert.equal(found, null);
});

test('no occasion means no previous occurrence, rather than an arbitrary one', () => {
  assert.equal(previousOccurrence(null, [ev({ id: 'a', start_date: '2025-01-01' })], '2026-01-01'), null);
  assert.equal(previousOccurrence('', [ev({ id: 'a', start_date: '2025-01-01' })], '2026-01-01'), null);
});

test('an empty result says NO RECORD, never never-done', () => {
  /**
   * The store began in September 2026 and was not backfilled, so for about a
   * year this is the most common answer. It must not read as a verdict on the
   * group's history — the same distinction migration 044 had to teach the
   * retention measure.
   */
  const notes = comparabilityCaveats([], { occasion: 'Deepavali' });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /NO COMPARABLE EVENT ON RECORD/);
  assert.match(notes[0], /not backfilled/i);
  assert.match(notes[0], /never "this has not been tried"/);
});

test('a set of one-attribute matches is called out as weak', () => {
  const matches = rankComparable({ format: 'set menu' }, [
    ev({ id: 'a', start_date: '2026-01-01', format: 'set menu' }),
    ev({ id: 'b', start_date: '2026-02-01', format: 'set menu' }),
  ]);
  const notes = comparabilityCaveats(matches, { format: 'set menu' });
  assert.ok(notes.some(n => /weakest kind of comparison/.test(n)));
});

test('a mixed set names how many of them are weak', () => {
  const matches = rankComparable({ occasion: 'Deepavali', format: 'set menu' }, [
    ev({ id: 'strong', start_date: '2025-10-20', occasion: 'Deepavali', format: 'set menu' }),
    ev({ id: 'weak', start_date: '2026-02-01', format: 'set menu' }),
  ]);
  const notes = comparabilityCaveats(matches, { occasion: 'Deepavali', format: 'set menu' });
  assert.ok(notes.some(n => /1 of 2 match/.test(n)));
});

test('a missing year-on-year comparison is named, and so is the synonym trap', () => {
  // Matched on format only, so nothing here is last year's Deepavali.
  const matches = rankComparable({ occasion: 'Deepavali', format: 'set menu' }, [
    ev({ id: 'a', start_date: '2026-02-01', format: 'set menu' }),
  ]);
  const notes = comparabilityCaveats(matches, { occasion: 'Deepavali', format: 'set menu' });
  const note = notes.find(n => /year-on-year/.test(n));
  assert.ok(note, 'the missing-occasion note is absent');
  assert.match(note!, /CNY.*Chinese New Year|Chinese New Year/);
});

test('the attribute list is what the migration stores, and venue comes through the join', () => {
  assert.deepEqual([...COMPARISON_ATTRIBUTES],
    ['occasion', 'venue', 'concept_type', 'partner', 'format', 'demographic']);
});
