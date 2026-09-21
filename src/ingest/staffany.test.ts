import { test } from 'node:test';
import assert from 'node:assert';
import { aggregateWorkHours, businessDateOf, splitCost, splitComponents, DAY_ENDS_AT_HOUR, type SectionMapping, costCoverage, MIN_COST_COVERAGE_PCT } from './staffany.js';

/**
 * These pin the three things that decide whether a labour figure is honest:
 * that no person survives the aggregation, that a late shift lands on the night
 * it belongs to, and that an unmapped section is refused rather than guessed.
 */

const NPB = 'sec-np-boh';
const NPF = 'sec-np-foh';

const MAPPINGS: SectionMapping[] = [
  { staffany_section_id: NPB, venue_id: 'venue-np', area: 'BOH' },
  { staffany_section_id: NPF, venue_id: 'venue-np', area: 'FOH' },
];

const row = (over: Partial<any> = {}) => ({
  id: 'wh1',
  userId: 'user-1',
  sectionId: NPB,
  // 17:00 Singapore on 8 Aug 2026 is 09:00 UTC.
  startTime: '2026-08-08T09:00:00.000Z',
  scheduledHours: 8,
  actualHours: 8.5,
  actualCosts: { basicCost: 100, overtimeCost: 20, weekendCost: 0, eventCost: 0 },
  ...over,
});

test('no identity survives the aggregation', () => {
  // The rule the whole labour design rests on: a person's cost for a shift is
  // their earnings, and the warehouse holds only the section total.
  const { rows } = aggregateWorkHours(
    [row({ userId: 'a' }), row({ userId: 'b' }), row({ userId: 'a' })],
    MAPPINGS,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].staff_count, 2);
  const serialised = JSON.stringify(rows);
  assert.doesNotMatch(serialised, /user|userId/i);
  assert.doesNotMatch(serialised, /"a"|"b"/);
});

test('cost components are kept apart and also summed', () => {
  const { rows } = aggregateWorkHours([row()], MAPPINGS);
  assert.equal(rows[0].basic_cost, 100);
  assert.equal(rows[0].overtime_cost, 20);
  assert.equal(rows[0].total_cost, 120);
});

test('an unknown cost member lands in other_cost rather than vanishing', () => {
  // If StaffAny adds a fifth component, the total must still be the total. A
  // dropped member would understate labour with nothing to show for it.
  const c = splitCost({ basicCost: 100, publicHolidayCost: 50 });
  assert.equal(c.basic, 100);
  assert.equal(c.other, 50);
  assert.equal(c.total, 150);
});

test('a flat numeric cost still totals', () => {
  // The shape is an object today. It was worth not assuming that forever.
  const c = splitCost(240.5);
  assert.equal(c.total, 240.5);
  assert.equal(c.other, 240.5);
});

test('a late shift belongs to the night it started', () => {
  // 01:00 Singapore on the 9th is the night of the 8th. Filing it under the 9th
  // would put a Friday closing shift on Saturday's labour cost and leave
  // Saturday looking heavy for a reason nobody could find.
  assert.equal(businessDateOf('2026-08-08T17:00:00.000Z'), '2026-08-08'); // 01:00 SGT on the 9th
  // 07:00 SGT on the 9th is a MORNING shift on the 9th, not a late finish from
  // the 8th. The cut has to fall somewhere and this is the side it falls on.
  assert.equal(businessDateOf('2026-08-08T23:00:00.000Z'), '2026-08-09');
});

test('the day cut is where the constant says it is', () => {
  // 06:00 SGT is 22:00 UTC the previous day.
  const justBefore = businessDateOf('2026-08-08T21:59:00.000Z'); // 05:59 SGT on the 9th
  const justAfter = businessDateOf('2026-08-08T22:01:00.000Z'); // 06:01 SGT on the 9th
  assert.equal(DAY_ENDS_AT_HOUR, 6);
  assert.equal(justBefore, '2026-08-08');
  assert.equal(justAfter, '2026-08-09');
});

test('an evening shift is not filed under tomorrow', () => {
  // The failure this exists to prevent. 21:00 Singapore is already the next
  // calendar day in UTC, so a UTC date would move a third of every evening.
  assert.equal(businessDateOf('2026-08-08T13:00:00.000Z'), '2026-08-08'); // 21:00 SGT
});

test('an unmapped section is refused, never guessed into a venue', () => {
  // The Revel venue-key rule. Guessing puts another venue's labour on this
  // venue's comparison, and timesheets can be re-fetched once somebody maps it.
  const result = aggregateWorkHours([row({ sectionId: 'sec-unknown' }), row()], MAPPINGS);

  assert.deepEqual(result.unmapped_sections, ['sec-unknown']);
  assert.equal(result.skipped_rows, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].staffany_section_id, NPB);
});

test('sections stay separate so the BOH split survives', () => {
  const { rows } = aggregateWorkHours(
    [row({ sectionId: NPB }), row({ sectionId: NPF, userId: 'user-2' })],
    MAPPINGS,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.area).sort(), ['BOH', 'FOH']);
});

test('scheduled cost is the fallback and a costless row is counted', () => {
  const withScheduled = aggregateWorkHours(
    [row({ actualCosts: null, scheduledCosts: { basicCost: 90 } })],
    MAPPINGS,
  );
  assert.equal(withScheduled.rows[0].total_cost, 90);
  assert.equal(withScheduled.costless_rows, 0);

  // Neither present. Silently contributing zero would understate the day with
  // nothing a reader could see, so it is counted.
  const neither = aggregateWorkHours([row({ actualCosts: null, scheduledCosts: null })], MAPPINGS);
  assert.equal(neither.costless_rows, 1);
  assert.equal(neither.rows[0].total_cost, 0);
});

test('scheduled and actual hours are both kept', () => {
  // The variance between them is the cheapest real report in the whole labour
  // ladder, and it only exists if both are stored.
  const { rows } = aggregateWorkHours([row()], MAPPINGS);
  assert.equal(rows[0].scheduled_hours, 8);
  assert.equal(rows[0].actual_hours, 8.5);
});

test('an unparseable timestamp is skipped, not filed under today', () => {
  const result = aggregateWorkHours([row({ startTime: 'not a date' })], MAPPINGS);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped_rows, 1);
});

test('group staff keep a null venue and are never allocated', () => {
  // The Dandy Collection carries people who work across all three venues. An
  // allocation is a judgement and these hours are a measurement, and Finance
  // has already chosen a split basis in Xero that ours must not contradict.
  const { rows } = aggregateWorkHours(
    [row({ sectionId: 'sec-group' })],
    [{ staffany_section_id: 'sec-group', venue_id: null, area: 'GROUP' }],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].venue_id, null);
  assert.equal(rows[0].area, 'GROUP');
  assert.equal(rows[0].total_cost, 120);
});

test('a group section is mapped, not unmapped', () => {
  // Confirmed-as-group and never-touched are different facts, and an unmapped
  // section is not ingested at all — so collapsing them would silently drop the
  // one section somebody had actually decided about.
  const result = aggregateWorkHours(
    [row({ sectionId: 'sec-group' })],
    [{ staffany_section_id: 'sec-group', venue_id: null, area: 'GROUP' }],
  );
  assert.deepEqual(result.unmapped_sections, []);
  assert.equal(result.skipped_rows, 0);
});

test('hours arrive as an object and must not read as zero', () => {
  // The bug that wrote a fortnight at 46,318.00 cost and 0.0 hours. `actualHours`
  // is singular and sounds like a number, and it is the same object shape as
  // cost. A zero denominator looks like an answer, which is what makes it worse
  // than a missing one.
  const { rows } = aggregateWorkHours(
    [row({
      actualHours: { basicHours: 8, overtimeHours: 2 },
      scheduledHours: { basicHours: 8 },
    })],
    MAPPINGS,
  );

  assert.equal(rows[0].actual_hours, 10);
  assert.equal(rows[0].overtime_hours, 2);
  assert.equal(rows[0].scheduled_hours, 8);
});

test('a plain numeric hours field still works', () => {
  const { rows } = aggregateWorkHours([row({ actualHours: 7.5, scheduledHours: 8 })], MAPPINGS);
  assert.equal(rows[0].actual_hours, 7.5);
  assert.equal(rows[0].scheduled_hours, 8);
});

test('components classify on the keyword, not the exact key', () => {
  // basicCost and basicHours must land in the same bucket, or one of the two
  // fields silently becomes all-other.
  assert.equal(splitComponents({ overtimeCost: 5 }).overtime, 5);
  assert.equal(splitComponents({ overtimeHours: 5 }).overtime, 5);
  assert.equal(splitComponents({ weekendHours: 3 }).weekend, 3);
  assert.equal(splitComponents({ somethingNew: 9 }).other, 9);
});

test('rows with no hours are counted apart from rows with no cost', () => {
  // They are different faults. Cost missing understates the total; hours
  // missing destroys every rate built on top of it.
  const r = aggregateWorkHours(
    [row({ actualHours: null, scheduledHours: null })],
    MAPPINGS,
  );
  assert.equal(r.hourless_rows, 1);
  assert.equal(r.costless_rows, 0);
});

// --- cost coverage: is the undocumented field still there? ------------------

/**
 * `actualCosts` is not in StaffAny's published contract. It was found by
 * reading a response, the question of whether it is supported was put to them
 * on 14 Sep 2026, and no answer has come. So it can vanish in a release note
 * nobody sends us — and without a guard the run writes zeros OVER correct
 * history, because the upsert keys on (section, business_date).
 */

const day = (over: Partial<{ actual_hours: number; total_cost: number }> = {}) => ({
  actual_hours: over.actual_hours ?? 8,
  total_cost: over.total_cost ?? 120,
});

test('complete coverage passes, which is the measured baseline', () => {
  // 156 of 156 rows carried cost on the probed week.
  const c = costCoverage([day(), day(), day()]);
  assert.equal(c.pct, 100);
  assert.equal(c.ok, true);
});

test('the field disappearing stops the run', () => {
  // Every row keeps its hours and loses its cost. This is the shape to catch.
  const c = costCoverage([
    day({ total_cost: 0 }), day({ total_cost: 0 }), day({ total_cost: 0 }),
  ]);
  assert.equal(c.pct, 0);
  assert.equal(c.ok, false);
});

test('one unpaid shift does not stop a night', () => {
  // An open shift or an unpaid break carrying hours and no cost is real, and
  // must not cost the whole ingest. The floor is set above that, not at 100%.
  const rows = [...Array(9)].map(() => day());
  rows.push(day({ total_cost: 0 }));

  const c = costCoverage(rows);
  assert.equal(c.pct, 90);
  assert.equal(c.ok, true);
});

test('the floor is where it stops being plausible', () => {
  const rows = [...Array(7)].map(() => day());
  rows.push(day({ total_cost: 0 }), day({ total_cost: 0 }), day({ total_cost: 0 }));

  const c = costCoverage(rows);
  assert.equal(c.pct, 70);
  assert.equal(c.ok, false, `${MIN_COST_COVERAGE_PCT}% is the floor`);
});

test('rows with no hours are not judged, in either direction', () => {
  // A row with neither hours nor cost is an empty shift and says nothing about
  // whether the field survived. Counting it as a miss would fail every quiet
  // week; counting it as a hit would hide a real loss behind them.
  const c = costCoverage([day(), day({ actual_hours: 0, total_cost: 0 })]);
  assert.equal(c.rows_with_hours, 1);
  assert.equal(c.pct, 100);
});

test('a closed window is nothing to judge, never a failure', () => {
  // A venue shut for the whole period returns no hours at all. Failing there
  // would be the Firangi-Sunday lesson: a legitimate zero read as a fault.
  const c = costCoverage([day({ actual_hours: 0, total_cost: 0 })]);
  assert.equal(c.pct, null);
  assert.equal(c.ok, true);
});
