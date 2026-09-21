import { test } from 'node:test';
import assert from 'node:assert';
import {
  TERMS_VERSION,
  TERMS_TITLE,
  TERMS_BODY,
  hasAcceptedCurrentTerms,
  latestAcceptance,
  acceptanceExpiresAt,
  TERMS_VALIDITY_DAYS,
} from './terms.js';

/**
 * The version is the whole mechanism.
 *
 * An acceptance recorded against a wording you no longer show is a record that
 * looks like evidence and is not. These tests exist so that a future edit to
 * the text without a version bump fails here rather than silently leaving
 * everybody "accepted" to something they never read.
 */

const fresh = () => new Date().toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test('somebody who accepted the current version recently has accepted', () => {
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION, accepted_at: fresh() }]), true);
});

test('somebody who accepted an OLDER version has not', () => {
  // The case the whole version column exists for. Treating this as accepted is
  // how a company ends up unable to say what anybody agreed to.
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: '2020-01-01' }]), false);
});

test('an older VERSION alongside a current one still counts', () => {
  // Re-acceptance after a rewrite leaves two rows. The history is the point.
  assert.equal(
    hasAcceptedCurrentTerms([
      { terms_version: '2020-01-01', accepted_at: daysAgo(900) },
      { terms_version: TERMS_VERSION, accepted_at: fresh() },
    ]),
    true,
  );
});

test('nobody is accepted by default', () => {
  // Null and empty are the states a brand-new user is in, and both must gate.
  assert.equal(hasAcceptedCurrentTerms([]), false);
  assert.equal(hasAcceptedCurrentTerms(null), false);
  assert.equal(hasAcceptedCurrentTerms(undefined), false);
});

// --- the text itself -------------------------------------------------------

test('the version looks like a date somebody can read', () => {
  // Date-based so a recorded acceptance can be judged for age at a glance,
  // without opening the git history to decode a counter.
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test('the terms cover what Khai asked them to cover', () => {
  // Each of these was a specific requirement, and a rewrite that quietly drops
  // one leaves the company believing it is covered for something it is not.
  const body = TERMS_BODY.toLowerCase();

  assert.ok(body.includes('do not share your password'), 'account sharing');
  assert.ok(/confidential/.test(body), 'confidentiality');
  assert.ok(/personal data protection act|pdpa/.test(body), 'PDPA');
  assert.ok(/dismissal|liability|disciplinary/.test(body), 'consequences');
  assert.ok(/by continuing you confirm/.test(body), 'the agreement itself');
});

test('there is a title and a body worth reading', () => {
  assert.ok(TERMS_TITLE.length > 0);
  // Long enough to be terms, short enough to be read on a phone before service.
  assert.ok(TERMS_BODY.length > 800, 'too short to cover the ground');
  assert.ok(TERMS_BODY.length < 4000, 'too long to be read, which defeats it');
});

// --- it expires ------------------------------------------------------------

/**
 * A year. Two reasons, neither of them form: a three-month-old acceptance is
 * far stronger evidence than a three-year-old one on the day you need it, and
 * somebody asked in 2029 whether they knew in 2026 that they could not forward
 * a P&L will honestly say they do not remember, and be right.
 */
test('an acceptance from last week stands', () => {
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION, accepted_at: daysAgo(7) }]), true);
});

test('an acceptance from two years ago does not', () => {
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION, accepted_at: daysAgo(730) }]), false);
});

test('the boundary falls where TERMS_VALIDITY_DAYS says', () => {
  const justInside = daysAgo(TERMS_VALIDITY_DAYS - 1);
  const justOutside = daysAgo(TERMS_VALIDITY_DAYS + 1);
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION, accepted_at: justInside }]), true);
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION, accepted_at: justOutside }]), false);
});

test('re-accepting refreshes it, and the old row is kept', () => {
  // Re-acceptance writes a NEW row rather than overwriting, so the history of
  // who agreed when survives — which is the whole reason this is a table and
  // not a flag. The most recent one decides.
  const rows = [
    { terms_version: TERMS_VERSION, accepted_at: daysAgo(400) },
    { terms_version: TERMS_VERSION, accepted_at: daysAgo(2) },
  ];
  assert.equal(hasAcceptedCurrentTerms(rows), true);
  assert.equal(latestAcceptance(rows)?.accepted_at, rows[1].accepted_at);
});

test('an unreadable timestamp counts as expired, never as valid', () => {
  // The two ways of being wrong are not symmetrical: asking again costs a
  // click, while treating an unreadable record as a live agreement is the one
  // claim this table exists to support and the one it could not.
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION, accepted_at: 'not a date' }]), false);
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION, accepted_at: null }]), false);
  assert.equal(hasAcceptedCurrentTerms([{ terms_version: TERMS_VERSION }]), false);
});

test('the expiry date is reported so the admin console can show it', () => {
  const at = daysAgo(10);
  const expires = acceptanceExpiresAt([{ terms_version: TERMS_VERSION, accepted_at: at }]);
  assert.ok(expires);
  const gap = Date.parse(expires!) - Date.parse(at);
  assert.equal(Math.round(gap / 86_400_000), TERMS_VALIDITY_DAYS);
});

test('no acceptance means no expiry date, rather than a date in the past', () => {
  assert.equal(acceptanceExpiresAt([]), null);
});
