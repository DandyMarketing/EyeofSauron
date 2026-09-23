import { supabase } from '../lib/supabase.js';
import { getCovers } from '../lib/covers.js';
import { netSalesOf, foodAndBevSalesOf, grossSalesOf } from '../lib/sales.js';
import { normaliseChannel } from '../lib/channel-health.js';
import {
  alignBuckets, bucketTotal, shareTrap, lowSampleBuckets, pieFitNote,
  type Slice, type Bucket,
} from '../lib/composition.js';

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
  | 'instagram_reach'
  | 'instagram_views'
  | 'instagram_interactions'
  | 'instagram_followers'
  | 'covers'
  | 'avg_spend_per_head'
  | 'avg_check'
  | 'walk_in_pct'
  | 'no_show_rate'
  | 'retention_rate'
  | 'group_retention_rate';

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

/**
 * Social metrics, and how each one may be combined across days.
 *
 * `how` is the whole point of this table. Adding seven days of reach
 * double-counts everyone who appeared on more than one of them, and adding
 * seven days of follower TOTALS is meaningless arithmetic on a level. Both
 * produce a confident chart that is simply wrong, and neither looks wrong.
 *
 *   sum   a genuine per-day count -- views, interactions
 *   mean  unique accounts, so a weekly figure is "an average day", not a total
 *   last  a level: the follower count at the end of the bucket
 */
const SOCIAL_METRICS: Record<string, { metric: string; how: 'sum' | 'mean' | 'last' }> = {
  instagram_reach:        { metric: 'reach',              how: 'mean' },
  instagram_views:        { metric: 'views',              how: 'sum'  },
  instagram_interactions: { metric: 'total_interactions', how: 'sum'  },
  instagram_followers:    { metric: 'followers_count',    how: 'last' },
};

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
  instagram_reach:        { label: 'Instagram reach (avg/day)', unit: 'count', source: 'Meta' },
  instagram_views:        { label: 'Instagram views',           unit: 'count', source: 'Meta' },
  instagram_interactions: { label: 'Instagram interactions',    unit: 'count', source: 'Meta' },
  instagram_followers:    { label: 'Instagram followers',       unit: 'count', source: 'Meta' },
  avg_check:          { label: 'Average check',      unit: 'currency', source: 'Revel (POS)' },
  covers:             { label: 'Covers',             unit: 'count',    source: 'SevenRooms' },
  avg_spend_per_head: { label: 'Spend per head',     unit: 'currency', source: 'Revel revenue / SevenRooms covers' },
  walk_in_pct:        { label: 'Walk-in share',      unit: 'percent',  source: 'SevenRooms' },
  no_show_rate:       { label: 'No-show rate',       unit: 'percent',  source: 'SevenRooms' },
  retention_rate:       { label: 'Returning to this venue', unit: 'percent', source: 'SevenRooms (booked guests)' },
  group_retention_rate: { label: 'Returning to the group',  unit: 'percent', source: 'SevenRooms (booked guests)' },
};

/**
 * Retention is a rate over a LOOKBACK, not a sum over a bucket, so it cannot go
 * through the accumulator above -- there is no per-day figure to add up. Each
 * month is its own question: of the guests who came this month, how many had
 * been before. That needs one RPC per month, which is why these are branched
 * out rather than folded in.
 */
export const RETENTION_METRICS: Metric[] = ['retention_rate', 'group_retention_rate'];

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

  if (RETENTION_METRICS.includes(input.metric)) return buildRetentionChart(input, meta);

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
    const acc = new Map<string, { revenue: number; covers: number; checks: number; txns: number; walkIn: number; noShow: number; bookings: number; days: Set<string>; social: number; socialN: number; socialLastDate: string }>();
    const closedDates = new Set<string>();
    const touch = (b: string) => {
      allBuckets.add(b);
      if (!acc.has(b)) acc.set(b, { revenue: 0, covers: 0, checks: 0, txns: 0, walkIn: 0, noShow: 0, bookings: 0, days: new Set(), social: 0, socialN: 0, socialLastDate: '' });
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

    // Social lives in a different table and on a different clock: a day with no
    // social row is a day we did not capture, never a day of zero reach.
    const socialCfg = SOCIAL_METRICS[input.metric];
    if (socialCfg) {
      const rows = await pagedSelect('social_daily', 'business_date, metric, value', venue.id, input.start_date, input.end_date);
      for (const r of rows) {
        if (r.metric !== socialCfg.metric) continue;
        const v = Number(r.value);
        if (!Number.isFinite(v)) continue;
        const a = touch(bucketOf(r.business_date, granularity));
        if (socialCfg.how === 'last') {
          // A level, not a count: the newest reading in the bucket wins.
          if (r.business_date >= a.socialLastDate) {
            a.social = v;
            a.socialLastDate = r.business_date;
          }
        } else {
          a.social += v;
        }
        a.socialN++;
      }
    }

    const points = [...acc.entries()]
      .sort((x, y) => sortBucket(x[0], y[0]))
      .map(([label, a]) => {
        // A closed day is a gap, not a zero. Plotting $0 makes the line dive to
        // the axis and reads as a catastrophic trading day rather than a day the
        // venue never opened. At week/month/weekday granularity the closed day
        // simply contributes nothing to its bucket, which is correct.
        // A closed venue still posts, and its audience still sees the posts.
        // Blanking social on a closure would erase real activity.
        if (granularity === 'day' && closedDates.has(label) && !socialCfg) {
          return { label, value: null };
        }
        const n = a.days.size;
        let value: number | null;
        switch (input.metric) {
          case 'gross_sales':
          case 'food_bev_sales':
          case 'net_sales':        value = a.revenue; break;
          case 'instagram_views':
          case 'instagram_interactions':
            // Summing every Tuesday gives a meaningless total; the question a
            // weekday chart asks is what an average Tuesday looks like.
            value = a.socialN === 0 ? null
              : granularity === 'day_of_week' ? a.social / a.socialN
              : a.social;
            break;
          case 'instagram_reach':
            // Unique accounts. Never summed across days -- the same person on
            // Monday and Tuesday is one person, so a weekly total would be
            // inflated by exactly the loyal audience you most want to count once.
            value = a.socialN === 0 ? null : a.social / a.socialN;
            break;
          case 'instagram_followers':
            // A level. The bucket's value is where it ended, not a total.
            value = a.socialN === 0 ? null : a.social;
            break;
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

/**
 * Part-to-whole charts: what something is made of, and whether that is moving.
 *
 * WHY THIS IS A SECOND BUILDER RATHER THAN A METRIC ON THE FIRST. Everything
 * above is one number over time. These are CATEGORIES summing to a whole, which
 * is a different row shape, a different axis and a different set of ways to be
 * wrong -- and a builder that did both would be two functions sharing a name.
 * The questions it answers were simply undrawable before: where guests came
 * from, how many were on a second visit, which channel carried the month. The
 * briefing drew nothing at all rather than drawing them badly.
 */

export type CompositionMetric = 'guest_source' | 'visit_mix' | 'booking_channels';

export interface CompositionBucket {
  label: string;
  slices: Slice[];
  /** The denominator. Carried per bucket because the share trap lives here. */
  total: number;
}

export interface CompositionSpec {
  /** Discriminates from ChartSpec, which predates this and has no `kind`. */
  kind: 'composition';
  type: 'pie' | 'stacked_pct';
  title: string;
  metric: CompositionMetric;
  /** What one unit IS -- "guests", "visits", "bookings". Named, never assumed. */
  unit_label: string;
  source: string;
  categories: string[];
  buckets: CompositionBucket[];
  /** Bucket labels too thin for their shares to mean anything. */
  low_sample: string[];
  caveats: string[];
}

const COMPOSITION_META: Record<CompositionMetric, { label: string; unit_label: string; source: string }> = {
  guest_source: {
    label: 'Where guests came from',
    unit_label: 'booked guests',
    source: 'SevenRooms (booked guests; walk-ins excluded)',
  },
  visit_mix: {
    label: 'Visit mix',
    unit_label: 'visits',
    source: 'SevenRooms',
  },
  booking_channels: {
    label: 'Booking channels',
    unit_label: 'bookings',
    source: 'SevenRooms',
  },
};

/**
 * Months from a range, oldest first, capped.
 *
 * The cap is about cost rather than readability: `guest_source` costs one RPC
 * per month, so an unbounded range is an unbounded number of round trips. The
 * range is trimmed from the FRONT, keeping the recent months, because a
 * composition question is nearly always about now.
 */
const MAX_BUCKETS = 18;

function monthsIn(start: string, end: string): Array<{ key: string; start: string; end: string }> {
  const out: Array<{ key: string; start: string; end: string }> = [];
  const s = new Date(`${start}T00:00:00Z`);
  let y = s.getUTCFullYear();
  let m = s.getUTCMonth();

  while (true) {
    const first = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(y, m + 1, 0));
    if (first.toISOString().slice(0, 10) > end) break;

    out.push({
      key: first.toISOString().slice(0, 7),
      // Clamped to the requested range so the first and last months are not
      // silently widened into periods nobody asked about.
      start: first.toISOString().slice(0, 10) < start ? start : first.toISOString().slice(0, 10),
      end: last.toISOString().slice(0, 10) > end ? end : last.toISOString().slice(0, 10),
    });
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }

  return out.length > MAX_BUCKETS ? out.slice(out.length - MAX_BUCKETS) : out;
}

export interface BuildCompositionInput {
  metric: CompositionMetric;
  start_date: string;
  end_date: string;
  /** Omit for the group as a whole, which is a real question and says so. */
  venue_slug?: string;
  chart_type?: 'pie' | 'stacked_pct';
  title?: string;
}

export async function buildComposition(
  input: BuildCompositionInput,
  allowedSlugs?: string[],
): Promise<CompositionSpec | { error: string }> {
  const meta = COMPOSITION_META[input.metric];
  if (!meta) return { error: `Unknown composition metric: ${input.metric}` };

  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return { error: 'No venues found' };

  // Scope is applied HERE and not trusted to the caller's slug, the hole
  // enforceVenueScope() already had to plug once for the query tools.
  const visible = allowedSlugs ? allVenues.filter(v => allowedSlugs.includes(v.slug)) : allVenues;
  const venues = input.venue_slug ? visible.filter(v => v.slug === input.venue_slug) : visible;
  if (venues.length === 0) {
    return { error: `No venue matched "${input.venue_slug ?? '(all)'}" that you may see.` };
  }

  const venueIds = new Set(venues.map(v => v.id));
  const scopeName = input.venue_slug ? venues[0].name : 'the group';
  const type = input.chart_type ?? 'stacked_pct';

  // A pie is ONE bucket covering the whole range; a stacked chart is one per
  // month. Same preparation either way -- the only difference is how many.
  const periods = type === 'pie'
    ? [{ key: `${input.start_date} to ${input.end_date}`, start: input.start_date, end: input.end_date }]
    : monthsIn(input.start_date, input.end_date);

  if (periods.length === 0) return { error: 'No months in that date range.' };

  let raw: Bucket[];

  if (input.metric === 'guest_source') {
    // One RPC per period. Parallel because they are independent and sequential
    // would make an eighteen-month chart eighteen round trips deep.
    const results = await Promise.all(
      periods.map(p => supabase.rpc('guest_retention', { p_start: p.start, p_end: p.end, p_lookback: 365 })),
    );

    const failed = results.find(r => r.error);
    if (failed?.error) {
      return { error: `Could not read guest retention: ${failed.error.message}. If this says the function does not exist, migration 045 is applied but 028/044 are not.` };
    }

    raw = periods.map((p, i) => {
      const rows = ((results[i].data ?? []) as any[]).filter(r => venueIds.has(r.venue_id));
      const sum = (k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
      return {
        label: p.key,
        // The three are mutually exclusive by construction in the RPC and sum
        // to booked_guests, which is what makes this a legitimate part-to-whole
        // rather than three numbers that happen to be near each other.
        slices: [
          { label: 'New to group', value: sum('new_to_group') },
          { label: 'Returning here', value: sum('returning_here') },
          { label: 'Crossed from sister', value: sum('crossed_from_sister') },
        ],
      };
    });
  } else if (input.metric === 'visit_mix') {
    const { data, error } = await supabase.rpc('visit_distribution', {
      p_start: input.start_date,
      p_end: input.end_date,
    });
    if (error) {
      return { error: `Could not read the visit distribution: ${error.message}. If this says the function does not exist, migration 032_visit_distribution.sql has not been applied.` };
    }

    // venue_id NULL is the RPC's own group total. Dropped and recomputed from
    // the venue rows, because keeping both would double every group figure.
    const rows = ((data ?? []) as any[]).filter(r => r.venue_id !== null && venueIds.has(r.venue_id));
    const LABELS = ['First visit', 'Second visit', 'Third visit', 'Fourth or more'];

    raw = periods.map(p => {
      const inPeriod = rows.filter(r =>
        type === 'pie' ? true : String(r.month_start).slice(0, 7) === p.key);
      return {
        label: p.key,
        slices: LABELS.map((label, idx) => ({
          label,
          value: inPeriod
            .filter(r => Number(r.visit_number) === idx + 1)
            .reduce((n, r) => n + Number(r.visits ?? 0), 0),
        })),
      };
    });
  } else {
    const { data, error } = await supabase.rpc('booking_channel_months', {
      p_from: input.start_date,
      p_to: input.end_date,
      // Zero, not the alert path's ten: a channel with three bookings is a
      // genuine sliver of the mix, and suppressing it would stop the
      // percentages summing to a hundred.
      p_min_bookings: 0,
    });
    if (error) {
      return { error: `Could not read booking channels: ${error.message}. If this says the function does not exist, migration 030_booking_channel_months.sql has not been applied.` };
    }

    const rows = ((data ?? []) as any[]).filter(r => venueIds.has(r.venue_id));

    raw = periods.map(p => {
      const inPeriod = rows.filter(r =>
        type === 'pie' ? true : String(r.month).slice(0, 7) === p.key);
      const byChannel = new Map<string, number>();
      for (const r of inPeriod) {
        const channel = normaliseChannel(r.booked_by, Boolean(r.is_walk_in));
        byChannel.set(channel, (byChannel.get(channel) ?? 0) + Number(r.bookings ?? 0));
      }
      return {
        label: p.key,
        slices: [...byChannel.entries()].map(([label, value]) => ({ label, value })),
      };
    });
  }

  const { categories, buckets } = alignBuckets(raw);
  const withTotals: CompositionBucket[] = buckets.map(b => ({ ...b, total: bucketTotal(b) }));

  if (withTotals.every(b => b.total === 0)) {
    return { error: 'No data in that date range.' };
  }

  const caveats: string[] = [];

  const trap = shareTrap(buckets);
  if (trap) caveats.push(trap);

  if (type === 'pie') {
    const fit = pieFitNote(buckets[0].slices);
    if (fit) caveats.push(fit);
    caveats.push('A pie is ONE period against nothing. It shows the mix and cannot show whether the mix is moving — for that, ask for the same metric as stacked_pct over months.');
  }

  if (input.metric === 'guest_source') {
    caveats.push('Walk-ins are EXCLUDED from these three: SevenRooms issues a walk-in a fresh client id every time, so one would count as new to the group on every visit and inflate the new share. This is the booked-guest mix, and it is not the whole room.');
  }
  if (input.metric === 'visit_mix') {
    caveats.push('A guest whose first visit predates the data reads as a first-timer, so the earliest months overstate first visits and understate the return rate. Compare recent months against each other, not against the start of the range.');
  }
  if (!input.venue_slug && venues.length > 1) {
    caveats.push(`This is ${venues.length} venues added together, not one venue. A group mix can hide two venues moving in opposite directions.`);
  }

  const low = lowSampleBuckets(withTotals);

  return {
    kind: 'composition',
    type,
    title: input.title ?? `${meta.label} — ${scopeName}, ${input.start_date} to ${input.end_date}`,
    metric: input.metric,
    unit_label: meta.unit_label,
    source: meta.source,
    categories,
    buckets: withTotals,
    low_sample: low,
    caveats,
  };
}


/**
 * Retention as a line: of the guests who came this month, what share had been
 * before.
 *
 * WHY A LINE AND NOT THE STACKED CHART. Both are built, and they answer
 * different questions. The stacked one shows the whole mix and is the honest
 * picture; this one shows the single number that MOVES. At roughly 85% new,
 * 12% returning and 3% crossed, a three-point fall in returning is three points
 * of a stacked column and eleven degrees of a pie -- but on its own axis it is
 * a quarter of the value, and visible from across the room. Use the stack for
 * the composition and this for the trend.
 *
 * MONTHLY, ALWAYS, AND NOT BECAUSE MONTHS ARE TIDY. A week holds a few hundred
 * booked guests at best and the returning slice of that is tens; CLAUDE.md
 * already records the cross-venue count as small enough that a week's movement
 * is noise. A weekly retention line would oscillate violently and mean nothing,
 * and somebody would read a trend off it.
 *
 * THE DENOMINATOR TRAVELS ON EVERY POINT. `n` is the month's booked guests --
 * the same field the weekday charts use for trading days -- because a rate
 * rises when its numerator grows OR its denominator shrinks, and a venue that
 * stops attracting new guests posts improving retention all the way down.
 */
async function buildRetentionChart(
  input: BuildChartInput,
  meta: { label: string; unit: ChartSpec['unit']; source: string },
): Promise<ChartSpec | { error: string }> {
  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return { error: 'No venues found' };

  const venues = input.venue_slugs?.length
    ? allVenues.filter(v => input.venue_slugs!.includes(v.slug))
    : allVenues;
  if (venues.length === 0) return { error: `No venues matched: ${input.venue_slugs?.join(', ')}` };

  const months = monthsIn(input.start_date, input.end_date);
  if (months.length === 0) return { error: 'No months in that date range.' };

  const results = await Promise.all(
    months.map(m => supabase.rpc('guest_retention', { p_start: m.start, p_end: m.end, p_lookback: 365 })),
  );
  const failed = results.find(r => r.error);
  if (failed?.error) {
    return { error: `Could not read guest retention: ${failed.error.message}. If this says the function does not exist, migration 028/044 has not been applied.` };
  }

  const group = input.metric === 'group_retention_rate';

  const series: ChartSeries[] = venues.map(venue => ({
    name: venue.name,
    points: months.map((m, i) => {
      const row = ((results[i].data ?? []) as any[]).find(r => r.venue_id === venue.id);
      const booked = Number(row?.booked_guests ?? 0);

      // A month with no booked guests has no rate. Null so the line BREAKS
      // rather than dropping to zero, which would draw a collapse in retention
      // where there was simply nobody to retain.
      if (!row || booked === 0) return { label: m.key, value: null };

      const returned = Number(row.returning_here ?? 0)
        + (group ? Number(row.crossed_from_sister ?? 0) : 0);

      return {
        label: m.key,
        value: Number(((returned / booked) * 100).toFixed(1)),
        n: booked,
      };
    }),
  }));

  const span = `${input.start_date} to ${input.end_date}`;
  return {
    type: input.chart_type ?? 'line',
    title: input.title ?? `${meta.label} — ${span}`,
    metric: input.metric,
    unit: 'percent',
    granularity: 'month',
    source: meta.source,
    series,
    closed_days: 0,
    low_sample_days: false,
    // Retention is computed per whole calendar month by the RPC, so a range
    // that starts or ends mid-month yields a genuinely partial first or last
    // bucket -- fewer guests, a rate that is not comparable to the others.
    partial_first: isPartialStart(input.start_date, 'month'),
    partial_last: isPartialEnd(input.end_date, 'month'),
  };
}
