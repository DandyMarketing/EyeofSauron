/**
 * The cover forecast, and the ways a forecast flatters itself.
 *
 * The dangerous failures here all produce a number that looks fine: a backtest
 * that trains on the night it predicts scores beautifully and is worthless; a
 * ratio pickup turns three early bookings into ninety covers; a comparison
 * between methods scored on different nights is decided by the sample. Each is
 * a test because none would show on the page.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantile, parsePickup, pickupForecast, lastYearForecast, backtest, scoreBacktest,
  combineBacktests, seasonalLift, venueForecast, groupForecast, forecastNote, addDays,
  MIN_OBSERVATIONS, type PickupData, type BacktestRecord,
} from './forecast.js';

const V = 'venue-a';
const TODAY = '2026-10-04';          // a Sunday

/**
 * A synthetic venue over two years. Saturdays serve 120, every other night 60.
 * The book N days out is the night's served covers less 10 per day out — so the
 * TRUE pickup at lead L is exactly 10·L, and any forecast can be checked by hand.
 */
function synthetic(opts: {
  from?: string; to?: string;
  served?: (d: string) => number | null;
  booked?: (d: string, lead: number) => number;
  leads?: number[];
} = {}): PickupData {
  const from = opts.from ?? '2024-09-01';
  const to = opts.to ?? addDays(TODAY, -1);
  const leads = opts.leads ?? [1, 2, 3, 4, 5];
  const servedFn = opts.served ?? (d => (new Date(`${d}T00:00:00Z`).getUTCDay() === 6 ? 120 : 60));
  const bookedFn = opts.booked ?? ((d, l) => Math.max(0, (servedFn(d) ?? 0) - 10 * l));

  const finals: unknown[] = [], books: unknown[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = servedFn(d);
    finals.push([V, d, s ?? 0]);
    for (const l of leads) books.push([V, d, l, bookedFn(d, l)]);
  }
  return parsePickup({ finals, books });
}

describe('quantile', () => {
  test('interpolates between the two nearest values', () => {
    assert.equal(quantile([10, 20, 30, 40, 50], 0.5), 30);
    assert.equal(quantile([10, 20, 30, 40, 50], 0.2), 18);
    assert.equal(quantile([10, 20], 0.5), 15);
  });
  test('refuses an empty list rather than returning NaN into a forecast', () => {
    assert.throws(() => quantile([], 0.5));
  });
});

describe('reading the RPC', () => {
  test('a night that served nobody is not a trading night', () => {
    /**
     * Firangi shuts every Sunday. Kept as zeros, every Sunday would teach the
     * forecast that the walk-ins never came — and the last-year method would
     * scale a closure into a forecast.
     */
    const d = parsePickup({ finals: [[V, '2026-09-27', 0], [V, '2026-09-26', 88]], books: [] });
    assert.equal(d.served.get(V)?.has('2026-09-27'), false);
    assert.equal(d.served.get(V)?.get('2026-09-26'), 88);
  });

  test('nonsense in is nothing out, never a crash on the dashboard', () => {
    const d = parsePickup(null);
    assert.equal(d.served.size, 0);
    assert.equal(d.booked.size, 0);
  });
});

describe('the pickup forecast', () => {
  const data = synthetic();

  test('it is the book plus the usual pickup, not a ratio', () => {
    // Saturday 10 Oct, 6 days out is not a lead we built; use Tuesday 6 Oct,
    // two days out. True pickup at lead 2 is 20, so 35 booked forecasts 55.
    const f = pickupForecast(data, V, '2026-10-06', 2, 35, TODAY)!;
    assert.equal(f.mid, 55);
    assert.equal(f.n, 12, 'twelve weeks of Tuesdays');
  });

  test('a tiny early book does not explode into a huge forecast', () => {
    /**
     * The reason pickup is ADDITIVE. As a ratio, 3 booked five days out on a
     * night that usually has 10 at that point would multiply the final by six
     * — and on a night that usually has 1, by sixty. Adding the usual 50 is
     * stable at every size of book.
     */
    const f = pickupForecast(data, V, '2026-10-09', 5, 3, TODAY)!;
    assert.equal(f.mid, 53);
  });

  test('it learns from the SAME WEEKDAY only', () => {
    // Saturdays pick up the same 10/day here but serve double — so their max
    // served would be wrong for a Tuesday. Check it did not leak in.
    const f = pickupForecast(data, V, '2026-10-06', 2, 35, TODAY)!;
    assert.equal(f.max_served, 60, 'Saturday nights were mixed into a Tuesday forecast');
  });

  test('it learns from the same number of days out only', () => {
    const one = pickupForecast(data, V, '2026-10-06', 1, 35, TODAY)!;
    const four = pickupForecast(data, V, '2026-10-06', 4, 35, TODAY)!;
    assert.equal(one.mid, 45);
    assert.equal(four.mid, 75);
  });

  test('it uses only nights served BEFORE the forecast was made', () => {
    /**
     * The backtest depends on this. Change a night's outcome AFTER the forecast
     * date and the forecast must not move — if it does, a backtest would be
     * scoring a method that had seen the answer.
     */
    const asOf = '2026-09-01';
    const before = pickupForecast(data, V, '2026-09-08', 2, 35, asOf)!;
    const tampered = synthetic({ served: d => (d >= asOf ? 999 : (new Date(`${d}T00:00:00Z`).getUTCDay() === 6 ? 120 : 60)) });
    const after = pickupForecast(tampered, V, '2026-09-08', 2, 35, asOf)!;
    assert.deepEqual(after, before);
  });

  test('only the last twelve weeks count', () => {
    // A venue that picked up 100 per night two years ago and 20 now must
    // forecast on now.
    const changed = synthetic({ booked: (d, l) => (d < '2026-06-01' ? 0 : Math.max(0, 60 - 10 * l)) });
    const f = pickupForecast(changed, V, '2026-10-06', 2, 35, TODAY)!;
    assert.equal(f.mid, 55);
  });

  test('too few comparable nights is no forecast, not a confident one', () => {
    const young = synthetic({ from: '2026-09-01' });
    assert.equal(pickupForecast(young, V, '2026-10-06', 2, 35, TODAY), null);
  });

  test('a closed weekday has no comparable nights at all', () => {
    // Firangi on a Sunday: no trading Sundays, so nothing to learn from.
    const shutSundays = synthetic({ served: d => (new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? null : 60) });
    assert.equal(pickupForecast(shutSundays, V, '2026-10-11', 5, 0, '2026-10-06'), null);
  });

  test('the range brackets the middle and never goes below zero', () => {
    // Noisy pickups, some of them heavy net cancellations.
    let k = 0;
    const noisy = synthetic({ booked: (d, l) => 60 - 10 * l + ((k++ * 7) % 23) - 11 });
    const f = pickupForecast(noisy, V, '2026-10-06', 2, 0, TODAY)!;
    assert.ok(f.lo <= f.mid && f.mid <= f.hi, JSON.stringify(f));
    assert.ok(f.lo >= 0);
  });

  test('a book above anything served recently is detectable', () => {
    const f = pickupForecast(data, V, '2026-10-06', 2, 140, TODAY)!;
    assert.ok(140 > f.max_served);
  });
});

describe("Khai's method: last year, scaled", () => {
  test('364 days back keeps the weekday', () => {
    /**
     * 365 would compare a Saturday with a Sunday. On this synthetic venue that
     * is 120 against 60 — the single biggest error available, from one day of
     * arithmetic.
     */
    const data = synthetic();
    // Saturday 10 Oct 2026; 364 days back is Saturday 11 Oct 2025.
    assert.equal(lastYearForecast(data, V, '2026-10-10', TODAY), 120);
  });

  test('it is scaled by how this year is running against last', () => {
    // Everything this year is 25% busier than last year.
    const grown = synthetic({
      served: d => {
        const base = new Date(`${d}T00:00:00Z`).getUTCDay() === 6 ? 120 : 60;
        return d >= '2026-01-01' ? base * 1.25 : base;
      },
    });
    assert.equal(lastYearForecast(grown, V, '2026-10-10', TODAY), 150);
  });

  test('it averages three weeks, not one night', () => {
    // A single freak night last year must not BE the forecast.
    const freak = synthetic({ served: d => (d === '2025-10-11' ? 300 : new Date(`${d}T00:00:00Z`).getUTCDay() === 6 ? 120 : 60) });
    assert.equal(lastYearForecast(freak, V, '2026-10-10', TODAY), 180);  // (120+300+120)/3
  });

  test('no history a year back is no forecast', () => {
    assert.equal(lastYearForecast(synthetic({ from: '2026-03-01' }), V, '2026-10-10', TODAY), null);
  });
});

describe('the backtest', () => {
  test('it scores every past trading night at every lead', () => {
    const recs = backtest(synthetic(), V, TODAY, [1, 3], 14);
    assert.equal(recs.length, 28);
    assert.ok(recs.every(r => r.target < TODAY));
  });

  test('a perfectly regular venue is forecast perfectly — the method is sound', () => {
    const recs = backtest(synthetic(), V, TODAY, [1, 3, 5]);
    const acc = scoreBacktest(recs, [1, 3, 5]);
    for (const a of acc) {
      assert.equal(a.pickup.mae, 0, `lead ${a.lead}`);
      assert.equal(a.pickup.in_range_pct, 100);
    }
  });

  test('pickup beats last year when the book carries news last year cannot know', () => {
    /**
     * The honest version of the argument. A venue whose nights swing on WHO
     * books — here, an alternating busy and quiet week — is invisible to last
     * year's pattern and fully visible in the book.
     */
    const swing = (d: string) => {
      const week = Math.floor(Date.parse(`${d}T00:00:00Z`) / (7 * 86_400_000));
      return week % 2 === 0 ? 90 : 50;
    };
    const data = synthetic({ served: swing, booked: (d, l) => swing(d) - 10 * l });
    const acc = scoreBacktest(backtest(data, V, TODAY, [3]), [3])[0];
    assert.ok(acc.last_year !== null);
    assert.ok(acc.pickup.mae < acc.last_year!.mae, JSON.stringify(acc));
  });

  test('a closed night is not scored', () => {
    const shut = synthetic({ served: d => (new Date(`${d}T00:00:00Z`).getUTCDay() === 0 ? null : 60) });
    const recs = backtest(shut, V, TODAY, [1], 28);
    assert.ok(recs.every(r => new Date(`${r.target}T00:00:00Z`).getUTCDay() !== 0));
  });
});

describe('scoring', () => {
  const rec = (actual: number, mid: number, lo: number, hi: number, ly: number | null): BacktestRecord => ({
    target: '2026-09-01', lead: 3, actual, booked: 0,
    pickup: { mid, lo, hi, n: 12, max_served: 999 }, last_year: ly,
  });

  test('average miss, share of covers, and lean are what they say', () => {
    const recs = Array.from({ length: MIN_OBSERVATIONS }, (_, i) =>
      i % 2 === 0 ? rec(100, 110, 90, 120, 100) : rec(100, 96, 90, 120, 100));
    const [a] = scoreBacktest(recs, [3]);
    assert.equal(a.pickup.mae, 7);          // (10 + 4) / 2
    assert.equal(a.pickup.wape_pct, 7);     // 42 / 600
    assert.equal(a.pickup.bias, 3);         // (+10 − 4) / 2: runs high
    assert.equal(a.pickup.in_range_pct, 100);
  });

  test('both methods are scored on the SAME nights', () => {
    /**
     * Last year has no forecast for a night whose equivalent was closed. If
     * pickup were scored on those nights too, the two would be marked on
     * different samples and the comparison decided by which nights each got.
     */
    const recs = [
      ...Array.from({ length: MIN_OBSERVATIONS }, () => rec(100, 100, 90, 110, 120)),
      rec(100, 160, 150, 170, null),  // a pickup miss on a night last year cannot score
    ];
    const [a] = scoreBacktest(recs, [3]);
    assert.equal(a.n, MIN_OBSERVATIONS);
    assert.equal(a.pickup.mae, 0, 'pickup was scored on a night last year was not');
  });

  test('with no usable last year, pickup is scored alone and says so', () => {
    const recs = Array.from({ length: MIN_OBSERVATIONS }, () => rec(100, 100, 90, 110, null));
    const [a] = scoreBacktest(recs, [3]);
    assert.equal(a.last_year, null);
    assert.equal(a.n, MIN_OBSERVATIONS);
  });

  test('a night outside the range counts against it', () => {
    const recs = Array.from({ length: 10 }, (_, i) => rec(i < 6 ? 100 : 200, 100, 90, 110, 100));
    assert.equal(scoreBacktest(recs, [3])[0].pickup.in_range_pct, 60);
  });
});

describe('the group', () => {
  const r = (venue: string, actual: number, mid: number | null): BacktestRecord => ({
    target: '2026-09-27', lead: 2, actual, booked: 0,
    pickup: mid === null ? null : { mid, lo: mid - 5, hi: mid + 5, n: 12, max_served: actual },
    last_year: mid,
  });

  test('a closed venue contributes nothing to either side', () => {
    // Firangi is shut on Sunday: no record, so the group is the other two.
    const [g] = combineBacktests([[r('a', 80, 70)], [r('b', 40, 50)], []]);
    assert.equal(g.actual, 120);
    assert.equal(g.pickup!.mid, 120);
  });

  test('a venue that could not forecast makes the group night unscorable', () => {
    // Two forecasts against three actuals would score a miss nobody made.
    const [g] = combineBacktests([[r('a', 80, 70)], [r('b', 40, null)]]);
    assert.equal(g.pickup, null);
    assert.equal(g.actual, 120);
  });
});

describe('seasonality, reported rather than applied', () => {
  /** Weekends at 150, weeknights at 60, scaled by `f(date)`. */
  const shaped = (f: (d: string) => number) => {
    const series = new Map<string, number>();
    for (let d = '2025-06-01'; d <= '2025-10-31'; d = addDays(d, 1)) {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      series.set(d, Math.round((wd === 5 || wd === 6 ? 150 : 60) * f(d)));
    }
    return series;
  };

  test('last year running busier than the weeks before it is measured', () => {
    // Last October ran 30% above last summer, weekday for weekday.
    assert.equal(seasonalLift(shaped(d => (d >= '2025-10-05' ? 1.3 : 1)), TODAY, 5), 30);
  });

  test('a window without a weekend is NOT a quiet season', () => {
    /**
     * Caught on the first render. Five coming nights that happen to be Monday
     * to Thursday were compared with an average that included Fridays and
     * Saturdays, and a venue built to be BUSIER read "22% quieter". The measure
     * was reading which weekdays were in the window. With no seasonal change at
     * all, the lift must be zero whichever five days come next.
     */
    const flat = shaped(() => 1);
    // 4 Oct 2026 is a Sunday; the next four nights a year back are Mon–Thu.
    assert.equal(seasonalLift(flat, TODAY, 4), 0);
    // And a window that DOES include the weekend.
    assert.equal(seasonalLift(flat, '2026-10-07', 5), 0);
  });

  test('no history a year back is null, never zero', () => {
    assert.equal(seasonalLift(new Map([['2026-09-01', 100]]), TODAY, 5), null);
  });
});

describe('the forecast for the coming days', () => {
  const data = synthetic();
  const days = [
    { date: '2026-10-05', booked: 50, closed: false },
    { date: '2026-10-06', booked: 40, closed: false },
    { date: '2026-10-07', booked: 0, closed: true },
    { date: '2026-10-08', booked: 200, closed: false },
  ];

  test('each open day gets the book plus its own lead\'s pickup', () => {
    const f = venueForecast(data, V, TODAY, days, [1, 2, 3, 4, 5], new Map());
    assert.deepEqual(f.days.map(d => d.mid), [60, 60, null, 240]);
    assert.deepEqual(f.days.map(d => d.lead), [1, 2, 3, 4]);
  });

  test('a closed day is never forecast', () => {
    const f = venueForecast(data, V, TODAY, days, [1, 2, 3, 4, 5], new Map());
    assert.equal(f.days[2].mid, null);
    assert.equal(f.days[2].last_year, null);
  });

  test('a book beyond anything recently served is flagged', () => {
    // 200 booked on a Thursday that has never served more than 60: a buyout.
    const f = venueForecast(data, V, TODAY, days, [1, 2, 3, 4, 5], new Map());
    assert.equal(f.days[3].beyond_history, true);
    assert.equal(f.days[0].beyond_history, false);
    assert.match(f.note, /buyout or event/);
  });

  test('a public holiday is flagged and named, not modelled', () => {
    const f = venueForecast(data, V, TODAY, days, [1, 2, 3, 4, 5], new Map([['2026-10-06', 'Deepavali']]));
    assert.equal(f.days[1].holiday, 'Deepavali');
    assert.match(f.note, /Deepavali falls in this window/);
    assert.match(f.note, /flagged, not modelled/);
  });

  test('today is never forecast — it is live', () => {
    const f = venueForecast(data, V, TODAY, [{ date: TODAY, booked: 40, closed: false }], [1], new Map());
    assert.equal(f.days[0].mid, null);
  });
});

describe('the group forecast', () => {
  const day = (over: Record<string, unknown>) => ({
    date: '2026-10-05', lead: 1, booked: 50, closed: false, mid: 60, lo: 50, hi: 70, n: 12,
    last_year: 55, beyond_history: false, holiday: null, ...over,
  });
  const fc = (d: Record<string, unknown>) => ({ days: [day(d)] as any, accuracy: [], seasonal_lift_pct: null, note: '' });

  test('sums the open venues and ignores the closed one', () => {
    const g = groupForecast([fc({}), fc({ mid: 40, lo: 30, hi: 50, booked: 20 }), fc({ closed: true, mid: null, lo: null, hi: null, booked: 0 })], [], null);
    assert.equal(g.days[0].mid, 100);
    assert.equal(g.days[0].booked, 70);
  });

  test('no group number when an OPEN venue has none', () => {
    const g = groupForecast([fc({}), fc({ mid: null, lo: null, hi: null })], [], null);
    assert.equal(g.days[0].mid, null);
  });

  test('says its range is wider than the truth', () => {
    const g = groupForecast([fc({}), fc({})], [], null);
    assert.match(g.note, /wider than the true group range/);
  });
});

describe('the sentence', () => {
  const acc = (lead: number, pmae: number, lymae: number | null, bias = 0) => ({
    lead, n: 26,
    pickup: { mae: pmae, wape_pct: 8, bias, in_range_pct: 62 },
    last_year: lymae === null ? null : { mae: lymae, wape_pct: 19, bias: 0 },
  });

  test('it reports accuracy in covers, from the backtest', () => {
    const n = forecastNote([], [acc(1, 6, 15), acc(3, 9, 21), acc(5, 12, 22)], null);
    assert.match(n, /3 days out it missed by 9 covers on an average night \(8%\)/);
    assert.match(n, /inside the range 62% of the time/);
  });

  test('when last year is worse it says that is why it is not used', () => {
    assert.match(forecastNote([], [acc(3, 9, 21)], null), /missed by 21 — which is why it is shown for comparison and not used/);
  });

  test('when last year is better it does NOT claim otherwise', () => {
    const n = forecastNote([], [acc(3, 21, 9)], null);
    assert.ok(!/why it is shown for comparison and not used/.test(n), n);
  });

  test('a consistent lean is named', () => {
    assert.match(forecastNote([], [acc(3, 10, null, -7)], null), /tended to run 7 covers LOW/);
  });

  test('a seasonal turn ahead is named with the end of the range to expect', () => {
    assert.match(forecastNote([], [], 18), /18% busier than the same weekdays .* expect the top of the range/);
    assert.ok(!/busier/.test(forecastNote([], [], 4)), 'a 4% wobble is not a season');
  });

  test('with no backtest it says it is unscored', () => {
    assert.match(forecastNote([], [], null), /Not yet scored/);
  });
});
