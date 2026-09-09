/**
 * Attributing a revenue change to its parts, exactly.
 *
 * Revenue is an identity -- covers times spend per head -- so a change in it
 * can be split with NOTHING left over. That is the whole argument for this
 * being the first answer to "why did revenue drop": it is subtraction, so it
 * cannot produce a false finding, needs no confidence figure, and does not care
 * how many weeks of history exist.
 *
 * IT ANSWERS "WHAT", NEVER "WHY". Covers fell is a fact; the event diary
 * emptied is a hypothesis. This narrows the question to one branch and hands it
 * on -- to booking channels if bookings fell, to lead time if people are
 * booking later, to correlation for anything outside the identity. An engine
 * that skips this step and goes straight to correlation is guessing at a
 * question arithmetic had already answered.
 */

/** One period for one venue, as `revenue_decomposition` returns it. */
export interface PeriodRow {
  venue_id: string;
  period: 'current' | 'prior' | string;
  net_sales: number;
  covers: number;
  booked_covers: number;
  walkin_covers: number;
  bookings: number;
  trading_days: number;
}

export interface Contribution {
  /** What changed, in the reader's words rather than a column name. */
  label: string;
  /** Dollars. These SUM to the revenue change, exactly. */
  amount: number;
  /** Share of the total change, or null when the change was zero. */
  share_pct: number | null;
}

export interface Baseline {
  /** Complete weeks behind the comparison, oldest first. */
  weeks: Array<{ week_start: string; net_sales: number; covers: number }>;
  mean_net_sales: number | null;
  min_net_sales: number | null;
  max_net_sales: number | null;
  /** The current period against the trailing mean, as a percentage. */
  vs_mean_pct: number | null;
  /** Inside the trailing range, or outside it in one direction. */
  standing: 'above the range' | 'below the range' | 'within the range' | 'unknown';
  /**
   * Which way the baseline itself is moving, judged on the halves rather than a
   * fitted line. A slope over eight noisy weeks invites a confidence figure it
   * cannot support; comparing the older half against the newer half says the
   * same thing without pretending to precision.
   */
  direction: 'rising' | 'falling' | 'flat' | 'unknown';
  direction_pct: number | null;
}

export interface Decomposition {
  net_sales: { from: number; to: number; change: number; change_pct: number | null };
  /** Covers and spend per head, in dollars, summing to the revenue change. */
  drivers: Contribution[];
  covers: { from: number; to: number; change: number; booked_change: number; walkin_change: number };
  /** Only meaningful when booked covers moved: bookings versus party size. */
  booked: { bookings_from: number; bookings_to: number; party_from: number | null; party_to: number | null };
  spend_per_head: { from: number | null; to: number | null };
  trading_days: { from: number; to: number };
  /** Where this period sits against the weeks behind it. */
  baseline: Baseline;
  caveats: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const d0Pct = (change: number, from: number): number =>
  from === 0 ? 0 : Math.round((change / from) * 1000) / 10;
const div = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/**
 * Below this, a percentage move in spend per head is inside the noise between
 * two systems and must not be read as behaviour.
 *
 * Revenue is Revel's and covers are SevenRooms', and CLAUDE.md records that the
 * two disagree on guest counts because covers are the BOOKED party size while
 * the POS counts who actually sat. A two-point wobble in spend per head can be
 * entirely that.
 */
export const SPEND_PER_HEAD_NOISE_PCT = 2;

/**
 * Fewer than this many trading days and a period comparison is a coin toss.
 *
 * A week is seven; anything under four is comparing part of a week against a
 * whole one, which is the partial-bucket failure BUILD_LOG 3.1 records.
 */
export const MIN_TRADING_DAYS = 4;

/**
 * Weeks of history below which a baseline is not worth stating.
 *
 * Four is enough to say whether a week is unusual and is NOT enough to call a
 * direction, so the two thresholds differ deliberately.
 */
export const MIN_BASELINE_WEEKS = 4;
export const MIN_DIRECTION_WEEKS = 6;

/**
 * How far the halves must differ before the baseline is called moving.
 *
 * Five percent, because week-to-week revenue in a restaurant swings more than
 * that on weather alone. A lower bar would report a direction every single
 * week, which is the same as reporting none.
 */
export const DIRECTION_THRESHOLD_PCT = 5;

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Where this period stands against the weeks behind it.
 *
 * WHY IT SHIPS WITH THE COMPARISON. The dry run on 9 Sep 2026 reached its real
 * conclusion here rather than from the week-on-week figure: Fat Prince was 11%
 * below the previous week AND 17% above the four-week July average, so the
 * fortnight between was the outlier and not the review week a collapse.
 * Week-on-week alone would have reported a crash and sent somebody to fix a
 * venue that was performing.
 */
export function baselineOf(
  current: PeriodRow,
  weekRows: Array<{ period: string; net_sales: number; covers: number }>,
): Baseline {
  const weeks = weekRows
    .filter(r => r.period.startsWith('week:'))
    .map(r => ({ week_start: r.period.slice(5), net_sales: round2(r.net_sales), covers: r.covers }))
    // Oldest first, so a reader and a chart both get chronological order.
    .sort((a, b) => a.week_start.localeCompare(b.week_start));

  const values = weeks.map(w => w.net_sales);
  const avg = values.length >= MIN_BASELINE_WEEKS ? mean(values) : null;
  const lo = values.length >= MIN_BASELINE_WEEKS ? Math.min(...values) : null;
  const hi = values.length >= MIN_BASELINE_WEEKS ? Math.max(...values) : null;

  let direction: Baseline['direction'] = 'unknown';
  let directionPct: number | null = null;

  if (values.length >= MIN_DIRECTION_WEEKS) {
    const half = Math.floor(values.length / 2);
    const older = mean(values.slice(0, half));
    const newer = mean(values.slice(values.length - half));
    if (older !== null && newer !== null && older !== 0) {
      directionPct = Math.round(((newer - older) / older) * 1000) / 10;
      direction = Math.abs(directionPct) < DIRECTION_THRESHOLD_PCT ? 'flat'
        : directionPct > 0 ? 'rising' : 'falling';
    }
  }

  return {
    weeks,
    mean_net_sales: avg === null ? null : round2(avg),
    min_net_sales: lo,
    max_net_sales: hi,
    vs_mean_pct: avg === null || avg === 0 ? null : Math.round(((current.net_sales - avg) / avg) * 1000) / 10,
    standing: lo === null || hi === null ? 'unknown'
      : current.net_sales > hi ? 'above the range'
      : current.net_sales < lo ? 'below the range'
      : 'within the range',
    direction,
    direction_pct: directionPct,
  };
}

export function decompose(
  current: PeriodRow,
  prior: PeriodRow,
  weekRows: Array<{ period: string; net_sales: number; covers: number }> = [],
): Decomposition {
  const sphFrom = div(prior.net_sales, prior.covers);
  const sphTo = div(current.net_sales, current.covers);

  const change = round2(current.net_sales - prior.net_sales);

  /**
   * THREE TERMS, and the third is real arithmetic rather than a rounding fudge.
   *
   * For revenue = covers x spend, the change splits as
   *
   *     (dCovers x spend_before) + (covers_before x dSpend) + (dCovers x dSpend)
   *
   * and those sum to the change EXACTLY. The interaction term is small when
   * both moves are small and genuinely large when both are large, so it is
   * reported rather than allocated across the other two -- allocating it would
   * make two exact figures into two estimates in order to hide a third.
   */
  const dCovers = current.covers - prior.covers;
  const dSpend = (sphTo ?? 0) - (sphFrom ?? 0);

  const fromCovers = round2(dCovers * (sphFrom ?? 0));
  const fromSpend = round2(prior.covers * dSpend);
  const interaction = round2(change - fromCovers - fromSpend);

  const share = (n: number): number | null =>
    change === 0 ? null : Math.round((n / change) * 1000) / 10;

  const drivers: Contribution[] = [
    { label: dCovers === 0 ? 'Covers unchanged' : dCovers < 0 ? 'Fewer covers' : 'More covers', amount: fromCovers, share_pct: share(fromCovers) },
    { label: dSpend < 0 ? 'Lower spend per head' : dSpend > 0 ? 'Higher spend per head' : 'Spend per head unchanged', amount: fromSpend, share_pct: share(fromSpend) },
    { label: 'Combined effect', amount: interaction, share_pct: share(interaction) },
  ];

  const partyFrom = div(prior.booked_covers, prior.bookings);
  const partyTo = div(current.booked_covers, current.bookings);

  const caveats: string[] = [];

  if (prior.trading_days < MIN_TRADING_DAYS || current.trading_days < MIN_TRADING_DAYS) {
    caveats.push(
      `One of these periods has fewer than ${MIN_TRADING_DAYS} trading days (${prior.trading_days} against ${current.trading_days}). Comparing them compares part of a week with a whole one, which reports a collapse that is really a calendar.`,
    );
  } else if (prior.trading_days !== current.trading_days) {
    // Not a fault -- a closure or a holiday -- but it moves every total, and a
    // reader who does not know will read the difference as trade.
    caveats.push(
      `The periods have different numbers of trading days (${prior.trading_days} against ${current.trading_days}), so part of this change is simply days open. Compare per-day figures before drawing a conclusion.`,
    );
  }

  if (sphFrom !== null && sphTo !== null && sphFrom !== 0) {
    const movePct = Math.abs((sphTo - sphFrom) / sphFrom) * 100;
    if (movePct < SPEND_PER_HEAD_NOISE_PCT) {
      caveats.push(
        `Spend per head moved less than ${SPEND_PER_HEAD_NOISE_PCT}%, which is inside the disagreement between the two systems this divides. Revenue is Revel's and covers are SevenRooms' booked party size, so treat a move this small as noise rather than behaviour.`,
      );
    }
  }

  if (current.covers === 0 || prior.covers === 0) {
    caveats.push('One period has no completed covers, so spend per head cannot be computed for it and the split is unavailable. Check whether reservations ingested for those dates before reading this as a collapse.');
  }

  /**
   * The branch to follow next, named rather than left to be worked out.
   *
   * The point of a decomposition is that it ends pointing somewhere. Saying
   * "covers fell" and stopping leaves the reader exactly where they started.
   */
  if (dCovers !== 0) {
    const bookedShare = Math.abs(current.booked_covers - prior.booked_covers);
    const walkinShare = Math.abs(current.walkin_covers - prior.walkin_covers);
    if (bookedShare > walkinShare) {
      caveats.push('The cover change is mostly BOOKED covers, so the next question is about the booking pipe rather than the venue: check_booking_channels for a channel that died, query_booking_lead_time for people booking later rather than not at all.');
    } else if (walkinShare > bookedShare) {
      caveats.push('The cover change is mostly WALK-INS, which no booking channel explains. Look at footfall, weather, a nearby closure or a holiday before anything internal.');
    }
  }

  const baseline = baselineOf(current, weekRows);

  /**
   * The comparison and the baseline DISAGREEING is the most useful thing this
   * produces, so it is stated rather than left for the reader to notice.
   *
   * Down on the week and up on the run rate means the week before was the
   * outlier. Nobody should be sent to fix a venue that is performing.
   */
  if (baseline.vs_mean_pct !== null && change !== 0) {
    const downOnWeek = change < 0;
    const upOnRun = baseline.vs_mean_pct > 0;
    if (downOnWeek && upOnRun) {
      caveats.push(
        `Down ${Math.abs(d0Pct(change, prior.net_sales))}% on the previous period but ${baseline.vs_mean_pct}% ABOVE the ${baseline.weeks.length}-week average. The period before was the outlier, not this one the collapse — say so before anyone treats this as a fall.`,
      );
    } else if (!downOnWeek && !upOnRun) {
      caveats.push(
        `Up on the previous period but still ${Math.abs(baseline.vs_mean_pct)}% BELOW the ${baseline.weeks.length}-week average. A recovery from a bad period is not a good period.`,
      );
    }
  }

  if (baseline.direction !== 'unknown' && baseline.direction !== 'flat') {
    caveats.push(
      `The underlying run rate is ${baseline.direction} — the newer half of the trailing weeks averages ${baseline.direction_pct}% against the older half. A single period against a ${baseline.direction} baseline moves for two reasons at once.`,
    );
  } else if (baseline.weeks.length < MIN_DIRECTION_WEEKS) {
    caveats.push(
      `Only ${baseline.weeks.length} trailing week(s) available, fewer than the ${MIN_DIRECTION_WEEKS} needed to call a direction. Whether this is a trend or a blip cannot be said yet.`,
    );
  }

  return {
    net_sales: {
      from: round2(prior.net_sales),
      to: round2(current.net_sales),
      change,
      change_pct: prior.net_sales === 0 ? null : Math.round((change / prior.net_sales) * 1000) / 10,
    },
    drivers,
    covers: {
      from: prior.covers,
      to: current.covers,
      change: dCovers,
      booked_change: current.booked_covers - prior.booked_covers,
      walkin_change: current.walkin_covers - prior.walkin_covers,
    },
    booked: {
      bookings_from: prior.bookings,
      bookings_to: current.bookings,
      party_from: partyFrom === null ? null : Math.round(partyFrom * 100) / 100,
      party_to: partyTo === null ? null : Math.round(partyTo * 100) / 100,
    },
    spend_per_head: {
      from: sphFrom === null ? null : round2(sphFrom),
      to: sphTo === null ? null : round2(sphTo),
    },
    trading_days: { from: prior.trading_days, to: current.trading_days },
    baseline,
    caveats,
  };
}

/**
 * The period immediately before the one asked about, of the same length.
 *
 * Same length rather than "last week", so a fortnight compares against the
 * fortnight before it. A comparison of unequal spans reports arithmetic as
 * performance, which is the failure this whole file exists to avoid.
 */
export function precedingPeriod(start: string, end: string): { start: string; end: string } {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) throw new Error('precedingPeriod: dates must be YYYY-MM-DD');

  const days = Math.round((e - s) / 86_400_000) + 1;
  const prevEnd = new Date(s - 86_400_000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86_400_000);

  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10),
  };
}
