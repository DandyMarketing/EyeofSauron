import { test } from 'node:test';
import assert from 'node:assert';
import {
  decompose,
  precedingPeriod,
  SPEND_PER_HEAD_NOISE_PCT,
  MIN_TRADING_DAYS,
  type PeriodRow,
} from './revenue-decomposition.js';

/**
 * The property that makes this worth having is that the parts SUM to the whole.
 * Everything else here defends the reader from a true number that means
 * something other than it appears to.
 */

const row = (over: Partial<PeriodRow> = {}): PeriodRow => ({
  venue_id: 'v1',
  period: 'current',
  net_sales: 44433,
  covers: 575,
  booked_covers: 500,
  walkin_covers: 75,
  bookings: 190,
  trading_days: 7,
  ...over,
});

test('the parts sum to the change, exactly', () => {
  // The whole argument for decomposition over correlation. If this ever fails,
  // the output is an estimate wearing the clothes of an identity.
  const d = decompose(
    row({ net_sales: 44433, covers: 575 }),
    row({ period: 'prior', net_sales: 49864, covers: 672 }),
  );

  const summed = d.drivers.reduce((n, c) => n + c.amount, 0);
  assert.equal(Math.round(summed * 100) / 100, d.net_sales.change);
  assert.equal(d.net_sales.change, -5431);
});

test('a pure cover fall is attributed to covers and nothing else', () => {
  // Spend per head held exactly, so the cover term must carry the whole change
  // and the other two must be zero.
  const d = decompose(
    row({ net_sales: 5000, covers: 100 }),
    row({ period: 'prior', net_sales: 10000, covers: 200 }),
  );

  assert.equal(d.drivers[0].amount, -5000);
  assert.equal(d.drivers[1].amount, 0);
  assert.equal(d.drivers[2].amount, 0);
  assert.equal(d.drivers[0].share_pct, 100);
});

test('a pure spend fall is attributed to spend and nothing else', () => {
  const d = decompose(
    row({ net_sales: 8000, covers: 100 }),
    row({ period: 'prior', net_sales: 10000, covers: 100 }),
  );

  assert.equal(d.drivers[0].amount, 0);
  assert.equal(d.drivers[1].amount, -2000);
});

test('the interaction term is reported, never hidden in the other two', () => {
  // Both moved, so a third term genuinely exists. Allocating it across the
  // others would turn two exact figures into two estimates to conceal a third.
  const d = decompose(
    row({ net_sales: 4000, covers: 80 }),      // 50/head
    row({ period: 'prior', net_sales: 10000, covers: 100 }), // 100/head
  );

  assert.equal(d.drivers[2].label, 'Combined effect');
  assert.notEqual(d.drivers[2].amount, 0);
  const summed = d.drivers.reduce((n, c) => n + c.amount, 0);
  assert.equal(Math.round(summed * 100) / 100, d.net_sales.change);
});

test('a booked-cover fall points at the booking pipe', () => {
  // The measured April 2025 shape at Neon Pigeon: booked covers halved while
  // walk-ins held. That is a broken booking pipe, not a failing venue, and the
  // decomposition has to end by saying where to look.
  const d = decompose(
    row({ covers: 400, booked_covers: 300, walkin_covers: 100 }),
    row({ period: 'prior', covers: 700, booked_covers: 600, walkin_covers: 100 }),
  );

  assert.match(d.caveats.join(' '), /mostly BOOKED covers/);
  assert.match(d.caveats.join(' '), /check_booking_channels/);
});

test('a walk-in fall points outside the building', () => {
  // No booking channel explains a walk-in change, and sending somebody to
  // check one would waste the morning.
  const d = decompose(
    row({ covers: 400, booked_covers: 300, walkin_covers: 100 }),
    row({ period: 'prior', covers: 550, booked_covers: 300, walkin_covers: 250 }),
  );

  assert.match(d.caveats.join(' '), /mostly WALK-INS/);
  assert.doesNotMatch(d.caveats.join(' '), /check_booking_channels/);
});

test('a small spend-per-head move is called noise', () => {
  // Revenue is Revel's and covers are SevenRooms' booked party size. The two
  // disagree slightly by design, so a small move here is two systems counting
  // rather than guests behaving.
  const d = decompose(
    row({ net_sales: 10100, covers: 100 }),
    row({ period: 'prior', net_sales: 10000, covers: 100 }),
  );

  assert.match(d.caveats.join(' '), new RegExp(`less than ${SPEND_PER_HEAD_NOISE_PCT}%`));
});

test('unequal trading days are flagged before anyone reads the total', () => {
  // Firangi closes Sundays and holidays move everything. Part of the change is
  // simply days open, and a reader who does not know reads it as trade.
  const d = decompose(row({ trading_days: 6 }), row({ period: 'prior', trading_days: 7 }));
  assert.match(d.caveats.join(' '), /different numbers of trading days/);
});

test('a part-period comparison is refused as a finding', () => {
  const d = decompose(row({ trading_days: 3 }), row({ period: 'prior', trading_days: 7 }));
  assert.match(d.caveats.join(' '), new RegExp(`fewer than ${MIN_TRADING_DAYS} trading days`));
});

test('no covers means no spend per head, and says so', () => {
  // Rather than dividing by zero and reporting a null as if it were a finding.
  const d = decompose(row({ covers: 0, net_sales: 0 }), row({ period: 'prior' }));
  assert.equal(d.spend_per_head.to, null);
  assert.match(d.caveats.join(' '), /no completed covers/);
});

test('party size is bookings-based and survives the split', () => {
  const d = decompose(
    row({ booked_covers: 500, bookings: 200 }),
    row({ period: 'prior', booked_covers: 600, bookings: 200 }),
  );
  assert.equal(d.booked.party_from, 3);
  assert.equal(d.booked.party_to, 2.5);
});

test('the preceding period matches the length of the one asked about', () => {
  // A fortnight compares against the fortnight before it. Comparing unequal
  // spans reports arithmetic as performance.
  assert.deepEqual(precedingPeriod('2026-08-31', '2026-09-06'), { start: '2026-08-24', end: '2026-08-30' });
  assert.deepEqual(precedingPeriod('2026-09-01', '2026-09-14'), { start: '2026-08-18', end: '2026-08-31' });
  assert.deepEqual(precedingPeriod('2026-09-07', '2026-09-07'), { start: '2026-09-06', end: '2026-09-06' });
});

const week = (start: string, net: number, covers = 600) =>
  ({ period: `week:${start}`, net_sales: net, covers });

test('down on the week and up on the run rate is stated outright', () => {
  // The measured Fat Prince case, 9 Sep 2026: 11% below the previous week and
  // 17% above the four-week average. Week-on-week alone reports a crash and
  // sends somebody to fix a venue that was performing.
  const d = decompose(
    row({ net_sales: 44433 }),
    row({ period: 'prior', net_sales: 49864 }),
    [
      week('2026-07-06', 38379), week('2026-07-13', 37948),
      week('2026-07-20', 40090), week('2026-07-27', 35157),
    ],
  );

  assert.equal(d.baseline.weeks.length, 4);
  assert.ok(d.baseline.vs_mean_pct !== null && d.baseline.vs_mean_pct > 0);
  assert.match(d.caveats.join(' '), /ABOVE the 4-week average/);
  assert.match(d.caveats.join(' '), /not this one the collapse/);
});

test('up on the week and below the run rate is not a good week', () => {
  const d = decompose(
    row({ net_sales: 30000 }),
    row({ period: 'prior', net_sales: 28000 }),
    [week('a', 40000), week('b', 41000), week('c', 39000), week('d', 40000)],
  );
  assert.match(d.caveats.join(' '), /A recovery from a bad period is not a good period/);
});

test('direction needs more weeks than a baseline does', () => {
  // Four weeks say whether a period is unusual and cannot say which way things
  // are heading. The two thresholds differ deliberately.
  const four = decompose(row(), row({ period: 'prior' }),
    [week('a', 100), week('b', 100), week('c', 100), week('d', 100)]);
  assert.equal(four.baseline.direction, 'unknown');
  assert.match(four.caveats.join(' '), /fewer than the 6 needed to call a direction/);
});

test('a rising run rate is reported as such', () => {
  const d = decompose(row(), row({ period: 'prior' }), [
    week('2026-07-06', 30000), week('2026-07-13', 31000), week('2026-07-20', 30500),
    week('2026-07-27', 40000), week('2026-08-03', 41000), week('2026-08-10', 40500),
  ]);
  assert.equal(d.baseline.direction, 'rising');
  assert.match(d.caveats.join(' '), /run rate is rising/);
});

test('ordinary wobble is flat, not a trend', () => {
  // A lower bar would report a direction every week, which is the same as
  // reporting none.
  const d = decompose(row(), row({ period: 'prior' }), [
    week('a', 40000), week('b', 41000), week('c', 39500),
    week('d', 40500), week('e', 40200), week('f', 41000),
  ]);
  assert.equal(d.baseline.direction, 'flat');
  assert.doesNotMatch(d.caveats.join(' '), /run rate is/);
});

test('the baseline says whether a period is outside the range it has seen', () => {
  const d = decompose(
    row({ net_sales: 60000 }),
    row({ period: 'prior', net_sales: 40000 }),
    [week('a', 38000), week('b', 41000), week('c', 39000), week('d', 40000)],
  );
  assert.equal(d.baseline.standing, 'above the range');
  assert.equal(d.baseline.max_net_sales, 41000);
});

test('weeks come back oldest first whatever order the database returned them', () => {
  const d = decompose(row(), row({ period: 'prior' }), [
    week('2026-08-10', 3), week('2026-07-06', 1), week('2026-07-27', 2),
    week('2026-08-17', 4),
  ]);
  assert.deepEqual(d.baseline.weeks.map(w => w.net_sales), [1, 2, 3, 4]);
});
