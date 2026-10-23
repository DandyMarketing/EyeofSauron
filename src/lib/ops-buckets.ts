/**
 * Daily operations over a long range, as weeks or months rather than days
 * (23 Oct 2026). Measured over the fortnight to 23 Oct: query_daily_operations
 * averaged 78,000 characters a call and reached 741,000 -- about 185,000 tokens
 * for one lookup -- because a half-year range returned every day's row. Every
 * later round of the same answer sends it again, and writing it into the cache
 * was most of what an Opus answer cost (BUILD_LOG 5.15).
 *
 * The totals were always computed in full; only the per-day rows are folded.
 * Same sums, same definitions, fewer lines: a bucket is built from the very
 * day rows the tool already made, so a week here cannot disagree with its days.
 */

export type OpsGrouping = 'day' | 'week' | 'month' | 'weekday';

/** Up to this many days, one row per day by default. */
export const DAILY_DEFAULT_MAX = 31;
/** Day rows are refused beyond this, however they are asked for. */
export const DAILY_HARD_MAX = 93;
/** Weeks up to here; months beyond. */
const WEEKLY_MAX = 120;

export interface DayRow {
  date: string;
  closed?: boolean;
  food_bev_sales: number;
  gross_sales: number;
  net_sales: number;
  service_charge: number | null;
  total_discounts: number;
  food_sales: number;
  beverage_sales: number;
  covers: number | null;
  walk_in_covers: number | null;
  no_show_covers: number | null;
  transactions: number | string | null;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const r2 = (n: number) => Math.round(n * 100) / 100;

/** What to return, and a sentence when the request was not followed. */
export function chooseGrouping(requested: unknown, days: number): { grouping: OpsGrouping; note?: string } {
  const fallback: OpsGrouping = days <= DAILY_DEFAULT_MAX ? 'day' : days <= WEEKLY_MAX ? 'week' : 'month';
  if (requested === 'week' || requested === 'month' || requested === 'weekday') return { grouping: requested };
  if (requested === 'day') {
    if (days <= DAILY_HARD_MAX) return { grouping: 'day' };
    return {
      grouping: fallback,
      note: `Day-by-day rows stop at ${DAILY_HARD_MAX} days; this range has ${days}, so it is returned by ${fallback}. For particular days, ask again with a shorter range around them.`,
    };
  }
  return { grouping: fallback };
}

/** Monday of the date's week, as YYYY-MM-DD. Dates are calendar days, read as UTC. */
function mondayOf(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): string {
  return WEEKDAYS[(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7];
}

function keyOf(date: string, g: Exclude<OpsGrouping, 'day'>): string {
  if (g === 'week') return mondayOf(date);
  if (g === 'month') return date.slice(0, 7);
  return weekdayOf(date);
}

export interface Bucket {
  period: string;
  first_day: string;
  last_day: string;
  days: number;
  trading_days: number;
  closed_days: number;
  food_bev_sales: number;
  gross_sales: number;
  net_sales: number;
  service_charge: number;
  total_discounts: number;
  discount_rate_pct: number | null;
  food_sales: number;
  beverage_sales: number;
  food_pct: number | null;
  covers: number;
  /** Trading days with no SevenRooms covers: spend per head leaves them out. */
  days_without_covers?: number;
  walk_in_covers: number;
  no_show_covers: number;
  transactions: number;
  avg_spend_per_head: number | null;
  avg_check: number | null;
  avg_daily_food_bev_sales: number | null;
  avg_daily_covers: number | null;
}

/**
 * Fold day rows into buckets. Closed days count as days but not trading days,
 * so the daily averages are per day TRADED, as the totals' are. Spend per head
 * divides food & beverage by covers over the days that have covers, so a day
 * SevenRooms never reported cannot pull it up.
 */
export function bucketDays(rows: DayRow[], grouping: Exclude<OpsGrouping, 'day'>): Bucket[] {
  const groups = new Map<string, DayRow[]>();
  for (const r of rows) {
    const k = keyOf(r.date, grouping);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const keys = [...groups.keys()];
  if (grouping === 'weekday') keys.sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));

  return keys.map(k => {
    const days = groups.get(k)!;
    const trading = days.filter(d => !d.closed);
    const withCovers = trading.filter(d => d.covers !== null && d.covers !== undefined);
    const sum = (f: (d: DayRow) => number | null | undefined, from = days) =>
      from.reduce((s, d) => s + (Number(f(d)) || 0), 0);

    const foodBev = sum(d => d.food_bev_sales);
    const gross = sum(d => d.gross_sales);
    const covers = sum(d => d.covers, withCovers);
    const net = sum(d => d.net_sales);
    const tx = sum(d => Number(d.transactions));
    const food = sum(d => d.food_sales);
    const discounts = sum(d => d.total_discounts);
    const foodBevWithCovers = sum(d => d.food_bev_sales, withCovers);
    const missing = trading.length - withCovers.length;

    return {
      period: grouping === 'week' ? `week of ${k}` : k,
      first_day: days[0].date,
      last_day: days[days.length - 1].date,
      days: days.length,
      trading_days: trading.length,
      closed_days: days.length - trading.length,
      food_bev_sales: r2(foodBev),
      gross_sales: r2(gross),
      net_sales: r2(net),
      service_charge: r2(sum(d => d.service_charge)),
      total_discounts: r2(discounts),
      // On gross sales, as the range's totals and each day's row divide it.
      discount_rate_pct: gross > 0 ? r2(discounts / gross * 100) : null,
      food_sales: r2(food),
      beverage_sales: r2(sum(d => d.beverage_sales)),
      food_pct: foodBev > 0 ? r2(food / foodBev * 100) : null,
      covers,
      ...(missing > 0 ? { days_without_covers: missing } : {}),
      walk_in_covers: sum(d => d.walk_in_covers, withCovers),
      no_show_covers: sum(d => d.no_show_covers, withCovers),
      transactions: tx,
      avg_spend_per_head: covers > 0 ? r2(foodBevWithCovers / covers) : null,
      avg_check: tx > 0 ? r2(net / tx) : null,
      avg_daily_food_bev_sales: trading.length > 0 ? r2(foodBev / trading.length) : null,
      avg_daily_covers: withCovers.length > 0 ? r2(covers / withCovers.length) : null,
    };
  });
}
