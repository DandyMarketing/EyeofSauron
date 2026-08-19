import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { monthsBack, isStoredPeriodFinal } from './accounting-months.js';

describe('monthsBack', () => {
  const asOf = new Date('2026-08-18T00:00:00Z');

  test('ends with the month we are in', () => {
    const months = monthsBack(3, asOf);
    assert.equal(months.length, 3);
    assert.deepEqual(months[2], { start: '2026-08-01', end: '2026-08-31', label: '2026-08' });
  });

  test('oldest first, so an interrupted run leaves a contiguous history', () => {
    const months = monthsBack(3, asOf);
    assert.deepEqual(months.map(m => m.label), ['2026-06', '2026-07', '2026-08']);
  });

  test('gets month lengths right, February included', () => {
    // Derived from day zero of the next month rather than a lookup table, so
    // leap years need no special case.
    const feb = monthsBack(1, new Date('2024-02-10T00:00:00Z'))[0];
    assert.equal(feb.end, '2024-02-29');

    const nonLeap = monthsBack(1, new Date('2026-02-10T00:00:00Z'))[0];
    assert.equal(nonLeap.end, '2026-02-28');
  });

  test('crosses a year boundary', () => {
    const months = monthsBack(3, new Date('2026-01-15T00:00:00Z'));
    assert.deepEqual(months.map(m => m.label), ['2025-11', '2025-12', '2026-01']);
  });
});

/**
 * A P&L is not fixed when the month ends -- finance keeps posting for weeks,
 * so the same month pulled on the 3rd and the 20th gives different numbers. A
 * backfill that skips any month it already holds would freeze whichever
 * provisional figure it captured first, which is the Monday lock in different
 * clothes.
 */
describe('isStoredPeriodFinal', () => {
  // July 2026 closes on 15 August 2026.
  const july = '2026-07-31';

  test('closed period, fetched after it closed — final', () => {
    assert.equal(
      isStoredPeriodFinal(july, '2026-08-16T02:00:00Z', new Date('2026-08-18T00:00:00Z')),
      true,
    );
  });

  test('closed period, fetched BEFORE it closed — not final', () => {
    // The trap. The month closing later does not retroactively make the draft
    // we captured on the 3rd correct; it has to be pulled again.
    assert.equal(
      isStoredPeriodFinal(july, '2026-08-03T02:00:00Z', new Date('2026-08-18T00:00:00Z')),
      false,
    );
  });

  test('period not yet closed — never final however recently fetched', () => {
    // August closes on 15 September. Anything held for it today is a draft.
    assert.equal(
      isStoredPeriodFinal('2026-08-31', '2026-08-18T02:00:00Z', new Date('2026-08-18T00:00:00Z')),
      false,
    );
  });

  test('never fetched is not final', () => {
    assert.equal(isStoredPeriodFinal(july, null, new Date('2026-08-18T00:00:00Z')), false);
    assert.equal(isStoredPeriodFinal(july, undefined, new Date('2026-08-18T00:00:00Z')), false);
  });

  test('an unreadable timestamp is not final rather than assumed good', () => {
    // Re-fetching a period we did not need to costs one call. Trusting a figure
    // we cannot date costs a wrong answer nobody questions.
    assert.equal(isStoredPeriodFinal(july, 'whenever', new Date('2026-08-18T00:00:00Z')), false);
  });
});
