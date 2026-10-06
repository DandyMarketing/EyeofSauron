import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boardFoodBev, revelBoardDrift, alreadyDecided, boardMatchesRevel } from './revel-drift.js';

const at = (d: string) => new Date(`${d}T12:00:00Z`);
const board = (lunch: [number, number], dinner: [number, number]) => ({
  lunch: { food_sales: lunch[0], bev_sales: lunch[1], service_charge: 99 },
  dinner: { food_sales: dinner[0], bev_sales: dinner[1], service_charge: 99 },
});

describe('boardFoodBev — the board\'s food and drink, without service charge', () => {
  test('adds food and drink across meal periods', () => {
    assert.equal(boardFoodBev(board([1000, 200.5], [4000, 559.3])), 5759.8);
  });

  test('no board for the day is null, never zero', () => {
    assert.equal(boardFoodBev(null), null);
    assert.equal(boardFoodBev({}), null);
    assert.equal(boardFoodBev([]), null);
    assert.equal(boardFoodBev({ lunch: { covers: 40 } }), null);
  });

  test('figures stored as text still add', () => {
    assert.equal(boardFoodBev({ dinner: { food_sales: '100.10', bev_sales: '20.20' } }), 120.3);
  });
});

describe('revelBoardDrift — which settled days need a re-upload', () => {
  // Fat Prince, Wed 30 Sep 2026: $67 added to Revel on Mon 5 Oct, after the export.
  const day = (gross: number | null, mp: unknown = board([1000, 200.5], [4000, 559.3])) =>
    ({ venue_id: 'fp', business_date: '2026-09-30', gross_sales: gross, meal_periods: mp });

  test('a settled day where Revel is behind the board is a finding, with both figures', () => {
    const { differ, agree } = revelBoardDrift([day(5692.8)], at('2026-10-06'));
    assert.deepEqual(agree, []);
    assert.deepEqual(differ, [{ venue_id: 'fp', business_date: '2026-09-30', monday_gross: 5759.8, revel_gross: 5692.8, difference: 67 }]);
  });

  test('once re-uploaded it agrees, which is what clears the alert', () => {
    const { differ, agree } = revelBoardDrift([day(5759.8)], at('2026-10-06'));
    assert.deepEqual(differ, []);
    assert.deepEqual(agree, [{ venue_id: 'fp', business_date: '2026-09-30' }]);
  });

  test('a fraction of a cent is rounding, not drift', () => {
    assert.equal(revelBoardDrift([day(5759.801)], at('2026-10-06')).differ.length, 0);
  });

  test('Revel ahead of the board is a finding too, with a negative difference', () => {
    const [f] = revelBoardDrift([day(5800)], at('2026-10-06')).differ;
    assert.equal(f.difference, -40.2);
  });

  test('an unsettled day is not judged: the board is still being filled in', () => {
    // Wed 30 Sep settles on Mon 5 Oct (three working days).
    const r = revelBoardDrift([day(5692.8)], at('2026-10-02'));
    assert.deepEqual(r, { differ: [], agree: [] });
  });

  test('a day missing either side is not judged', () => {
    assert.deepEqual(revelBoardDrift([day(null)], at('2026-10-06')), { differ: [], agree: [] });
    assert.deepEqual(revelBoardDrift([day(5759.8, null)], at('2026-10-06')), { differ: [], agree: [] });
  });
});

describe('alreadyDecided — a person\'s resolution stands until the day moves', () => {
  const finding = { venue_id: 'fp', business_date: '2026-09-30', monday_gross: 5759.8, revel_gross: 5692.8, difference: 67 };
  const resolved = (monday: number | string | null, revel: number | string | null, venue = 'fp', date = '2026-09-30') =>
    ({ venue_id: venue, business_date: date, monday_gross: monday, revel_gross: revel });

  test('the same difference, already resolved, is not raised again', () => {
    assert.equal(alreadyDecided(finding, [resolved('5759.80', '5692.80')]), true);
  });

  test('a resolution without figures stands: somebody looked at the day', () => {
    assert.equal(alreadyDecided(finding, [resolved(null, null)]), true);
  });

  test('figures that moved after the resolution are new, and raised', () => {
    assert.equal(alreadyDecided(finding, [resolved(5700, 5692.8)]), false);
  });

  test('another day or venue decides nothing', () => {
    assert.equal(alreadyDecided(finding, [resolved(5759.8, 5692.8, 'np')]), false);
    assert.equal(alreadyDecided(finding, [resolved(5759.8, 5692.8, 'fp', '2026-09-29')]), false);
    assert.equal(alreadyDecided(finding, []), false);
  });
});

describe('boardMatchesRevel — when a post-close board edit needs no second look', () => {
  // Fat Prince 17 Aug 2026: the board was corrected from $2,095 to $9,034, which is Revel's figure.
  const corrected = { dinner: { food_sales: 6468, bev_sales: 2566 } };

  test('the corrected board equals Revel: safe to apply', () => {
    assert.equal(boardMatchesRevel(corrected, { data_source: 'both', gross_sales: '9034.00' }), true);
  });

  test('it does not: a person decides (Firangi 7 Aug: board $9,932, Revel $8,816.50)', () => {
    assert.equal(boardMatchesRevel({ dinner: { food_sales: 7000, bev_sales: 2932 } }, { data_source: 'both', gross_sales: 8816.5 }), false);
  });

  test('a board-only day has nothing to check against, so never qualifies', () => {
    assert.equal(boardMatchesRevel(corrected, { data_source: 'monday', gross_sales: 9034 }), false);
    assert.equal(boardMatchesRevel(corrected, undefined), false);
  });
});
