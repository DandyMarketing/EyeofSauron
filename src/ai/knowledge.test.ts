import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scopeNotes, orderNotes, isStale, formatNotes, noteVenueAllowed, type KnowledgeNote } from './knowledge.js';

function note(over: Partial<KnowledgeNote> = {}): KnowledgeNote {
  return {
    note: 'Bar-led venues run higher bev cost.',
    category: 'cost',
    confidence: 'rule',
    venue_slug: null,
    venue_name: null,
    author_name: 'Khai',
    created_at: '2026-03-12T00:00:00Z',
    review_by: null,
    ...over,
  };
}

const NP = note({ venue_slug: 'neon-pigeon', venue_name: 'Neon Pigeon', note: 'Terrace shut for works.' });
const FP = note({ venue_slug: 'fat-prince', venue_name: 'Fat Prince', note: 'Services are named DAY and LEGACY.' });
const GROUP = note({ note: 'Cocktail-led venues run higher bev cost.' });

describe('scopeNotes — the venue boundary', () => {
  /**
   * Notes were previously selected unfiltered and appended to every system
   * prompt, one line below the text telling the user which venues they may
   * see. This is BUILD_LOG 4.1 in a second location, and notes are free text
   * written by owners — so the leak is unbounded in content.
   */
  test('drops notes for venues the caller does not hold', () => {
    const scoped = scopeNotes([NP, FP], ['neon-pigeon']);
    assert.deepEqual(scoped.map(n => n.venue_slug), ['neon-pigeon']);
  });

  test('keeps group-wide notes, which carry no venue specifics', () => {
    const scoped = scopeNotes([NP, FP, GROUP], ['neon-pigeon']);
    assert.equal(scoped.length, 2);
    assert.ok(scoped.includes(GROUP));
  });

  test('an owner (null scope) sees everything', () => {
    assert.equal(scopeNotes([NP, FP, GROUP], null).length, 3);
  });

  test('a caller holding no venues gets group-wide notes only, never everything', () => {
    // The fail-open shape: [] must not be read as "no restriction".
    const scoped = scopeNotes([NP, FP, GROUP], []);
    assert.deepEqual(scoped, [GROUP]);
  });

  test('an empty knowledge base stays empty', () => {
    assert.deepEqual(scopeNotes([], ['neon-pigeon']), []);
  });
});

describe('noteVenueAllowed — who may propose what', () => {
  const manager = { isOwner: false, venues: [{ venue_id: 'v-np' }] };
  const owner = { isOwner: true, venues: [] };

  test('a manager may propose against their own venue', () => {
    assert.equal(noteVenueAllowed(manager, 'v-np'), true);
  });

  test('a manager may not propose against another venue', () => {
    // A note names its venue in its provenance, so an unchecked venue_id
    // would let someone write into another venue's knowledge base.
    assert.equal(noteVenueAllowed(manager, 'v-fp'), false);
  });

  test('anyone may propose a group-wide note', () => {
    // It carries no venue's specifics, and an owner reviews it either way.
    assert.equal(noteVenueAllowed(manager, null), true);
  });

  test('an owner may propose against any venue', () => {
    assert.equal(noteVenueAllowed(owner, 'v-fp'), true);
  });

  test('a user with no venues may not propose against one', () => {
    assert.equal(noteVenueAllowed({ isOwner: false, venues: [] }, 'v-np'), false);
  });
});

describe('orderNotes', () => {
  test('venue-specific notes come before group-wide ones', () => {
    // Only the tail is dropped when the character budget runs out, so the
    // more actionable notes must sort first.
    const ordered = orderNotes([GROUP, NP]);
    assert.equal(ordered[0].venue_slug, 'neon-pigeon');
  });

  test('most recent first within each group', () => {
    const older = note({ venue_slug: 'neon-pigeon', created_at: '2026-01-01T00:00:00Z', note: 'older' });
    const newer = note({ venue_slug: 'neon-pigeon', created_at: '2026-06-01T00:00:00Z', note: 'newer' });
    assert.deepEqual(orderNotes([older, newer]).map(n => n.note), ['newer', 'older']);
  });

  test('does not mutate the caller’s array', () => {
    const input = [GROUP, NP];
    orderNotes(input);
    assert.equal(input[0], GROUP);
  });
});

describe('isStale', () => {
  test('a note past its review date is stale', () => {
    assert.equal(isStale(note({ review_by: '2026-01-01' }), '2026-08-14'), true);
  });

  test('a note with a future review date is not', () => {
    assert.equal(isStale(note({ review_by: '2026-12-01' }), '2026-08-14'), false);
  });

  test('a note with no review date never goes stale', () => {
    assert.equal(isStale(note({ review_by: null }), '2026-08-14'), false);
  });

  test('the review date itself is not yet stale', () => {
    assert.equal(isStale(note({ review_by: '2026-08-14' }), '2026-08-14'), false);
  });
});

describe('formatNotes — provenance is the teaching mechanism', () => {
  test('every note carries venue, category, confidence, author and date', () => {
    const out = formatNotes([NP], '2026-08-14');
    assert.match(out, /Neon Pigeon/);
    assert.match(out, /cost/);
    assert.match(out, /rule/);
    assert.match(out, /Khai/);
    assert.match(out, /2026-03-12/);
    assert.match(out, /Terrace shut for works\./);
  });

  test('a group-wide note is labelled as applying to all venues', () => {
    assert.match(formatNotes([GROUP], '2026-08-14'), /All venues/);
  });

  test('a missing author is omitted rather than faked', () => {
    const out = formatNotes([note({ author_name: null })], '2026-08-14');
    assert.ok(!out.includes('null'), 'rendered a null author into the prompt');
    assert.ok(!out.includes('undefined'));
  });

  test('a stale note is shown and marked, not silently dropped', () => {
    // Dropping it would lose a fact that is probably still true; the reader
    // and the model both need to see that it is unconfirmed.
    const out = formatNotes([note({ review_by: '2026-01-01' })], '2026-08-14');
    assert.match(out, /NEEDS REVIEW/);
    assert.match(out, /higher bev cost/);
  });

  test('a current note is not marked for review', () => {
    assert.ok(!formatNotes([note({ review_by: '2026-12-01' })], '2026-08-14').includes('NEEDS REVIEW'));
  });

  test('an empty knowledge base produces nothing to append', () => {
    assert.equal(formatNotes([], '2026-08-14'), '');
  });

  test('exceeding the character budget is reported, never silent', () => {
    // A prompt built on a knowledge base that quietly dropped half its notes
    // looks identical to one built on all of them.
    const many = Array.from({ length: 400 }, (_, i) =>
      note({ note: `Long standing operational note number ${i} `.repeat(10) }),
    );
    const out = formatNotes(many, '2026-08-14');
    assert.match(out, /not shown — knowledge base exceeds the context budget/);
  });

  test('within budget, nothing is dropped and no warning appears', () => {
    const out = formatNotes([NP, FP, GROUP], '2026-08-14');
    assert.ok(!out.includes('not shown'));
    assert.equal(out.split('\n').length, 3);
  });
});
