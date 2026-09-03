/**
 * How far ahead people book, and what has to be said about the number.
 *
 * `booking_lead_time` (migration 036) does the arithmetic in Postgres. This
 * shapes its rows and works out which of them can be trusted, which is the half
 * a model cannot be relied on to remember every time.
 *
 * WHY THE MEDIAN IS THE HEADLINE AND THE MEAN IS NOT. Lead time has a long
 * right tail: a Christmas party booked in September sits in the same column as
 * a Tuesday dinner booked that morning. The mean follows the tail and moves
 * whenever one large event lands, which reads as a change in behaviour and is
 * not one. The median follows the typical booker. Both are returned, because
 * the GAP between them is itself the signal -- a mean far above the median is
 * a month carried by a few long-lead bookings.
 */

/** One row as `booking_lead_time` returns it. */
export interface LeadTimeRow {
  /** NULL for the group as a whole. */
  venue_id: string | null;
  month_start: string;
  bookings: number;
  median_days: number | null;
  mean_days: number | null;
  p90_days: number | null;
  same_day: number;
  days_1_3: number;
  days_4_7: number;
  days_8_30: number;
  days_31_plus: number;
  walk_ins: number;
  retrospective: number;
}

export interface LeadTimeMonth {
  month_start: string;
  bookings: number;
  median_days: number | null;
  mean_days: number | null;
  p90_days: number | null;
  /** Share of bookings in each band, to one decimal. Null when there are none. */
  pct_same_day: number | null;
  pct_1_3: number | null;
  pct_4_7: number | null;
  pct_8_30: number | null;
  pct_31_plus: number | null;
  same_day: number;
  days_1_3: number;
  days_4_7: number;
  days_8_30: number;
  days_31_plus: number;
  /** Excluded from every figure above. Their lead time is zero by definition. */
  walk_ins: number;
  /** Created after the date they were for. Records entered late, not bookings. */
  retrospective: number;
  /** Too few bookings for the median to be read as a movement. */
  low_sample: boolean;
}

/**
 * Below this a month's median is noise.
 *
 * Same threshold and same reasoning as MIN_VISITS_FOR_RATE next door: on a
 * count in the low tens, ordinary variation moves the median by days, which is
 * most of the metric.
 */
export const MIN_BOOKINGS_FOR_MEDIAN = 30;

/**
 * A mean this many times the median means the month is carried by a tail.
 *
 * Two is a deliberately loose bar. Lead time is right-skewed in every healthy
 * month, so a mean somewhat above the median is normal and flagging it would
 * put a caveat on every row -- which is how a caveat stops being read.
 */
export const TAIL_RATIO = 2;

const pct = (n: number, total: number): number | null =>
  total === 0 ? null : Math.round((n / total) * 1000) / 10;

export function monthlyLeadTime(rows: LeadTimeRow[]): LeadTimeMonth[] {
  return [...rows]
    .sort((a, b) => a.month_start.localeCompare(b.month_start))
    .map(r => ({
      month_start: r.month_start,
      bookings: r.bookings,
      median_days: r.median_days,
      mean_days: r.mean_days,
      p90_days: r.p90_days,
      pct_same_day: pct(r.same_day, r.bookings),
      pct_1_3: pct(r.days_1_3, r.bookings),
      pct_4_7: pct(r.days_4_7, r.bookings),
      pct_8_30: pct(r.days_8_30, r.bookings),
      pct_31_plus: pct(r.days_31_plus, r.bookings),
      same_day: r.same_day,
      days_1_3: r.days_1_3,
      days_4_7: r.days_4_7,
      days_8_30: r.days_8_30,
      days_31_plus: r.days_31_plus,
      walk_ins: r.walk_ins,
      retrospective: r.retrospective,
      low_sample: r.bookings < MIN_BOOKINGS_FOR_MEDIAN,
    }));
}

/**
 * Movement in the median between the first and last usable month.
 *
 * Thin months are skipped at both ends rather than at one, because a series
 * that begins or ends on a quiet month reports a swing that is a sample size.
 */
export function medianChange(months: LeadTimeMonth[]): {
  from: string;
  to: string;
  from_days: number;
  to_days: number;
  change_days: number;
} | null {
  const usable = months.filter(m => !m.low_sample && m.median_days !== null);
  if (usable.length < 2) return null;

  const first = usable[0];
  const last = usable[usable.length - 1];

  return {
    from: first.month_start,
    to: last.month_start,
    from_days: first.median_days!,
    to_days: last.median_days!,
    change_days: Math.round((last.median_days! - first.median_days!) * 10) / 10,
  };
}

/**
 * What must be said alongside these figures.
 *
 * Computed rather than left to the prompt, for the same reason the bill
 * coverage percentage is: a caveat the model is merely asked to remember is one
 * it will remember most of the time, and the times it does not are
 * indistinguishable from the times there was nothing to say.
 */
export function leadTimeCaveats(months: LeadTimeMonth[]): string[] {
  const out: string[] = [];
  if (months.length === 0) return out;

  const thin = months.filter(m => m.low_sample);
  if (thin.length > 0) {
    out.push(
      `${thin.length} month(s) have fewer than ${MIN_BOOKINGS_FOR_MEDIAN} bookings, so their median is noise rather than a level: ${thin.map(m => m.month_start).join(', ')}. Do not describe a movement into or out of one of these months as a change in behaviour.`,
    );
  }

  const tailed = months.filter(
    m => m.median_days !== null && m.mean_days !== null && m.median_days > 0 && m.mean_days > m.median_days * TAIL_RATIO,
  );
  if (tailed.length > 0) {
    out.push(
      `In ${tailed.length} month(s) the mean is more than ${TAIL_RATIO}x the median, so that month is carried by a few long-lead bookings — a large event booked months out, typically. Quote the median for typical behaviour and say the average is pulled by a tail.`,
    );
  }

  const walkIns = months.reduce((n, m) => n + m.walk_ins, 0);
  const booked = months.reduce((n, m) => n + m.bookings, 0);
  if (walkIns > 0) {
    out.push(
      `${walkIns} walk-in(s) are excluded from every figure here, against ${booked} booking(s) included. A walk-in is created as it arrives, so its lead time is zero by definition and including them would turn this into a measure of the walk-in ratio.`,
    );
  }

  const retro = months.reduce((n, m) => n + m.retrospective, 0);
  if (retro > 0) {
    out.push(
      `${retro} record(s) were created AFTER the date they were for and are excluded. Those are entries made late rather than bookings, and counting them as same-day would drag the median down.`,
    );
  }

  // The censoring warning, always, because the reader cannot see the filter.
  out.push(
    'Business dates in the future are excluded. A month still being booked would show only its early bookers and report a lead time far longer than it will finish with.',
  );

  return out;
}
