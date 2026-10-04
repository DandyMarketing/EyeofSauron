/**
 * A week runs Monday to Sunday, in one place, and nowhere else.
 *
 * There were four copies of this two-line calculation and one of them had gone
 * Sunday-first — `post-patterns.ts`, under a comment claiming it matched "the
 * weekday charts already built", which index Monday-first one file away.
 *
 * NOTHING WAS VISIBLY BROKEN, and that is the part worth recording. The module
 * ranks weekdays by median performance rather than by weekday, so the ordering
 * never reached a screen. It was a trap rather than a fault: the first person
 * to sort by the index, or to line a post weekday up against a sales weekday,
 * gets an off-by-one in a chart that nobody can explain from the output.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DOW_LABELS, DOW_SHORT, weekdayIndex, weekdayName, mondayOf } from './weekdays.js';

describe('Monday is 0 and Sunday is 6', () => {
  test('the labels are in that order', () => {
    assert.equal(DOW_LABELS[0], 'Monday');
    assert.equal(DOW_LABELS[6], 'Sunday');
    assert.equal(DOW_SHORT[0], 'Mon');
    assert.equal(DOW_LABELS.length, 7);
  });

  test('a real week indexes through correctly', () => {
    // 2026-09-28 is a Monday.
    const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
    assert.deepEqual(days.map(weekdayIndex), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(days.map(weekdayName), [...DOW_LABELS]);
  });

  test('Sunday is the END of the week, not the start', () => {
    // The whole instruction. A Sunday-start week cuts every weekend in half.
    assert.equal(weekdayIndex('2026-10-04'), 6);
    assert.equal(weekdayName('2026-10-04'), 'Sunday');
  });
});

describe('dates are read as UTC, never as local', () => {
  test('a Sunday does not report as a Saturday west of GMT', () => {
    /**
     * `new Date('2026-10-04')` is midnight UTC but reads back in local time, so
     * on a server west of GMT it is still Saturday — and the weekday is wrong
     * on exactly the days a restaurant cares about most. The implementation
     * appends T00:00:00Z for this reason.
     */
    assert.equal(weekdayName('2026-10-04'), 'Sunday');
    assert.equal(weekdayName('2026-01-01'), 'Thursday');
  });

  test('a bad date throws rather than returning Thursday', () => {
    // NaN dates produce a weekday index of NaN, which silently indexes to
    // undefined. Better to fail at the call than to label a chart with it.
    assert.throws(() => weekdayIndex('not-a-date'));
  });
});

describe('mondayOf', () => {
  test('a Monday is its own Monday', () => {
    assert.equal(mondayOf('2026-09-28'), '2026-09-28');
  });

  test('a Sunday looks back six days, not forward one', () => {
    // The Sunday-first mistake, in the one place it would be most expensive:
    // a Sunday belongs to the week that is ENDING.
    assert.equal(mondayOf('2026-10-04'), '2026-09-28');
  });

  test('it crosses a month boundary', () => {
    assert.equal(mondayOf('2026-10-01'), '2026-09-28');
  });
});

test('no module keeps a weekday list of its own', () => {
  /**
   * The guard that matters. Four copies existed and one had drifted; a fifth
   * would drift the same way, and the drift is invisible from the output
   * because every label is individually correct.
   *
   * A Sunday-first array is the specific failure, so it is the specific thing
   * rejected — a Monday-first literal elsewhere would be redundant but harmless,
   * and this test is not a style preference.
   */
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk('src');

  for (const f of files) {
    if (f.endsWith('lib/weekdays.ts')) continue;
    const src = readFileSync(f, 'utf8');
    assert.ok(
      !/\[\s*'Sunday'\s*,\s*'Monday'/.test(src),
      `${f} declares a Sunday-first weekday array — a week here runs Monday to Sunday, and src/lib/weekdays.ts is the one definition`,
    );
  }
});

test('the raw getUTCDay index is not used to pick a label', () => {
  // `getUTCDay()` is 0=Sunday. Indexing a Monday-first array with it shifts
  // every weekday by one, which reads as a plausible chart and is wrong.
  const src = readFileSync('src/ai/post-patterns.ts', 'utf8');
  assert.ok(
    !/WEEKDAYS\[d\.getUTCDay\(\)\]/.test(src),
    'post-patterns indexes a label array with the raw getUTCDay — use weekdayName()',
  );
  assert.match(src, /weekdayName\(/);
});
