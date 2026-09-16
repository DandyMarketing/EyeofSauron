/**
 * Rolling rostered labour up from section-days to whatever the question asked
 * for.
 *
 * PURE, AND SEPARATE FROM THE HANDLER, for the reason retention.ts and
 * revenue-decomposition.ts are: the two things this does can both be wrong in
 * ways that look completely plausible in the output, and neither is testable
 * through a handler that needs Supabase.
 *
 *   1. staff_count is people on a SECTION on a DAY. Summing it across a week
 *      reports 140 staff at a venue that employs twenty; summing it across
 *      sections double-counts anyone who worked both. It is a gauge, not a
 *      quantity, and the only honest scalar for a period is the largest single
 *      reading in it.
 *
 *   2. Sales belong to a DAY and labour rows are per SECTION, so a venue with a
 *      BOH row and an FOH row on one day will add that day's sales twice unless
 *      something stops it -- halving the labour percentage, in a figure that
 *      still looks entirely reasonable.
 *
 * Both are the shape this codebase keeps finding: arithmetic that is wrong by a
 * factor nobody can see without counting. So they are tested.
 */

export type LabourGrouping = 'total' | 'area' | 'day' | 'day_area';

export interface LabourRow {
  /** NULL means group staff, who belong to no venue and are never allocated. */
  venue_id: string | null;
  business_date: string;
  area: string;
  scheduled_hours: number | string | null;
  actual_hours: number | string | null;
  overtime_hours: number | string | null;
  basic_cost: number | string | null;
  overtime_cost: number | string | null;
  weekend_cost: number | string | null;
  event_cost: number | string | null;
  other_cost: number | string | null;
  total_cost: number | string | null;
  staff_count: number | string | null;
}

export interface LabourBucket {
  venue: string;
  business_date?: string;
  area?: string;
  scheduled_hours: number;
  actual_hours: number;
  hours_variance: number;
  overtime_hours: number;
  basic_cost: number;
  overtime_cost: number;
  weekend_cost: number;
  event_cost: number;
  other_cost: number;
  total_cost: number;
  /** The LARGEST single section-day in the bucket. Never a sum. */
  peak_staff_count: number;
  /** How many venue-days of trade the sales figure covers. */
  days_counted: number;
  fb_sales: number;
  /** Null when either side is missing, never zero -- see below. */
  labour_pct_of_fb_sales: number | null;
  /** Null when no overtime was worked. */
  implied_overtime_rate: number | null;
}

export interface AggregateOptions {
  groupBy: LabourGrouping;
  /** Venue display name for an id. Group rows never reach this. */
  venueName: (venueId: string) => string;
  /** Food & beverage sales for a venue-day, or 0 if none is held. */
  fbSales: (venueId: string, businessDate: string) => number;
}

export const GROUP_LABEL = 'Group (no venue)';

const n = (v: number | string | null | undefined): number => (v == null ? 0 : Number(v) || 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

export function aggregateLabour(rows: LabourRow[], opts: AggregateOptions): LabourBucket[] {
  interface Working extends Omit<LabourBucket, 'hours_variance' | 'labour_pct_of_fb_sales' | 'implied_overtime_rate' | 'days_counted'> {
    countedDays: Set<string>;
  }

  const buckets = new Map<string, Working>();

  for (const row of rows) {
    const venue = row.venue_id === null ? GROUP_LABEL : opts.venueName(row.venue_id);

    const key =
      opts.groupBy === 'total' ? venue
      : opts.groupBy === 'day' ? `${venue}|${row.business_date}`
      : opts.groupBy === 'day_area' ? `${venue}|${row.business_date}|${row.area}`
      : `${venue}|${row.area}`;

    let b = buckets.get(key);
    if (!b) {
      b = {
        venue,
        ...(opts.groupBy === 'day' || opts.groupBy === 'day_area' ? { business_date: row.business_date } : {}),
        ...(opts.groupBy === 'area' || opts.groupBy === 'day_area' ? { area: row.area } : {}),
        scheduled_hours: 0, actual_hours: 0, overtime_hours: 0,
        basic_cost: 0, overtime_cost: 0, weekend_cost: 0, event_cost: 0, other_cost: 0, total_cost: 0,
        peak_staff_count: 0, fb_sales: 0,
        countedDays: new Set<string>(),
      };
      buckets.set(key, b);
    }

    b.scheduled_hours += n(row.scheduled_hours);
    b.actual_hours += n(row.actual_hours);
    b.overtime_hours += n(row.overtime_hours);
    b.basic_cost += n(row.basic_cost);
    b.overtime_cost += n(row.overtime_cost);
    b.weekend_cost += n(row.weekend_cost);
    b.event_cost += n(row.event_cost);
    b.other_cost += n(row.other_cost);
    b.total_cost += n(row.total_cost);

    // A gauge, not a quantity. See the header.
    b.peak_staff_count = Math.max(b.peak_staff_count, n(row.staff_count));

    // One day's sales, once per bucket, however many sections worked it.
    if (row.venue_id !== null) {
      const dayKey = `${row.venue_id}|${row.business_date}`;
      if (!b.countedDays.has(dayKey)) {
        b.countedDays.add(dayKey);
        b.fb_sales += opts.fbSales(row.venue_id, row.business_date);
      }
    }
  }

  return [...buckets.values()]
    .sort((a, b) =>
      a.venue.localeCompare(b.venue) ||
      (a.business_date ?? '').localeCompare(b.business_date ?? '') ||
      (a.area ?? '').localeCompare(b.area ?? ''))
    .map(b => ({
      venue: b.venue,
      ...(b.business_date ? { business_date: b.business_date } : {}),
      ...(b.area ? { area: b.area } : {}),
      scheduled_hours: round2(b.scheduled_hours),
      actual_hours: round2(b.actual_hours),
      hours_variance: round2(b.actual_hours - b.scheduled_hours),
      overtime_hours: round2(b.overtime_hours),
      basic_cost: round2(b.basic_cost),
      overtime_cost: round2(b.overtime_cost),
      weekend_cost: round2(b.weekend_cost),
      event_cost: round2(b.event_cost),
      other_cost: round2(b.other_cost),
      total_cost: round2(b.total_cost),
      peak_staff_count: b.peak_staff_count,
      days_counted: b.countedDays.size,
      fb_sales: round2(b.fb_sales),
      /**
       * Null rather than zero when either side is missing.
       *
       * A labour percentage of 0.0% reads as a venue with no labour cost, which
       * is a claim. "We cannot compute this" is a different statement and the
       * only true one when the sales side has not landed -- the zero-denominator
       * lesson from migration 039, where 46,318.00 of cost was written against
       * 0.0 hours and reported as a success.
       */
      labour_pct_of_fb_sales: b.fb_sales > 0 && b.total_cost > 0
        ? Math.round((b.total_cost / b.fb_sales) * 1000) / 10
        : null,
      implied_overtime_rate: b.overtime_hours > 0
        ? round2(b.overtime_cost / b.overtime_hours)
        : null,
    }));
}

/**
 * Strip the money, keep the percentage.
 *
 * CLAUDE.md: aggregate payroll cost is finance and owner only; managers see
 * labour PERCENTAGE and never individual pay. Hours and headcount carry no pay
 * and are what rostering needs, so they stay. Same shape as the P&L's payroll
 * line redaction, which is the precedent this follows deliberately rather than
 * inventing a second way of saying the same thing.
 *
 * The implied overtime RATE goes too: it is money per hour, and a rate plus
 * hours reconstructs the cost that was just withheld.
 */
export function withoutCost(bucket: LabourBucket): Record<string, unknown> {
  const {
    basic_cost, overtime_cost, weekend_cost, event_cost, other_cost, total_cost,
    implied_overtime_rate, ...safe
  } = bucket;

  return {
    ...safe,
    redacted: 'payroll — labour cost amounts withheld for this role; the percentage of food & beverage sales is given instead',
  };
}
