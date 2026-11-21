import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancellationNotice, noticeMinutes, slotInstant, formatNotice, noticeGroup } from './cancellation-notice.js';

test('a Singapore slot is read as UTC+8', () => {
  assert.equal(slotInstant('2026-11-10T19:30:00'), Date.parse('2026-11-10T11:30:00Z'));
  assert.equal(slotInstant('2026-11-10 19:30'), Date.parse('2026-11-10T11:30:00Z'));
  assert.equal(slotInstant(null), null);
  assert.equal(slotInstant('7:30 PM'), null);
});

test('notice is slot minus last change, to the minute', () => {
  // Cancelled at 10:17:40 SGT for a 19:30 SGT slot: 9h 12m (seconds dropped).
  assert.equal(noticeMinutes({ party_size: 2, slot_local: '2026-11-10T19:30:00', source_updated_at: '2026-11-10T02:17:40+00:00' }), 552);
  assert.equal(formatNotice(552), '9h 12m');
  assert.equal(formatNotice(45), '45m');
  assert.equal(formatNotice(1440 * 3 + 65), '3d 1h 05m');
});

test('groups: within 24 hours, then by the day, then over a week', () => {
  assert.equal(noticeGroup(0), 'within 24 hours');
  assert.equal(noticeGroup(1439), 'within 24 hours');
  assert.equal(noticeGroup(1440), '1-2 days');
  assert.equal(noticeGroup(1440 * 2 + 1), '2-3 days');
  assert.equal(noticeGroup(1440 * 6 + 1439), '6-7 days');
  assert.equal(noticeGroup(1440 * 7), 'over 7 days');
});

test('cancellations grouped, covers summed, late ones listed shortest first, the undatable apart', () => {
  const slot = '2026-11-14T19:00:00';           // Sat 19:00 SGT = 11:00Z
  const rows = [
    { party_size: 4, business_date: '2026-11-14', slot_local: slot, source_updated_at: '2026-11-14T05:00:00Z' },  // 6h
    { party_size: 2, business_date: '2026-11-14', slot_local: slot, source_updated_at: '2026-11-14T10:15:00Z' },  // 45m
    { party_size: 3, business_date: '2026-11-14', slot_local: slot, source_updated_at: '2026-11-13T11:00:00Z' },  // exactly 1 day
    { party_size: 2, business_date: '2026-11-14', slot_local: slot, source_updated_at: '2026-11-12T10:00:00Z' },  // 2d 1h
    { party_size: 6, business_date: '2026-11-14', slot_local: slot, source_updated_at: '2026-11-01T11:00:00Z' },  // 13 days
    { party_size: 2, business_date: '2026-11-14', slot_local: slot, source_updated_at: '2026-11-14T13:00:00Z' },  // after the slot
    { party_size: 5, business_date: '2026-11-14', slot_local: null, source_updated_at: '2026-11-10T11:00:00Z' },  // no slot
  ];
  const n = cancellationNotice(rows);
  assert.deepEqual(n.by_notice, [
    { notice: 'within 24 hours', bookings: 2, covers: 6 },
    { notice: '1-2 days', bookings: 1, covers: 3 },
    { notice: '2-3 days', bookings: 1, covers: 2 },
    { notice: 'over 7 days', bookings: 1, covers: 6 },
  ]);
  assert.deepEqual(n.within_24h_detail.map(d => [d.notice, d.covers, d.slot, d.date]), [
    ['45m', 2, '19:00', '2026-11-14'],
    ['6h 00m', 4, '19:00', '2026-11-14'],
  ]);
  assert.deepEqual(n.changed_after_slot, { bookings: 1, covers: 2 });
  assert.deepEqual(n.undated, { bookings: 1, covers: 5 });
  // Five dated: 45m, 6h, 1d, 2d 1h, 13d -> the middle is exactly one day.
  assert.equal(n.median_notice, '1d 0h 00m');
  assert.match(n.basis, /OVER-counted, never under-counted/);
});
