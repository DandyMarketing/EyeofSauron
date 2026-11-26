import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueByGroup, groupValue } from './guest-value.js';

const rows = [
  { guest_group: 'returning_here', guests: 100, bookings: 150, covers: 450, linked_bookings: 148, linked_covers: 440, spend: 39600 },
  { guest_group: 'new_to_group', guests: 300, bookings: 310, covers: 900, linked_bookings: 280, linked_covers: 800, spend: 56000 },
];

test('per cover divides by the covers of the bookings that carried a spend', () => {
  const v = valueByGroup(rows);
  assert.equal(v.returning_here.spend_per_cover, 90);          // 39600 / 440, not / 450
  assert.equal(v.returning_here.visits_per_guest, 1.5);
  assert.equal(v.returning_here.spend_per_guest, 396);
  assert.equal(v.returning_here.thin, false);
});

test('a group under 95% linked is marked thin', () => {
  const v = valueByGroup(rows);
  assert.equal(v.new_to_group.linked_pct, 90.3);
  assert.equal(v.new_to_group.thin, true);
});

test('a group with nobody in it is zeros and nulls, never a division by zero', () => {
  const v = valueByGroup(rows);
  assert.equal(v.crossed_from_sister.guests, 0);
  assert.equal(v.crossed_from_sister.spend_per_cover, null);
  assert.equal(v.crossed_from_sister.thin, false);
});

test('venues sum before dividing, so the group figure is not an average of averages', () => {
  const v = valueByGroup([...rows, { guest_group: 'returning_here', guests: 10, bookings: 10, covers: 20, linked_bookings: 10, linked_covers: 20, spend: 4000 }]);
  assert.equal(v.returning_here.spend_per_cover, Math.round(43600 / 460 * 100) / 100);
  assert.equal(groupValue(undefined).bookings, 0);
});
