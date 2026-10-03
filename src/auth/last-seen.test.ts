import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeLastSeen } from './last-seen.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

test('NEVER IS NOT A LONG TIME AGO', () => {
  /**
   * The distinction the column exists for. An invited account that was never
   * opened is an onboarding that did not finish — something to chase today. An
   * account that has gone quiet is a person who stopped. Collapsing them into
   * "no recent activity" loses the only one anybody can act on.
   */
  const never = describeLastSeen(null, NOW);
  assert.equal(never.tone, 'never');
  assert.match(never.text, /never/i);

  const old = describeLastSeen(daysAgo(400), NOW);
  assert.equal(old.tone, 'dormant');
  assert.doesNotMatch(old.text, /never/i);
  assert.notEqual(never.text, old.text);
});

test('recent activity reads as recent', () => {
  assert.deepEqual(describeLastSeen(daysAgo(0), NOW), { text: 'Today', tone: 'active' });
  assert.deepEqual(describeLastSeen(daysAgo(1), NOW), { text: 'Yesterday', tone: 'active' });
  assert.deepEqual(describeLastSeen(daysAgo(5), NOW), { text: '5 days ago', tone: 'active' });
});

test('the tone shifts as an account goes quiet', () => {
  assert.equal(describeLastSeen(daysAgo(13), NOW).tone, 'active');
  assert.equal(describeLastSeen(daysAgo(20), NOW).tone, 'quiet');
  assert.equal(describeLastSeen(daysAgo(45), NOW).tone, 'dormant');
});

test('long gaps are said in months and years, not days', () => {
  // "412 days ago" is a number to divide; "1 year ago" is a fact.
  assert.equal(describeLastSeen(daysAgo(60), NOW).text, '2 months ago');
  assert.equal(describeLastSeen(daysAgo(31), NOW).text, '1 month ago');
  assert.equal(describeLastSeen(daysAgo(400), NOW).text, '1 year ago');
  assert.equal(describeLastSeen(daysAgo(800), NOW).text, '2 years ago');
});

test('a future timestamp is clock skew, not a visit that has not happened', () => {
  // "in 3 days" reads as a bug and sends somebody looking for one.
  const ahead = new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(describeLastSeen(ahead, NOW), { text: 'Today', tone: 'active' });
});

test('an unparseable value is treated as never, not as a crash', () => {
  assert.equal(describeLastSeen('not a date', NOW).tone, 'never');
  assert.equal(describeLastSeen(undefined, NOW).tone, 'never');
  assert.equal(describeLastSeen('', NOW).tone, 'never');
});
