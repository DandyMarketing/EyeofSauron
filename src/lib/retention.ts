/**
 * Reading the retention numbers, and refusing to over-read them.
 *
 * The database returns four counts. Everything here is about turning those into
 * something that cannot be misunderstood -- which matters more than usual,
 * because the interesting figure is also the smallest one.
 */

/** One venue's counts, straight from guest_retention(). */
export interface RetentionCounts {
  booked_guests: number;
  returning_here: number;
  crossed_from_sister: number;
  new_to_group: number;
  walk_in_guests: number;
}

export interface RetentionRates {
  /** Came back to THIS venue. The venue's own work. */
  outlet_pct: number | null;
  /** Came back to ANY venue in the group. The group's work. */
  group_pct: number | null;
  /** group minus outlet: the multi-venue premium, and currently about 3 points. */
  cross_venue_pct: number | null;
  /** Neither. The only guests actually being paid for. */
  new_pct: number | null;
  /** Share of this period's guests the metric can see at all. */
  coverage_pct: number | null;
}

/**
 * Below this many guests, week-to-week movement is noise.
 *
 * Not a round number picked for tidiness. `crossed_from_sister` was TWELVE
 * across the whole group in the week measured; ordinary variation on a count
 * that size is several guests, which is tens of percent of the metric. Someone
 * will watch it fall from 12 to 7 and conclude something happened.
 *
 * Thirty is where a single guest stops moving the figure by more than about
 * three points. Below it, report the count and the direction, never the trend.
 */
export const MIN_SAMPLE_FOR_TREND = 30;

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

export function retentionRates(c: RetentionCounts): RetentionRates {
  const booked = c.booked_guests;
  const returning = c.returning_here + c.crossed_from_sister;

  return {
    outlet_pct: pct(c.returning_here, booked),
    group_pct: pct(returning, booked),
    cross_venue_pct: pct(c.crossed_from_sister, booked),
    new_pct: pct(c.new_to_group, booked),
    // What share of the period's guests this metric describes. Walk-ins are
    // invisible to it, so a venue trading more casually is measured less well.
    coverage_pct: pct(booked, booked + c.walk_in_guests),
  };
}

/**
 * What must be said alongside the numbers, every time.
 *
 * Returned as data rather than left to the model to remember, on the same
 * argument as coverageByAccount(): a true list of four suppliers presented as
 * a whole account is a wrong answer, and nothing else in the reply tells the
 * reader which they are looking at.
 */
export function retentionCaveats(c: RetentionCounts): string[] {
  const notes: string[] = [
    'BOOKED GUESTS ONLY. SevenRooms issues a fresh client id for nearly every walk-in, so a walk-in can never be observed returning. Including them would understate retention by construction.',
    'Counts GUESTS (the booking), not diners. A returning regular who brings four first-timers is one returning guest — this measures relationship, not reach.',
    /**
     * The limit that cannot be fixed, so it is stated instead.
     *
     * A guest who has left Singapore is indistinguishable from one who chose
     * not to come back. These are CBD rooms with heavy expatriate and visitor
     * trade, and a visitor's chance of returning is near zero, so the measured
     * rate is a FLOOR on how well the venue earns a second visit rather than an
     * estimate of it. How much of a floor is unknown and this codebase will not
     * guess at it.
     *
     * The comparison survives where the level does not: the same churn applies
     * at all three venues and in most months, so venue against venue and month
     * against month remain readable. What breaks it is the guest MIX changing
     * — a hotel opening nearby, a race week — which moves the rate without
     * anybody's hospitality changing.
     */
    'A FLOOR, NOT A RATE. A guest who has left Singapore looks identical to one who chose not to return, and these are CBD venues with heavy visitor and expatriate trade. The true share of returnable guests who come back is higher by an unknown amount. Use this to COMPARE — venue against venue, month against month, where the same churn applies to both sides — and never quote the level as a verdict on hospitality. If it moves sharply, ask whether the guest MIX changed before concluding that regulars were lost.',
  ];

  const rates = retentionRates(c);

  if (rates.coverage_pct !== null && rates.coverage_pct < 85) {
    notes.push(
      `Only ${rates.coverage_pct}% of this period's guests are booked; the rest walked in and are invisible to this metric. ` +
      `Treat the rate as describing that share of the venue, not all of it.`,
    );
  }

  if (c.booked_guests < MIN_SAMPLE_FOR_TREND) {
    notes.push(
      `Only ${c.booked_guests} booked guest(s) in this period — too few to read a change against another period. Report the level, not the movement.`,
    );
  } else if (c.crossed_from_sister < MIN_SAMPLE_FOR_TREND) {
    // The one people will over-read, because it is the most interesting.
    notes.push(
      `crossed_from_sister is ${c.crossed_from_sister} guest(s). That is too small to compare week to week — a normal fluctuation is several guests, which is tens of percent of the figure. Use a rolling window before calling any movement in it real.`,
    );
  }

  return notes;
}

/**
 * A rolling window ending on the last complete Sunday.
 *
 * Four weeks by default, because one week of retention is a handful of guests.
 * Ends on a Sunday for the same reason lastCompleteWeek() does: a window that
 * stops mid-week compares part-weeks against whole ones and invents a trend.
 */
export function rollingWindow(weekEnd: string, weeks = 4): { start: string; end: string } {
  const end = new Date(`${weekEnd}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) throw new Error(`rollingWindow: "${weekEnd}" is not a date`);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (weeks * 7 - 1));

  const iso = (d: Date) => d.toISOString().split('T')[0];
  return { start: iso(start), end: iso(end) };
}

/**
 * One first-visit cohort: everyone who arrived in the same period, given the
 * same number of days to come back.
 */
export interface Cohort {
  cohort_start: string;
  cohort_size: number;
  returned: number;
  /** False until every guest in the cohort has had the full window. */
  is_mature: boolean;
}

export interface CohortRate extends Cohort {
  return_pct: number | null;
  /** Set when the row must not be compared with the others. */
  warning?: string;
}

/**
 * Below this many guests a cohort's rate is not a measurement.
 *
 * Lower than MIN_SAMPLE_FOR_TREND because a cohort is a quarter of arrivals
 * rather than a week's, so a small one means something genuinely unusual
 * happened -- a venue not yet open, or a period with almost no new guests --
 * and that is worth seeing rather than hiding.
 */
export const MIN_COHORT_SIZE = 20;

/**
 * Rates, with the immature ones marked rather than dropped.
 *
 * AN IMMATURE COHORT IS THE MOST DANGEROUS ROW IN THE TABLE. Its guests have
 * not had the full window, so its rate is near zero -- and plotted next to
 * mature cohorts it draws a cliff at the right-hand edge that reads exactly
 * like retention collapsing. It is the calendar, not a finding.
 *
 * Returned rather than filtered out, because a chart that simply stops leaves
 * someone asking why, and the honest answer belongs on the row.
 */
export function cohortRates(cohorts: Cohort[]): CohortRate[] {
  return cohorts
    .slice()
    .sort((a, b) => a.cohort_start.localeCompare(b.cohort_start))
    .map(c => {
      const rate: CohortRate = {
        ...c,
        return_pct: pct(c.returned, c.cohort_size),
      };

      if (!c.is_mature) {
        rate.warning =
          'INCOMPLETE — this cohort has not yet had the full window to return. Its rate will rise. Do NOT compare it with the mature cohorts or plot it as the latest point in a trend.';
      } else if (c.cohort_size < MIN_COHORT_SIZE) {
        rate.warning = `Only ${c.cohort_size} guest(s) in this cohort — too few for the rate to be meaningful.`;
      }

      return rate;
    });
}

/**
 * The cohorts that may legitimately be compared with one another.
 *
 * Useful for describing a trend without having to restate the exclusions every
 * time; the full list including the excluded rows is what gets shown.
 */
export function comparableCohorts(cohorts: Cohort[]): CohortRate[] {
  return cohortRates(cohorts).filter(c => c.is_mature && c.cohort_size >= MIN_COHORT_SIZE);
}

/** Sum several venues into one group-level row. */
export function totalCounts(rows: RetentionCounts[]): RetentionCounts {
  return rows.reduce<RetentionCounts>(
    (acc, r) => ({
      booked_guests: acc.booked_guests + r.booked_guests,
      returning_here: acc.returning_here + r.returning_here,
      crossed_from_sister: acc.crossed_from_sister + r.crossed_from_sister,
      new_to_group: acc.new_to_group + r.new_to_group,
      walk_in_guests: acc.walk_in_guests + r.walk_in_guests,
    }),
    { booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0, walk_in_guests: 0 },
  );
}

/**
 * Whether the lookback window is actually covered by the data behind it.
 *
 * THE DEFECT THIS EXISTS FOR. To decide whether a guest is returning, the RPC
 * looks for an earlier visit in the 365 days before the period -- IN OUR DATA.
 * When the data does not reach back that far it finds nothing, and "I found
 * nothing" is indistinguishable from "they had never been". Every guest whose
 * previous visit predates the ingest is counted as new to the group.
 *
 * It is a guest book that started partway through. A month after you begin
 * writing names down, almost everyone looks new.
 *
 * WHY IT IS WORSE THAN A ONE-OFF ERROR. The gap closes month by month as the
 * window fills, so retention reads artificially low at the start of the data
 * and climbs to its true level about a lookback later. Drawn as a line that is
 * a RISING TREND for the first year which is entirely the database filling up,
 * and it reads exactly like a venue getting better at keeping guests.
 *
 * Shaped like `calendar_covers_to` on the holidays tool: an answer that says
 * when it cannot be trusted, rather than one that looks the same either way.
 */
export interface LookbackCoverage {
  /** The first day the lookback needs to see. */
  needed_from: string;
  /** The first day the data actually holds, or null when there is none. */
  data_from: string | null;
  /** How much of the needed window exists, 0-100. */
  covered_pct: number;
  complete: boolean;
}

const DAY_MS = 86_400_000;
const asUtc = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

export function lookbackCoverage(
  periodStart: string,
  lookbackDays: number,
  earliest: string | null,
): LookbackCoverage {
  const start = asUtc(periodStart);
  const neededFrom = new Date(start - lookbackDays * DAY_MS).toISOString().slice(0, 10);

  // No data at all is zero coverage, not full coverage. The other way round is
  // how an empty table reports perfect confidence.
  if (earliest === null) {
    return { needed_from: neededFrom, data_from: null, covered_pct: 0, complete: false };
  }

  const have = asUtc(earliest);
  if (have <= asUtc(neededFrom)) {
    return { needed_from: neededFrom, data_from: earliest, covered_pct: 100, complete: true };
  }

  // Data beginning after the period itself covers none of the lookback.
  const covered = Math.max(0, start - have);
  const pct = Math.round((covered / (lookbackDays * DAY_MS)) * 1000) / 10;

  return {
    needed_from: neededFrom,
    data_from: earliest,
    covered_pct: Math.min(100, pct),
    complete: false,
  };
}

/** The sentence to print, or null when the window is genuinely covered. */
export function truncationCaveat(c: LookbackCoverage, label?: string): string | null {
  if (c.complete) return null;

  const where = label ? `${label}: ` : '';

  if (c.data_from === null) {
    return `${where}NO BOOKING HISTORY AT ALL behind this period, so every guest is counted as new to the group by default. This is not a retention figure.`;
  }

  return (
    `${where}THE LOOKBACK IS ONLY ${c.covered_pct}% COVERED. Deciding who is returning needs history back to ` +
    `${c.needed_from} and the data starts ${c.data_from}, so a guest whose previous visit predates the ingest is ` +
    `counted as NEW. Returning guests are understated and the new share is overstated — by more, the earlier the ` +
    `period. Never read a rise across the early months as guests coming back more: it is the history filling up.`
  );
}
