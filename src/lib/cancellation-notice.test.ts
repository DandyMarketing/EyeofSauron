import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancellationNotice, noticeHours, slotInstant } from './cancellation-notice.js';

test('a Singapore slot is read as UTC+8', () => {
  assert.equal(slotInstant('2026-11-10T19:30:00'), Date.parse('2026-11-10T11:30:00Z'));
  assert.equal(slotInstant('2026-11-10 19:30'), Date.parse('2026-11-10T11:30:00Z'));
  assert.equal(slotInstant(null), null);
  assert.equal(slotInstant('7:30 PM'), null);
});

test('notice is slot minus last change, in hours', () => {
  // Cancelled at 10:30 SGT for a 19:30 SGT slot: nine hours.
  assert.equal(noticeHours({ party_size: 2, slot_local: '2026-11-10T19:30:00', source_updated_at: '2026-11-10T02:30:00+00:00' }), 9);
});

test('cancellations bucket by notice, covers summed, the undatable kept apart', () => {
  const slot = '2026-11-14T19:00:00';           // Sat 19:00 SGT = 11:00Z
  const rows = [
    { party_size: 4, slot_local: slot, source_updated_at: '2026-11-14T05:00:00Z' },  // 6h
    { party_size: 2, slot_local: slot, source_updated_at: '2026-11-13T12:00:00Z' },  // 23h
    { party_size: 3, slot_local: slot, source_updated_at: '2026-11-13T11:00:00Z' },  // exactly 24h
    { party_size: 6, slot_local: slot, source_updated_at: '2026-11-10T11:00:00Z' },  // 96h
    { party_size: 2, slot_local: slot, source_updated_at: '2026-11-14T13:00:00Z' },  // after the slot
    { party_size: 5, slot_local: null, source_updated_at: '2026-11-10T11:00:00Z' },  // no slot
  ];
  const n = cancellationNotice(rows);
  assert.deepEqual(n.within_24h, { bookings: 2, covers: 6 });
  assert.deepEqual(n.from_24h_to_72h, { bookings: 1, covers: 3 });
  assert.deepEqual(n.over_72h, { bookings: 1, covers: 6 });
  assert.deepEqual(n.changed_after_slot, { bookings: 1, covers: 2 });
  assert.deepEqual(n.undated, { bookings: 1, covers: 5 });
  assert.match(n.basis, /OVER-counted, never under-counted/);
});
