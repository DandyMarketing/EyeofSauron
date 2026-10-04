/**
 * The probe's one hard guarantee: it cannot print a guest's details.
 *
 * Everything else here is a convenience. This is the property the design rests
 * on -- a probe written to prove we never store personal data, which prints
 * personal data into a terminal and a CI log on its way to proving it, has
 * defeated its own purpose and left the evidence lying around.
 *
 * Testable without credentials because `summarise()` and `redact()` are pure.
 * The container this was written in had no SevenRooms credentials, so the probe
 * itself could not be run here; the part that must be right is covered anyway.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redact, summarise, verdict } from './sevenrooms-guest-probe.js';

/** A payload shaped like SevenRooms', with values nobody should ever see. */
const ROWS = [
  {
    id: 'r1', client_id: 'c1', date: '2026-10-01',
    first_name: 'Khai', last_name: 'Leong', email: 'khai@example.com',
    phone_number: '+6591234567', notes: 'Allergic to shellfish. Prefers the counter.',
    tags: ['VIP', 'Regular'], max_guests: 2, loyalty_tier: 'gold',
  },
  {
    id: 'r2', client_id: 'c2', date: '2026-10-01',
    first_name: 'Jane', last_name: 'Tan', email: 'jane@example.com',
    phone_number: null, notes: null, tags: [], max_guests: 4,
  },
  { id: 'r3', client_id: null, date: '2026-10-02', first_name: 'Walk', last_name: 'In', max_guests: 2 },
];

const SECRETS = [
  'Khai', 'Leong', 'khai@example.com', '+6591234567', 'shellfish',
  'Jane', 'Tan', 'jane@example.com', 'VIP', 'Regular', 'counter', 'gold',
];

describe('nothing identifying can reach the output', () => {
  test('redact never returns the value it was given', () => {
    for (const v of ['Khai Leong', 'khai@example.com', '+6591234567']) {
      const out = redact(v);
      assert.ok(!out.includes(v), `redact leaked ${v}: ${out}`);
      assert.match(out, /^string, /);
    }
    assert.equal(redact(['VIP', 'Regular']), 'array(2)');
    assert.equal(redact(null), 'null');
    assert.equal(redact(42), 'number');
  });

  test('the whole summary, serialised, contains no personal data', () => {
    // The real guarantee: not "each function is careful" but "the thing that
    // gets printed holds none of it", checked against the payload itself.
    const out = JSON.stringify(summarise(ROWS));
    for (const secret of SECRETS) {
      assert.ok(!out.includes(secret), `the summary leaked "${secret}"`);
    }
  });

  test('an undeclared field is reported by NAME and never by value', () => {
    const s = summarise(ROWS);
    // `loyalty_tier` is new to this codebase and worth knowing about.
    assert.ok(s.undeclared_fields.includes('loyalty_tier'), s.undeclared_fields.join(','));
    assert.ok(!JSON.stringify(s).includes('gold'), 'the value of the new field was printed');
  });
});

describe('what the probe is actually for', () => {
  test('it counts which identity fields arrive, and how often', () => {
    const s = summarise(ROWS);
    const f = (name: string) => s.identity.find(x => x.field === name)!;

    assert.equal(f('first_name').present, 3);
    assert.equal(f('email').present, 2);      // one row has none
    assert.equal(f('notes').present, 1);
    assert.equal(f('birthday').present, 0);   // absent entirely
    assert.equal(f('birthday').type, 'absent');
  });

  test('an empty string counts as absent, not present', () => {
    // A field that always arrives empty looks supported and is not. That is the
    // exact shape of the Brave search key that was never set and reported
    // nothing for the life of the feature.
    const s = summarise([{ id: 'x', first_name: '', email: 'a@b.com' }]);
    assert.equal(s.identity.find(x => x.field === 'first_name')!.present, 0);
  });

  test('client_id coverage is counted, because the join depends on it', () => {
    const s = summarise(ROWS);
    assert.deepEqual(s.client_id_coverage, { withId: 2, withoutId: 1 });
  });
});

describe('the verdict, so a reader is not left to interpret a table', () => {
  const base = { window: { start: 'a', end: 'b' }, venue: 'V', undeclared_fields: [], errors: [] };

  test('says YES when identity arrives on the endpoint we already call', () => {
    const r = { ...base, reservations_sampled: 10, ...summarise(Array(10).fill(ROWS[0])) };
    assert.match(verdict(r as any), /^YES/);
  });

  test('says NO when there is no name, rather than implying success', () => {
    const rows = Array(10).fill({ id: 'x', client_id: 'c', max_guests: 2 });
    const r = { ...base, reservations_sampled: 10, ...summarise(rows) };
    assert.match(verdict(r as any), /^NO/);
  });

  test('an empty window is INCONCLUSIVE, never a pass', () => {
    // Nothing tested and everything green is the failure this codebase keeps
    // finding: an absence nobody can see is indistinguishable from an all-clear.
    const r = { ...base, reservations_sampled: 0, ...summarise([]) };
    assert.match(verdict(r as any), /^INCONCLUSIVE/);
  });

  test('warns when client_id is patchy, because those guests have no history', () => {
    // A booking with no client_id can show a name and nothing else. Presenting
    // that as "first visit" would tell a manager a regular is a stranger.
    const rows = [...Array(7).fill(ROWS[0]), ...Array(3).fill({ id: 'x', first_name: 'A', last_name: 'B' })];
    const r = { ...base, reservations_sampled: 10, ...summarise(rows) };
    const v = verdict(r as any);
    assert.match(v, /^YES/);
    assert.match(v, /never imply the guest is new/);
  });
});
