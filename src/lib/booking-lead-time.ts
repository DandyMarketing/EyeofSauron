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
  /** Of `bookings`, later cancelled or no-show. Absent before migration 059. */
  cancelled?: number | null;
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
  /**
   * Of `bookings`, later cancelled or no-show. They stay in the lead time --
   * a cancelled booking was still somebody booking -- but SevenRooms' list
   * hides them, so this is what reconciles the two. Null when not measured.
   */
  cancelled: number | null;
  /** Bookings that were not cancelled: what SevenRooms' list shows. */
  active_bookings: number | null;
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
      cancelled: r.cancelled ?? null,
      active_bookings: r.cancelled == null ? null : r.bookings - r.cancelled,
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

  const cancelled = months.reduce((n, m) => n + (m.cancelled ?? 0), 0);
  if (cancelled > 0) {
    out.push(
      `${cancelled} of the bookings counted were later cancelled or did not show. They stay in -- they were still bookings made -- but SevenRooms' reservation list hides them by default, so subtract them (active_bookings) before comparing with it.`,
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

/**
 * The window the lead-time query reads: whole months, or ONE NIGHT.
 *
 * WHY ONE NIGHT. Planning New Year's Eve 2026 the planner told Khai that Neon
 * Pigeon's guests "book one day ahead" -- the median for ordinary nights, June
 * to September. Nobody books New Year's Eve the day before; an occasion has its
 * own booking curve, and the only honest baseline is the same occasion last
 * year. A month cannot isolate it: December's median is set by its other
 * thirty nights. The SQL already filters by business date and groups by month,
 * so a one-day window returns exactly that night, with no new migration.
 *
 * A night still ahead of us is refused rather than measured: it shows only its
 * early bookers so far, and would read as a far longer lead than it ends with.
 */
export function leadTimeWindow(
  input: { start_date?: string; end_date?: string; business_date?: string },
  today: string,
): { start: string; end: string; single_night: boolean } | { error: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (input.business_date) {
    if (!iso.test(input.business_date)) return { error: 'business_date must be YYYY-MM-DD.' };
    if (input.business_date > today) {
      return { error: `${input.business_date} has not happened yet, so its bookings are still coming in. For an occasion, measure the same occasion LAST year instead.` };
    }
    return { start: input.business_date, end: input.business_date, single_night: true };
  }
  if (!input.start_date || !input.end_date || !iso.test(input.start_date) || !iso.test(input.end_date)) {
    return { error: 'Give business_date for one night, or start_date and end_date (YYYY-MM-DD) for whole months.' };
  }
  return { start: input.start_date, end: input.end_date, single_night: false };
}

/**
 * When the bookings for ONE night were made, day by day (13 Oct 2026).
 *
 * The bands answer "how far ahead"; this answers "did bookings come in after
 * the post on the 28th", which is the question a marketing check actually
 * asks. Khai built it by hand from SevenRooms' list of the 10 Oct brunch, and
 * it overturned the chat's answer: no brunch booking was made on the days the
 * chat credited, three were made the day after the announcement.
 *
 * Walk-ins are counted apart (no booking was made), and so are records created
 * after the night. A cancelled or no-show booking still counts as a booking
 * made that day, and is counted as such, but its covers are not added: covers
 * here are the ones that held, so the total meets SevenRooms' own list.
 */
export interface NightReservation {
  business_date: string;
  source_created_at: string | null;
  party_size: number | null;
  status_simple: string | null;
  is_walk_in: boolean | null;
}

export interface CreatedDay {
  created: string;
  days_before: number;
  /** Every booking made that day for the night, cancelled ones included. */
  bookings: number;
  /** Covers of the bookings that held -- not cancelled, not a no-show. */
  covers: number;
  /** Of `bookings`, later cancelled or no-show. */
  cancelled: number;
}

export function bookingsByCreatedDay(rows: NightReservation[]): {
  created_by_day: CreatedDay[];
  bookings: number;
  covers: number;
  cancelled: number;
  walk_ins: { bookings: number; covers: number };
  retrospective: number;
  no_created_date: number;
} {
  const sgtDay = (ts: string) => new Date(new Date(ts).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  const fellAway = (s: string | null) => s === 'Canceled' || s === 'No Show';
  const byDay = new Map<string, CreatedDay>();
  const out = { bookings: 0, covers: 0, cancelled: 0, walk_ins: { bookings: 0, covers: 0 }, retrospective: 0, no_created_date: 0 };
  for (const r of rows) {
    const size = Number(r.party_size ?? 0);
    if (r.is_walk_in) {
      if (!fellAway(r.status_simple)) { out.walk_ins.bookings++; out.walk_ins.covers += size; }
      continue;
    }
    if (!r.source_created_at) { out.no_created_date++; continue; }
    const created = sgtDay(r.source_created_at);
    const before = daysBetween(created, r.business_date);
    if (before < 0) { out.retrospective++; continue; }
    const d = byDay.get(created) ?? { created, days_before: before, bookings: 0, covers: 0, cancelled: 0 };
    d.bookings++;
    out.bookings++;
    if (fellAway(r.status_simple)) { d.cancelled++; out.cancelled++; }
    else { d.covers += size; out.covers += size; }
    byDay.set(created, d);
  }
  return { created_by_day: [...byDay.values()].sort((a, b) => a.created.localeCompare(b.created)), ...out };
}
