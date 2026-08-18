import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { backfillWindow, daysCoveredBy } from './backfill-window.js';

// 2026-08-18T00:00:00Z, so the arithmetic is readable.
const NOW = Date.parse('2026-08-18T00:00:00Z');

describe('backfillWindow', () => {
  test('a 30-day window covers 30 days and asks for 31', () => {
    // Meta's series stops one short of `until` once the end_time correction is
    // applied, so requesting one extra day is what makes `end` actually land.
    const w = backfillWindow(730, 30, NOW);
    assert.equal(w.start, '2024-08-18');
    assert.equal(w.end, '2024-09-16');
    assert.equal(w.requestUntil, '2024-09-17');
    assert.equal(daysCoveredBy(w), 30);
  });

  test('consecutive windows are contiguous with no day between them', () => {
    // THE BUG. Window one ended 2024-09-16 and window two began 2024-09-17,
    // but window one never stored its own last day -- so 2024-09-16 was
    // requested by nobody and vanished. One day lost per window, forever.
    const first = backfillWindow(730, 30, NOW);
    const second = backfillWindow(700, 30, NOW);

    const dayAfterFirst = new Date(Date.parse(`${first.end}T00:00:00Z`) + 86_400_000)
      .toISOString().slice(0, 10);
    assert.equal(second.start, dayAfterFirst);
  });

  test('requestUntil is always exactly one day past end', () => {
    for (const offset of [730, 700, 400, 90, 31, 30]) {
      const w = backfillWindow(offset, 30, NOW);
      const expected = new Date(Date.parse(`${w.end}T00:00:00Z`) + 86_400_000)
        .toISOString().slice(0, 10);
      assert.equal(w.requestUntil, expected, `offset ${offset}`);
    }
  });

  test('the newest window stops at yesterday, never today', () => {
    // Today is still accruing. Storing a partial day as a whole one produces a
    // figure that disagrees with itself the next time anyone looks.
    const w = backfillWindow(10, 30, NOW);
    assert.equal(w.end, '2026-08-17');
    assert.equal(w.requestUntil, '2026-08-18');
  });

  test('a short final window reports its real length, not the nominal one', () => {
    // A skip check expecting a full 30 days here would find fewer, decide the
    // window was incomplete, and re-fetch it on every run for ever.
    const w = backfillWindow(10, 30, NOW);
    assert.equal(daysCoveredBy(w), 10);
    assert.ok(daysCoveredBy(w) < 30);
  });

  test('windows tile the whole range without gaps or overlaps', () => {
    // The property that actually matters: every day between the oldest and
    // yesterday belongs to exactly one window.
    const days = 365, windowDays = 30;
    const covered = new Set<string>();

    for (let offset = days; offset > 0; offset -= windowDays) {
      const w = backfillWindow(offset, windowDays, NOW);
      for (let t = Date.parse(`${w.start}T00:00:00Z`); t <= Date.parse(`${w.end}T00:00:00Z`); t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        assert.ok(!covered.has(day), `${day} covered twice`);
        covered.add(day);
      }
    }

    assert.equal(covered.size, days);
    assert.ok(covered.has('2025-08-18'));
    assert.ok(covered.has('2026-08-17'));
    assert.ok(!covered.has('2026-08-18'));
  });
});
