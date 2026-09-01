/**
 * First, second, third, fourth-and-beyond: the shape of a month's footfall.
 *
 * `guest_retention` answers "were these people here before" for ONE period, and
 * `guest_cohorts` answers "is retention getting better" by first-visit cohort.
 * Neither answers the question an operator actually asks, which is how the mix
 * moves month to month -- and the attempt to assemble it from thirty-two calls
 * to the first tool is what timed the chat out on 1 Sep 2026. See migration 032.
 *
 * VISITS, NOT GUESTS. A guest who comes twice in March appears twice in March,
 * as visit 2 and as visit 3. That is deliberate: the buckets then sum to the
 * month's booked footfall, and a "how many distinct people" number would answer
 * a different question while looking like this one.
 */

/** One row as `visit_distribution` returns it. */
export interface VisitRow {
  /** NULL for the group as a whole. */
  venue_id: string | null;
  month_start: string;
  /** 1, 2, 3, or 4 meaning fourth-or-later. */
  visit_number: number;
  visits: number;
}

export interface MonthDistribution {
  month_start: string;
  first: number;
  second: number;
  third: number;
  fourth_plus: number;
  total_visits: number;
  /** Everything that was not somebody's first visit. */
  return_visits: number;
  /** Return visits as a percentage of the month, or null when unmeasurable. */
  return_rate_pct: number | null;
  /**
   * Too few visits for the rate to mean anything. The rate is still returned --
   * hiding it would leave a hole somebody fills with a guess -- but it must not
   * be read as a movement.
   */
  low_sample: boolean;
  /**
   * A returning guest whose first visit predates the data looks like a
   * first-timer, so early months overstate `first` and understate the rate.
   */
  left_censored: boolean;
}

/**
 * Below this a month's rate is noise.
 *
 * Same threshold and same reasoning as MIN_SAMPLE_FOR_TREND in retention.ts:
 * on a count in the low tens, ordinary variation is several visits, which is
 * tens of percent of the metric.
 */
export const MIN_VISITS_FOR_RATE = 30;

/**
 * How long the data must have been running before a month stops being badly
 * left-censored.
 *
 * Censoring never fully disappears -- somebody's first visit is always
 * potentially before our records -- but it decays. A year matches the 365-day
 * lookback used by `guest_retention`, so the two agree on what "a return" means
 * rather than each picking its own horizon.
 */
export const CENSORING_DAYS = 365;

const addDays = (iso: string, days: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/**
 * Fold the RPC's long rows into one record per month.
 *
 * A month with no row for a bucket gets a zero rather than being absent: a
 * missing "third visit" line and a genuine zero are different facts, and a
 * caller iterating the buckets should not have to tell them apart.
 */
export function monthlyDistribution(
  rows: VisitRow[],
  dataStartsAt: string | null = null,
): MonthDistribution[] {
  const byMonth = new Map<string, MonthDistribution>();

  for (const row of rows) {
    const month = byMonth.get(row.month_start) ?? {
      month_start: row.month_start,
      first: 0,
      second: 0,
      third: 0,
      fourth_plus: 0,
      total_visits: 0,
      return_visits: 0,
      return_rate_pct: null,
      low_sample: false,
      left_censored: false,
    };

    const visits = Number(row.visits) || 0;
    if (row.visit_number === 1) month.first += visits;
    else if (row.visit_number === 2) month.second += visits;
    else if (row.visit_number === 3) month.third += visits;
    else month.fourth_plus += visits;

    byMonth.set(row.month_start, month);
  }

  const censoredBefore = dataStartsAt ? addDays(dataStartsAt, CENSORING_DAYS) : null;

  return [...byMonth.values()]
    .map(m => {
      const total = m.first + m.second + m.third + m.fourth_plus;
      const returning = total - m.first;
      return {
        ...m,
        total_visits: total,
        return_visits: returning,
        // A zero denominator is unmeasurable, which is not the same as 0%.
        return_rate_pct: total > 0 ? Math.round((returning / total) * 1000) / 10 : null,
        low_sample: total < MIN_VISITS_FOR_RATE,
        left_censored: censoredBefore !== null && m.month_start < censoredBefore,
      };
    })
    .sort((a, b) => a.month_start.localeCompare(b.month_start));
}

/**
 * What must be said alongside the numbers.
 *
 * Computed rather than written into the tool description, on the same argument
 * as `coverageByAccount`: a caveat that applies sometimes and is stated always
 * stops being read, and one that applies and is not stated turns a true table
 * into a wrong answer.
 */
export function distributionCaveats(months: MonthDistribution[]): string[] {
  const caveats: string[] = [
    'These are VISITS, not guests. A guest who came twice in a month appears twice — once as a second visit and once as a third — so the buckets sum to the month\'s booked footfall.',
    'Booked guests only. SevenRooms issues a fresh client id for nearly every walk-in, so a walk-in can never be observed returning and including them would understate every rate here.',
    'Group and venue rows do not add up, on purpose: a guest who ate at two venues on one day is one GROUP visit and two OUTLET visits.',
  ];

  const censored = months.filter(m => m.left_censored);
  if (censored.length > 0) {
    caveats.push(
      `${censored.length} early month(s) are LEFT-CENSORED (through ${censored[censored.length - 1].month_start}): a guest whose first visit predates our records counts as a first-timer, so the first-visit share is overstated and the return rate understated. Do not read a rising trend out of the first year — it is partly the data filling in.`,
    );
  }

  const thin = months.filter(m => m.low_sample);
  if (thin.length > 0) {
    caveats.push(
      `${thin.length} month(s) have fewer than ${MIN_VISITS_FOR_RATE} visits. Their rates are returned but must not be read as movement.`,
    );
  }

  return caveats;
}

/**
 * The change across the window, stated only when it can be stated honestly.
 *
 * Returns null rather than a number when the endpoints cannot carry one. The
 * alternative -- first versus last regardless -- is how a censored month at one
 * end and a thin month at the other become "retention improved 9 points".
 */
export function rateChange(months: MonthDistribution[]): {
  from: MonthDistribution;
  to: MonthDistribution;
  change_pts: number;
} | null {
  const usable = months.filter(m => !m.low_sample && !m.left_censored && m.return_rate_pct !== null);
  if (usable.length < 2) return null;

  const from = usable[0];
  const to = usable[usable.length - 1];
  return {
    from,
    to,
    change_pts: Math.round((to.return_rate_pct! - from.return_rate_pct!) * 10) / 10,
  };
}
