import { supabase } from '../lib/supabase.js';
import { getCovers } from '../lib/covers.js';
import { netSalesOf, foodAndBevSalesOf, grossSalesOf } from '../lib/sales.js';

/**
 * Chart data assembly.
 *
 * The model never supplies numbers. It chooses a metric, a venue set, a date
 * range and a chart type; everything plotted is re-queried from the warehouse
 * here. That keeps charts under the same anti-hallucination rule as the rest
 * of the system -- a figure on a chart is a figure from a query, always.
 */

export type Metric =
  | 'gross_sales'
  | 'food_bev_sales'
  | 'net_sales'
  | 'covers'
  | 'avg_spend_per_head'
  | 'avg_check'
  | 'walk_in_pct'
  | 'no_show_rate';

export type Granularity = 'day' | 'week' | 'month' | 'day_of_week';

/** Monday-first, because a trading week reads Mon..Sun, not Sun..Sat. */
const DOW_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Metrics that are running totals rather than ratios.
 *
 * Only these need dividing by the number of trading days when bucketing by
 * weekday: summing six months of Tuesdays gives a meaningless five-figure bar.
 * The ratio metrics (avg_check, spend per head, walk-in %, no-show %) are
 * already computed as summed-numerator over summed-denominator, which is the
 * correct weighted average over any number of days -- they need no adjustment.
 */
const ADDITIVE_METRICS = new Set<Metric>(['gross_sales', 'food_bev_sales', 'net_sales', 'covers']);

/** Below this many trading days a weekday average is noise, not a pattern. */
const LOW_SAMPLE_DAYS = 4;

export interface ChartSeries {
  name: string;
  /** `n` is the number of trading days behind the value, set for day_of_week. */
  points: Array<{ label: string; value: number | null; n?: number }>;
}

export interface ChartSpec {
  type: 'line' | 'bar';
  title: string;
  metric: Metric;
  unit: 'currency' | 'count' | 'percent';
  granularity: Granularity;
  source: string;
  series: ChartSeries[];
  /** Days excluded because the venue was closed (zero sales, zero transactions). */
  closed_days: number;
  /**
   * A weekday bucket resting on very few trading days. Firangi Superstar shuts
   * most Sundays, so its Sunday bar can be an average of two -- which must not
   * be read as a pattern.
   */
  low_sample_days: boolean;
  /**
   * Whether the first/last bucket covers only part of its period. A range
   * ending today leaves a stub month, and comparing two days of August against
   * full months reads as a ~95% collapse. Flagged so the summary can exclude
   * them from trend maths and the chart can say so.
   */
  partial_first: boolean;
  partial_last: boolean;
}

const METRIC_META: Record<Metric, { label: string; unit: ChartSpec['unit']; source: string }> = {
  gross_sales:        { label: 'Gross sales',        unit: 'currency', source: 'Revel (POS)' },
  food_bev_sales:     { label: 'Food & beverage sales', unit: 'currency', source: 'Revel (POS)' },
  net_sales:          { label: 'Net sales',          unit: 'currency', source: 'Revel (POS)' },
  avg_check:          { label: 'Average check',      unit: 'currency', source: 'Revel (POS)' },
  covers:             { label: 'Covers',             unit: 'count',    source: 'SevenRooms' },
  avg_spend_per_head: { label: 'Spend per head',     unit: 'currency', source: 'Revel revenue / SevenRooms covers' },
  walk_in_pct:        { label: 'Walk-in share',      unit: 'percent',  source: 'SevenRooms' },
  no_show_rate:       { label: 'No-show rate',       unit: 'percent',  source: 'SevenRooms' },
};

/**
 * Pick a sensible bucket size when the model does not specify one. Plotting a
 * year of daily points is unreadable and hides the trend it was asked to show.
 *
 * Never returns 'day_of_week': that answers a different question (which days
 * trade badly) rather than a shorter or longer view of the same one, so it is
 * only ever chosen deliberately.
 */
export function autoGranularity(from: string, to: string): Granularity {
  const days = Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
  if (days > 120) return 'month';
  if (days > 35) return 'week';
  return 'day';
}

export function bucketOf(date: string, g: Granularity): string {
  if (g === 'month') return date.slice(0, 7);
  if (g === 'day') return date;
  // Parsed as UTC throughout: `new Date('2026-07-14')` alone is midnight UTC but
  // reads back in local time, which silently shifts the weekday west of GMT.
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  if (g === 'day_of_week') return DOW_LABELS[dow];
  // Week: label by the Monday of that ISO week.
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().split('T')[0];
}

/**
 * Weekday buckets must sort Mon..Sun. Sorting them as text gives
 * Friday, Monday, Saturday, Sunday, Thursday, Tuesday, Wednesday -- which looks
 * like a chart and means nothing.
 */
function bucketSorter(g: Granularity): (a: string, b: string) => number {
  if (g !== 'day_of_week') return (a, b) => a.localeCompare(b);
  return (a, b) => DOW_LABELS.indexOf(a) - DOW_LABELS.indexOf(b);
}

async function pagedSelect(table: string, columns: string, venueId: string, from: string, to: string) {
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data } = await supabase
      .from(table)
      .select(columns)
      .eq('venue_id', venueId)
      .gte('business_date', from)
      .lte('business_date', to)
      .order('business_date', { ascending: true })
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

export interface BuildChartInput {
  metric: Metric;
  start_date: string;
  end_date: string;
  venue_slugs?: string[];
  granularity?: Granularity;
  chart_type?: 'line' | 'bar';
  title?: string;
}

export async function buildChart(input: BuildChartInput): Promise<ChartSpec | { error: string }> {
  const meta = METRIC_META[input.metric];
  if (!meta) return { error: `Unknown metric: ${input.metric}` };

  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return { error: 'No venues found' };

  const venues = input.venue_slugs?.length
    ? allVenues.filter(v => input.venue_slugs!.includes(v.slug))
    : allVenues;
  if (venues.length === 0) return { error: `No venues matched: ${input.venue_slugs?.join(', ')}` };

  const granularity = input.granularity ?? autoGranularity(input.start_date, input.end_date);
  const sortBucket = bucketSorter(granularity);
  const needsCovers = ['covers', 'avg_spend_per_head', 'walk_in_pct', 'no_show_rate'].includes(input.metric);

  const series: ChartSeries[] = [];
  const allBuckets = new Set<string>();
  let closedCount = 0;

  for (const venue of venues) {
    // bucket -> running totals, so ratios are computed on summed numerator and
    // denominator rather than averaging per-day ratios (which would weight a
    // quiet Monday the same as a busy Saturday).
    const acc = new Map<string, { revenue: number; covers: number; checks: number; txns: number; walkIn: number; noShow: number; bookings: number; days: Set<string> }>();
    const closedDates = new Set<string>();
    const touch = (b: string) => {
      allBuckets.add(b);
      if (!acc.has(b)) acc.set(b, { revenue: 0, covers: 0, checks: 0, txns: 0, walkIn: 0, noShow: 0, bookings: 0, days: new Set() });
      return acc.get(b)!;
    };

    // Always read the POS rows, even for covers-only metrics: they are how a
    // closed day is identified, and a closed day must not be plotted as a zero.
    const ops = await pagedSelect('daily_operations', 'business_date, gross_sales, net_sales, item_discounts, order_discounts, net_to_account_for, total_transactions', venue.id, input.start_date, input.end_date);
    for (const o of ops) {
      if (isClosedDay(o)) {
        closedDates.add(o.business_date);
        closedCount++;
        touch(bucketOf(o.business_date, granularity));  // keep the bucket, add nothing
        continue;
      }
      const a = touch(bucketOf(o.business_date, granularity));
      // Which revenue basis this metric uses, stated for each rather than
      // defaulted -- avg_spend_per_head divides by `a.revenue` too, so a change
      // to the fall-through would silently move a number nobody was editing.
      // Definitions live in src/lib/sales.ts.
      if (input.metric === 'net_sales') {
        a.revenue += netSalesOf(o);
      } else if (input.metric === 'gross_sales') {
        // Food + beverage + service charge. Null only when a row carries no
        // Revel figure to imply the service charge from, which would make the
        // bucket a gap and read as a closure; the cost basis is the closest
        // honest stand-in, and it understates rather than inventing.
        a.revenue += grossSalesOf(o) ?? foodAndBevSalesOf(o);
      } else {
        // food_bev_sales, and the spend-per-head denominator.
        a.revenue += foodAndBevSalesOf(o);
      }
      a.checks += Number(o.net_to_account_for ?? 0);
      a.txns += Number(o.total_transactions ?? 0);
      a.days.add(o.business_date);
    }

    if (needsCovers) {
      const covers = await getCovers(venue.id, input.start_date, input.end_date);
      for (const [date, c] of covers) {
        if (closedDates.has(date)) continue;
        const a = touch(bucketOf(date, granularity));
        a.covers += c.covers;
        a.walkIn += c.walk_in_covers;
        a.noShow += c.no_show_covers;
        a.bookings += c.bookings;
        // A date can have bookings before Revel has delivered its night, so the
        // day count is built from both feeds rather than the POS alone.
        a.days.add(date);
      }
    }

    const points = [...acc.entries()]
      .sort((x, y) => sortBucket(x[0], y[0]))
      .map(([label, a]) => {
        // A closed day is a gap, not a zero. Plotting $0 makes the line dive to
        // the axis and reads as a catastrophic trading day rather than a day the
        // venue never opened. At week/month/weekday granularity the closed day
        // simply contributes nothing to its bucket, which is correct.
        if (granularity === 'day' && closedDates.has(label)) {
          return { label, value: null };
        }
        const n = a.days.size;
        let value: number | null;
        switch (input.metric) {
          case 'gross_sales':
          case 'food_bev_sales':
          case 'net_sales':        value = a.revenue; break;
          case 'covers':           value = a.covers; break;
          case 'avg_check':        value = a.txns > 0 ? a.checks / a.txns : null; break;
          case 'avg_spend_per_head': value = a.covers > 0 ? a.revenue / a.covers : null; break;
          case 'walk_in_pct':      value = a.covers > 0 ? (a.walkIn / a.covers) * 100 : null; break;
          case 'no_show_rate':     value = a.covers + a.noShow > 0 ? (a.noShow / (a.covers + a.noShow)) * 100 : null; break;
          default:                 value = null;
        }
        // Weekday buckets hold every Tuesday in the range, so a total is
        // meaningless -- the question is what an average Tuesday looks like.
        if (granularity === 'day_of_week' && value !== null && ADDITIVE_METRICS.has(input.metric)) {
          value = n > 0 ? value / n : null;
        }
        const point: { label: string; value: number | null; n?: number } =
          { label, value: value === null ? null : Number(value.toFixed(2)) };
        if (granularity === 'day_of_week') point.n = n;
        return point;
      });

    series.push({ name: venue.name, points });
  }

  // Align every series to the same buckets so lines share an x-axis and a gap
  // reads as a gap rather than shifting the line along.
  const buckets = [...allBuckets].sort(sortBucket);
  for (const s of series) {
    const byLabel = new Map(s.points.map(p => [p.label, p]));
    s.points = buckets.map(label => byLabel.get(label) ?? { label, value: null });
  }

  if (buckets.length === 0) return { error: 'No data in that date range.' };

  const span = `${input.start_date} to ${input.end_date}`;
  const isWeekday = granularity === 'day_of_week';
  return {
    // Seven discrete weekdays are a comparison, not a trend: bars invite you to
    // read across them, a line implies Monday flows into Tuesday.
    type: input.chart_type ?? (isWeekday ? 'bar' : 'line'),
    title: input.title ?? (isWeekday ? `${meta.label} by day of week — ${span}` : `${meta.label} — ${span}`),
    metric: input.metric,
    unit: meta.unit,
    granularity,
    source: meta.source,
    series,
    // A weekday bucket has no first or last period to be partial, so the
    // stub-period correction does not apply.
    partial_first: isWeekday ? false : isPartialStart(input.start_date, granularity),
    partial_last: isWeekday ? false : isPartialEnd(input.end_date, granularity),
    closed_days: closedCount,
    low_sample_days: isWeekday
      ? series.flatMap(s => s.points).some(p => (p.n ?? 0) > 0 && (p.n ?? 0) < LOW_SAMPLE_DAYS)
      : false,
  };
}

/**
 * A day the venue never opened.
 *
 * Revel still delivers a report for a closed day, with every figure at zero --
 * Firangi Superstar is shut on Sundays and 2 Aug 2026 arrived as gross 0,
 * transactions 0, guests 0. Across 4,643 warehouse rows that is the only
 * zero-gross day, so the signal is unambiguous: no money and no transactions
 * means closed, not a disastrous day of trading.
 */
export function isClosedDay(row: { gross_sales?: any; total_transactions?: any }): boolean {
  return Number(row.gross_sales ?? 0) === 0 && Number(row.total_transactions ?? 0) === 0;
}

/** Does the range start part-way into its first bucket? */
export function isPartialStart(start: string, g: Granularity): boolean {
  if (g === 'day' || g === 'day_of_week') return false;
  if (g === 'month') return start.slice(8, 10) !== '01';
  return (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7 !== 0; // not a Monday
}

/** Does the range stop part-way through its last bucket? */
export function isPartialEnd(end: string, g: Granularity): boolean {
  if (g === 'day' || g === 'day_of_week') return false;
  const d = new Date(`${end}T00:00:00Z`);
  if (g === 'month') {
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() !== lastDay;
  }
  return (d.getUTCDay() + 6) % 7 !== 6; // not a Sunday
}
