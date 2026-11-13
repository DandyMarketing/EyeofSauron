import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketMealPeriods, unusualMealDays, type HourRow } from './meal-period-buckets.js';

// Thu 30 Jul 2026 to Wed 12 Aug 2026: lunch Mon-Fri, brunch Sat-Sun, as Fat Prince.
function days(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const rows: HourRow[] = days('2026-07-30', 14).flatMap(date => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const midday = dow === 0 || dow === 6 ? 'brunch' : 'lunch';
  return [
    { business_date: date, meal_period: midday, transactions: 10, items: 30, sales: 1000 },
    { business_date: date, meal_period: 'dinner', transactions: 20, items: 60, sales: 3000 },
  ];
});

test('weeks run Monday to Sunday, never from the first day of data', () => {
  const b = bucketMealPeriods(rows, new Map(), 'week', { from: '2026-07-30', to: '2026-08-12' });
  assert.deepEqual(b.map(x => [x.calendar_start, x.calendar_end]), [
    ['2026-07-27', '2026-08-02'],
    ['2026-08-03', '2026-08-09'],
    ['2026-08-10', '2026-08-16'],
  ]);
});

test('a whole week counts five lunches; cut weeks say why they are partial', () => {
  const b = bucketMealPeriods(rows, new Map(), 'week', { from: '2026-07-30', to: '2026-08-12' });
  const lunch = (i: number) => b[i].meal_periods.find(m => m.period === 'lunch')!;
  assert.equal(b[1].partial, false);
  assert.equal(lunch(1).days_counted, 5);
  assert.equal(lunch(1).sales, 5000);
  assert.deepEqual(lunch(1).weekdays, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  assert.equal(b[0].partial, true);
  assert.match(b[0].partial_reason!, /range starts 2026-07-30/);
  assert.equal(b[2].partial, true);
  assert.match(b[2].partial_reason!, /range ends 2026-08-12/);
});

test('a meal filter keeps only that meal and still dates the buckets from all data', () => {
  const b = bucketMealPeriods(rows, new Map(), 'week', { from: '2026-07-30', to: '2026-08-12' }, 'LUNCH');
  assert.ok(b.every(x => x.meal_periods.every(m => m.period === 'lunch')));
  assert.equal(b.length, 3);
});

test('covers are matched by date and meal; missing covers are null, not zero', () => {
  const covers = new Map([['2026-08-03', { lunch: 20 }], ['2026-08-04', { lunch: 30 }]]);
  // The handler reads only the range, so the rows arrive already inside it.
  const inRange = rows.filter(r => r.business_date >= '2026-08-03' && r.business_date <= '2026-08-09');
  const b = bucketMealPeriods(inRange, covers, 'week', { from: '2026-08-03', to: '2026-08-09' });
  const lunch = b[0].meal_periods.find(m => m.period === 'lunch')!;
  const dinner = b[0].meal_periods.find(m => m.period === 'dinner')!;
  assert.equal(lunch.covers, 50);
  assert.equal(lunch.avg_spend_per_cover, 100);
  assert.equal(dinner.covers, null);
});

test('an event-sized day is flagged, and its week shows the total without it', () => {
  // Monday 3 Aug lunch takes $5,000 from 20 covers; every other lunch $1,000 from 25.
  const withEvent = rows.map(r => r.business_date === '2026-08-03' && r.meal_period === 'lunch' ? { ...r, sales: 5000 } : r);
  const covers = new Map<string, Record<string, number>>();
  for (const r of withEvent) if (r.meal_period === 'lunch') covers.set(r.business_date, { lunch: r.business_date === '2026-08-03' ? 20 : 25 });
  const odd = unusualMealDays(withEvent, covers, 'week');
  assert.equal(odd.length, 1);
  assert.equal(odd[0].date, '2026-08-03');
  assert.equal(odd[0].in_bucket, '2026-08-03');
  assert.equal(odd[0].typical_spend_per_cover, 40);
  const b = bucketMealPeriods(withEvent, covers, 'week', { from: '2026-07-30', to: '2026-08-12' }, undefined, odd);
  const lunch = b[1].meal_periods.find(m => m.period === 'lunch')!;
  assert.equal(lunch.sales, 9000);
  assert.equal(lunch.sales_without_unusual_days, 4000);
  assert.deepEqual(lunch.unusual_days, ['2026-08-03']);
  assert.equal(b[0].meal_periods.find(m => m.period === 'lunch')!.unusual_days, undefined);
});

test('nothing is judged unusual on too few days', () => {
  const few = rows.filter(r => r.business_date <= '2026-08-02');
  assert.deepEqual(unusualMealDays(few, new Map(), 'week'), []);
});

test('months span the calendar month', () => {
  const b = bucketMealPeriods(rows, new Map(), 'month', { from: '2026-07-01', to: '2026-08-31' });
  assert.deepEqual(b.map(x => [x.period, x.calendar_end, x.partial]), [
    ['2026-07', '2026-07-31', true],
    ['2026-08', '2026-08-31', true],
  ]);
  assert.match(b[0].partial_reason!, /hourly report starts 2026-07-30/);
});
