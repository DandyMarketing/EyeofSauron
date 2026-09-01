/**
 * Checking the fees the venues pay the umbrella.
 *
 * Established 26 Aug 2026 with Finance. Each venue pays The Dandy Partnership a
 * fee calculated as a PERCENTAGE OF SALES LESS DISCOUNTS. Neon Pigeon pays two
 * -- a Management Fee and a Licensing Fee, 3% each -- and Fat Prince and
 * Firangi pay one. Measured against total income the burden is 5.06% at Neon
 * Pigeon and about 4.4% at the other two.
 *
 * These are REAL COSTS, not an internal reallocation. Each venue is a separate
 * Pte Ltd with different shareholders, so money leaving Potus Pte Ltd does not
 * come back to Potus's investors. They belong in the venue's P&L exactly where
 * they are.
 *
 * WHY THEY ARE WORTH CHECKING AT ALL. A fee that is a formula on sales is the
 * easiest line in the ledger to verify and the easiest to get wrong unnoticed,
 * because nobody reads it -- it is expected to be boring. Neon Pigeon's June
 * 2026 fee came in at 1.99% of income against 2.43-2.59% in every other month
 * of the year. Nothing reported it.
 *
 * TWO CHECKS, AND THE FIRST IS FREE. Where a venue pays a matched PAIR at the
 * same rate on the same base, the two amounts must be identical -- they are at
 * Neon Pigeon, to the cent, in all seven months looked at. A divergence is a
 * coding error with no other possible cause, which makes it the strongest
 * signal available here. The second check is softer: a fee whose share of
 * income departs from its own recent norm.
 *
 * MEASURED AGAINST ITS OWN HISTORY, never against another venue's. The rates
 * differ by agreement, and comparing venues would flag the arrangement rather
 * than an error.
 */

export interface FeeMonth {
  period_start: string;
  account_name: string;
  amount: number;
  /** Total income for the same period, for the rate. */
  income: number | null;
}

export interface FeeAnomaly {
  period_start: string;
  kind: 'pair_mismatch' | 'rate_outlier';
  detail: string;
  /**
   * Why this month is known to be fine, when somebody has said so.
   *
   * Set rather than the anomaly being removed. A check that goes silent is
   * indistinguishable from one that stopped working -- the failure this
   * codebase keeps finding -- so an explained month stays visible and carries
   * its explanation instead of disappearing.
   */
  acknowledged?: string;
}

/**
 * Somebody has looked at this month and it is not an error.
 *
 * PER MONTH, never per venue. Neon Pigeon's June 2026 fee was set lower by the
 * founder, so it will trip the rate check every Monday for the rest of the
 * year -- and a monitor that cries wolf weekly is one nobody reads by
 * November, which costs us the real coding error it exists to catch. But
 * acknowledging the VENUE would silence June 2027 too, and that is the same
 * mistake with a longer fuse.
 *
 * `account_name` null acknowledges every fee that month, which is what a
 * decision affecting the whole charge looks like. Naming one acknowledges only
 * that fee, and the other half of a matched pair still reports.
 */
export interface FeeAcknowledgement {
  period_start: string;
  account_name: string | null;
  reason: string;
}

/**
 * How far a fee's share of income may drift before it is worth a look.
 *
 * Neon Pigeon's normal months sit within about 5% of their median; June was 22%
 * below. Fifteen percent sits clear of ordinary variation and still catches it
 * with room to spare -- a tighter threshold would fire on the honest wobble
 * that comes from other income moving rather than the fee.
 */
export const RATE_DRIFT_TOLERANCE = 0.15;

/** Enough history for a median to mean anything. */
export const MIN_MONTHS_FOR_RATE_CHECK = 4;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const money = (n: number) => `$${n.toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Fee months that do not look like the others.
 *
 * Returns an empty array when everything is normal, which is the expected
 * outcome -- and the caller must report that as nothing wrong rather than as no
 * data, the same rule as the booking channel monitor.
 */
export function feeAnomalies(
  rows: FeeMonth[],
  acknowledged: FeeAcknowledgement[] = [],
): FeeAnomaly[] {
  const anomalies: FeeAnomaly[] = [];

  // --- paired fees must match, and that is the strong check ---------------
  const byPeriod = new Map<string, FeeMonth[]>();
  for (const row of rows) {
    const list = byPeriod.get(row.period_start) ?? [];
    list.push(row);
    byPeriod.set(row.period_start, list);
  }

  for (const [period, fees] of byPeriod) {
    if (fees.length < 2) continue;

    // Rounded to the cent: these are computed from the same base by the same
    // formula, so anything beyond a rounding difference is an error.
    const amounts = [...new Set(fees.map(f => Math.round(f.amount * 100)))];
    if (amounts.length > 1) {
      anomalies.push({
        period_start: period,
        kind: 'pair_mismatch',
        detail:
          `${fees.map(f => `${f.account_name} ${money(f.amount)}`).join(' vs ')} in ${period}. ` +
          `These are charged at the same rate on the same base and are identical in every normal month, ` +
          `so a difference is a coding error rather than a business change.`,
      });
    }
  }

  // --- and a fee that has drifted against its own history -----------------
  const byAccount = new Map<string, FeeMonth[]>();
  for (const row of rows) {
    if (row.income === null || row.income === 0) continue;
    const list = byAccount.get(row.account_name) ?? [];
    list.push(row);
    byAccount.set(row.account_name, list);
  }

  for (const [account, months] of byAccount) {
    if (months.length < MIN_MONTHS_FOR_RATE_CHECK) continue;

    const rates = months.map(m => m.amount / (m.income as number));
    const normal = median(rates);
    if (normal <= 0) continue;

    for (const month of months) {
      const rate = month.amount / (month.income as number);
      const drift = Math.abs(rate - normal) / normal;
      if (drift < RATE_DRIFT_TOLERANCE) continue;

      anomalies.push({
        period_start: month.period_start,
        kind: 'rate_outlier',
        detail:
          `${account} was ${(rate * 100).toFixed(2)}% of income in ${month.period_start}, ` +
          `against a normal ${(normal * 100).toFixed(2)}%. ` +
          `The fee is a fixed percentage of sales less discounts, so it should not move as a share of income — ` +
          `either the fee was mis-charged or something unusual sat in income that month.`,
      });
    }
  }

  return anomalies
    .map(a => {
      // A pair mismatch spans both fees, so only a whole-month acknowledgement
      // can explain it. Naming one account cannot account for the two
      // disagreeing.
      const match = acknowledged.find(ack =>
        ack.period_start === a.period_start &&
        (ack.account_name === null ||
          (a.kind === 'rate_outlier' && a.detail.startsWith(ack.account_name))),
      );
      return match ? { ...a, acknowledged: match.reason } : a;
    })
    .sort((a, b) =>
      a.period_start === b.period_start
        ? (a.kind === 'pair_mismatch' ? -1 : 1)
        : b.period_start.localeCompare(a.period_start),
    );
}

/** The ones nobody has explained yet. */
export function unexplained(anomalies: FeeAnomaly[]): FeeAnomaly[] {
  return anomalies.filter(a => !a.acknowledged);
}

/**
 * The line that goes on the face of a briefing.
 *
 * Only the most recent finding, and only when there is one. A briefing is three
 * things at most; a list of every fee wobble since January would crowd out the
 * advice it exists to deliver.
 */
export function feeWarning(anomalies: FeeAnomaly[]): string | null {
  const open = unexplained(anomalies);
  if (open.length === 0) {
    /**
     * Explained is not the same as absent, and the briefing says so.
     *
     * Going silent would leave a reader unable to tell "the fees are fine"
     * from "the check broke". One quiet line costs nothing and keeps the
     * monitor's silence meaningful.
     */
    const explained = anomalies.filter(a => a.acknowledged);
    if (explained.length === 0) return null;
    const [newest] = explained;
    return `The fee to the group in ${newest.period_start} is outside its usual range, and that is known and accounted for: ${newest.acknowledged}. Nothing to raise.`;
  }

  const [newest] = open;
  const rest = open.length - 1;

  return (
    `A FEE TO THE GROUP DOES NOT LOOK RIGHT. ${newest.detail}` +
    (rest > 0 ? ` (${rest} other month(s) also look off.)` : '') +
    ` Worth a question to Finance. Do not treat it as a cost decision the venue made — these fees are a formula on sales and nobody on the floor controls them.`
  );
}
