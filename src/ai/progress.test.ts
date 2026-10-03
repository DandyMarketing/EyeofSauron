import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelFor, labelsForRound, prettyVenue, sseFrame } from './progress.js';
import { queryTools } from './tools.js';

const ALLOWED = { neon_pigeon: 'Neon Pigeon' };

test('a tool name becomes a sentence, not a function name', () => {
  assert.equal(labelFor('query_profit_and_loss'), 'Pulling the P&L');
  assert.equal(labelFor('create_chart'), 'Drawing the chart');
  // The generic rule has to be good on its own, because most tools use it.
  assert.equal(labelFor('query_meal_period_sales'), 'Reading meal period sales');
  assert.equal(labelFor('query_booking_lead_time'), 'Reading booking lead time');
});

test('no label leaks a function name to the reader', () => {
  // Every tool the model can call must produce something a venue manager would
  // recognise. An underscore means the raw name reached the screen.
  for (const tool of queryTools as any[]) {
    const label = labelFor(tool.name, {}, ALLOWED);
    assert.ok(!label.includes('_'), `${tool.name} renders as "${label}"`);
    assert.ok(label.length > 3, `${tool.name} renders as "${label}"`);
  }
});

test('the venue and period are named when they are known', () => {
  assert.equal(
    labelFor('query_profit_and_loss', { venue_slug: 'neon_pigeon', start_date: '2026-06-01', end_date: '2026-06-30' }, ALLOWED),
    'Pulling the P&L — Neon Pigeon, 2026-06-01 to 2026-06-30',
  );
  assert.equal(
    labelFor('query_social_performance', { venue: 'neon_pigeon', days: 30 }, ALLOWED),
    'Reading Instagram — Neon Pigeon, last 30 days',
  );
});

test('A LABEL NEVER NAMES A VENUE THE READER MAY NOT SEE', () => {
  /**
   * The point of the whole venueNames parameter. A label is drawn from the
   * model's chosen input BEFORE the tool runs, so before enforceVenueScope has
   * refused it. Without this, a manager at Neon Pigeon whose question made the
   * model reach for Fat Prince would have read "Pulling the P&L — Fat Prince"
   * on their own screen, a moment before we refused the query.
   */
  const label = labelFor('query_profit_and_loss', { venue_slug: 'fat_prince' }, ALLOWED);
  assert.ok(!label.toLowerCase().includes('fat'), `leaked: "${label}"`);
  assert.ok(!label.includes('prince'), `leaked: "${label}"`);
  assert.equal(label, 'Pulling the P&L — another venue');

  // Every field the qualifier reads must be covered, not just the first one.
  for (const field of ['venue', 'venue_slug', 'venue_name']) {
    const l = labelFor('compare_venues', { [field]: 'firangi_superstar' }, ALLOWED);
    assert.ok(!l.toLowerCase().includes('firangi'), `${field} leaked: "${l}"`);
  }
});

test('an empty allow-map hides every venue, and null hides none', () => {
  // An empty map is the safe default: a caller that forgot to pass one must
  // not get the permissive behaviour by accident.
  assert.equal(labelFor('query_labour', { venue: 'neon_pigeon' }, {}), 'Reading labour — another venue');
  // null is the explicit "there is nobody to keep this from" — an owner.
  assert.equal(labelFor('query_labour', { venue: 'neon_pigeon' }, null), 'Reading labour — Neon Pigeon');
  // And the default, if the argument is omitted entirely, is the safe one.
  assert.equal(labelFor('query_labour', { venue: 'neon_pigeon' }), 'Reading labour — another venue');
});

test('identical labels in one round collapse, different ones do not', () => {
  const labels = labelsForRound([
    { name: 'query_daily_operations', input: { venue: 'neon_pigeon', days: 7 } },
    { name: 'query_daily_operations', input: { venue: 'neon_pigeon', days: 7 } },
    { name: 'query_profit_and_loss', input: { venue: 'neon_pigeon' } },
  ], ALLOWED);
  assert.deepEqual(labels, [
    'Reading daily trade — Neon Pigeon, last 7 days',
    'Pulling the P&L — Neon Pigeon',
  ]);
});

test('a missing or odd input never breaks a label', () => {
  // These come from a model and are not validated before the label is drawn.
  assert.equal(labelFor('query_labour', {}), 'Reading labour');
  assert.equal(labelFor('query_labour', { venue: null as any }), 'Reading labour');
  assert.equal(labelFor('query_labour', { venue: '' }), 'Reading labour');
  assert.equal(labelFor('query_labour', { days: 'seven' as any }), 'Reading labour');
  assert.equal(labelFor('', {}), 'Working');
});

test('a slug becomes a name a person would write', () => {
  assert.equal(prettyVenue('neon_pigeon'), 'Neon Pigeon');
  assert.equal(prettyVenue('fat-prince'), 'Fat Prince');
  assert.equal(prettyVenue('firangi_superstar'), 'Firangi Superstar');
  assert.equal(prettyVenue(''), '');
});

test('an SSE frame survives a payload with newlines in it', () => {
  /**
   * A raw newline inside a frame terminates it early, and the browser would
   * receive half an event with no error anywhere. JSON escapes them, which is
   * why the payload is always JSON and never bare text — asserted so nobody
   * "simplifies" it to a plain string later.
   */
  const frame = sseFrame({ kind: 'note', text: 'line one\nline two' });
  assert.ok(frame.endsWith('\n\n'));
  // Exactly one terminator, at the end: no interior blank line.
  assert.equal(frame.split('\n\n').length, 2);
  assert.deepEqual(JSON.parse(frame.slice(6).trim()), { kind: 'note', text: 'line one\nline two' });
});
