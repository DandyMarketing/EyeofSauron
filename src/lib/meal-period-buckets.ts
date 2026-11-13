/**
 * Meal-period sales by CALENDAR week or month (Eiqah, Fat Prince, 3 Nov 2026).
 *
 * Asked for "the highest weekly lunch sales", Query called the meal-period tool
 * fourteen times, one seven-day range each, counting from the first day the
 * hourly report holds -- Thursday 30 July -- so every "week" ran Thursday to
 * Wednesday and its lunch total was two calendar weeks' lunches spliced
 * together. The table was then headed "Week (Mon–Fri)". The tool had no notion
 * of a week, so the model invented one from wherever the data started.
 *
 * Here a week is Monday to Sunday, always, and the bucket says so: its
 * calendar span, the days the data actually holds, and whether it is partial
 * (cut by the range, by the start of the data, or still in progress). One call
 * returns the whole run of weeks, so there is nothing left to loop over.
 *
 * PURE, so the boundaries are tested without a database.
 */
import { mondayOf, weekdayName } from './weekdays.js';

export type MealGrouping = 'week' | 'month';

export interface HourRow {
  business_date: string;
  meal_period: string;
  transactions: number | string;
  items: number | string;
  sales: number | string;
}

/** date -> shift -> covers, from SevenRooms. */
export type CoversByDate = Map<string, Record<string, number>>;

/**
 * A day one meal took far more than it usually does -- most often a private
 * event or a buyout (Khai, 13 Nov 2026). Monday 17 Aug 2026 at Fat Prince:
 * $5,338 of lunch from 21 covers, $254 a head against a usual $40-50. It put
 * its week at the top of "highest lunch week", and the answer read it as
 * trade. Flagged here so the answer can SAY so and offer the ranking without
 * it, rather than leaving it for somebody to notice.
 */
export interface UnusualDay {
  date: string;
  weekday: string;
  meal_period: string;
  sales: number;
  covers: number | null;
  spend_per_cover: number | null;
  typical_sales: number;
  typical_spend_per_cover: number | null;
  /** The week or month it falls in, matching a bucket's `period`. */
  in_bucket: string;
  why: string;
}

/** Fewer days of a meal than this and "usual" means nothing. */
const MIN_DAYS_TO_JUDGE = 8;
const SALES_MULTIPLE = 2.5;
const SPEND_MULTIPLE = 2.5;
const SALES_WITH_SPEND = 1.5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function unusualMealDays(rows: HourRow[], covers: CoversByDate, grouping: MealGrouping): UnusualDay[] {
  const byMealDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = byMealDay.get(r.meal_period) ?? new Map<string, number>();
    m.set(r.business_date, (m.get(r.business_date) ?? 0) + (Number(r.sales) || 0));
    byMealDay.set(r.meal_period, m);
  }
  const out: UnusualDay[] = [];
  for (const [meal, days] of byMealDay) {
    if (days.size < MIN_DAYS_TO_JUDGE) continue;
    const sales = [...days.values()];
    const typicalSales = median(sales);
    const spcs: number[] = [];
    for (const [d, s] of days) {
      const c = covers.get(d)?.[meal];
      if (c && c > 0) spcs.push(s / c);
    }
    const typicalSpc = spcs.length >= MIN_DAYS_TO_JUDGE ? median(spcs) : null;
    for (const [d, s] of days) {
      const c = covers.get(d)?.[meal] ?? null;
      const spc = c && c > 0 ? s / c : null;
      const salesHigh = typicalSales > 0 && s >= SALES_MULTIPLE * typicalSales;
      const spendHigh = typicalSpc != null && spc != null && spc >= SPEND_MULTIPLE * typicalSpc && s >= SALES_WITH_SPEND * typicalSales;
      if (!salesHigh && !spendHigh) continue;
      const parts: string[] = [];
      if (typicalSales > 0) parts.push(`sales ${(s / typicalSales).toFixed(1)}x a usual ${meal}`);
      if (spendHigh && typicalSpc) parts.push(`spend per cover ${(spc! / typicalSpc).toFixed(1)}x usual`);
      out.push({
        date: d,
        weekday: weekdayName(d),
        meal_period: meal,
        sales: r2(s),
        covers: c,
        spend_per_cover: spc != null ? r2(spc) : null,
        typical_sales: r2(typicalSales),
        typical_spend_per_cover: typicalSpc != null ? r2(typicalSpc) : null,
        in_bucket: grouping === 'week' ? mondayOf(d) : d.slice(0, 7),
        why: parts.join('; '),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface MealLine {
  period: string;
  sales: number;
  /** Present only when an unusual day of this meal falls in the bucket. */
  sales_without_unusual_days?: number;
  unusual_days?: string[];
  transactions: number;
  covers: number | null;
  avg_spend_per_cover: number | null;
  days_counted: number;
  /** Which weekdays it traded, Monday-first: shows lunch is Mon-Fri at a glance. */
  weekdays: string[];
}

export interface MealBucket {
  /** "2026-08-10" for the week starting Monday 10 Aug; "2026-08" for a month. */
  period: string;
  /** The calendar span: Monday-Sunday, or the 1st to the last of the month. */
  calendar_start: string;
  calendar_end: string;
  /** The first and last day the hourly report holds inside it. */
  first_day: string;
  last_day: string;
  partial: boolean;
  partial_reason?: string;
  meal_periods: MealLine[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const SHORT = (date: string) => weekdayName(date).slice(0, 3);

export function bucketMealPeriods(
  rows: HourRow[],
  covers: CoversByDate,
  grouping: MealGrouping,
  range: { from: string; to: string },
  mealFilter?: string,
  unusual: UnusualDay[] = [],
): MealBucket[] {
  const unusualKey = new Map<string, UnusualDay>(unusual.map(u => [`${u.meal_period}|${u.date}`, u]));
  const wanted = mealFilter ? mealFilter.toLowerCase() : null;
  const allDates = [...new Set(rows.map(r => r.business_date))].sort();
  if (allDates.length === 0) return [];
  const dataFirst = allDates[0];
  const dataLast = allDates[allDates.length - 1];

  type Acc = { sales: number; transactions: number; days: Set<string> };
  const buckets = new Map<string, { dates: Set<string>; lines: Map<string, Acc> }>();

  for (const r of rows) {
    const key = grouping === 'week' ? mondayOf(r.business_date) : r.business_date.slice(0, 7);
    const b = buckets.get(key) ?? { dates: new Set<string>(), lines: new Map<string, Acc>() };
    b.dates.add(r.business_date);
    buckets.set(key, b);
    if (wanted && r.meal_period.toLowerCase() !== wanted) continue;
    const acc = b.lines.get(r.meal_period) ?? { sales: 0, transactions: 0, days: new Set<string>() };
    acc.sales += Number(r.sales) || 0;
    acc.transactions += Number(r.transactions) || 0;
    acc.days.add(r.business_date);
    b.lines.set(r.meal_period, acc);
  }

  return [...buckets.keys()].sort().map(key => {
    const b = buckets.get(key)!;
    const calendar_start = grouping === 'week' ? key : `${key}-01`;
    const calendar_end = grouping === 'week' ? addDays(key, 6) : monthEnd(key);
    const dates = [...b.dates].sort();

    const reasons: string[] = [];
    if (calendar_start < range.from) reasons.push(`the range starts ${range.from}`);
    else if (calendar_start < dataFirst) reasons.push(`the hourly report starts ${dataFirst}`);
    if (calendar_end > range.to) reasons.push(`the range ends ${range.to}`);
    else if (calendar_end > dataLast) reasons.push(`the latest day held is ${dataLast}`);

    const meal_periods: MealLine[] = [...b.lines.entries()].map(([period, acc]) => {
      let c = 0;
      let matched = false;
      for (const d of acc.days) {
        const n = covers.get(d)?.[period];
        if (n != null) { c += n; matched = true; }
      }
      const days = [...acc.days].sort();
      const odd = days.map(d => unusualKey.get(`${period}|${d}`)).filter((u): u is UnusualDay => !!u);
      return {
        period,
        sales: r2(acc.sales),
        ...(odd.length ? {
          sales_without_unusual_days: r2(acc.sales - odd.reduce((s, u) => s + u.sales, 0)),
          unusual_days: odd.map(u => u.date),
        } : {}),
        transactions: acc.transactions,
        covers: matched ? c : null,
        avg_spend_per_cover: matched && c > 0 ? r2(acc.sales / c) : null,
        days_counted: days.length,
        weekdays: [...new Set(days.map(SHORT))],
      };
    }).sort((a, b) => b.sales - a.sales);

    return {
      period: key,
      calendar_start,
      calendar_end,
      first_day: dates[0],
      last_day: dates[dates.length - 1],
      partial: reasons.length > 0,
      partial_reason: reasons.length ? `Not a whole ${grouping}: ${reasons.join('; ')}.` : undefined,
      meal_periods,
    };
  });
}
