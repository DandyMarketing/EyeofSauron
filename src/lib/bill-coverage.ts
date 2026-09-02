/**
 * How much of a ledger account the supplier bills actually explain.
 *
 * WHY THIS IS A FUNCTION AND NOT A SENTENCE IN A PROMPT. Bills answer "we spent
 * $26,034 on marketing — on what?" only partly. Measured at Neon Pigeon for
 * June 2026: rent, utilities and food purchases came back at roughly 100%,
 * Public Relations / Marketing at 26%, Commissions at 7%, Merchant fees at 1%,
 * and COGS Beverages at 0%. Anything card- or bank-settled never becomes a
 * bill, so it is invisible to /Invoices.
 *
 * A list of four marketing suppliers totalling $6,800, presented as the
 * breakdown of a $26,034 account, is a true list and a wrong answer. The reader
 * has no way to tell -- which makes it exactly the failure this codebase keeps
 * finding, and the reason the percentage is computed here and returned with
 * every response rather than left to the model to remember.
 *
 * A MISSING DENOMINATOR IS USUALLY NOT A PROBLEM AT ALL, which is the other
 * thing this had wrong. Bills coded to Prepayments or Renovation have no P&L
 * line because an asset is not a cost -- and reporting that as "coverage
 * cannot be measured" reads as cost we failed to capture. See caveatFor().
 *
 * ABOVE 100% IS ALSO REAL, and means the opposite problem: the bill side claims
 * more was spent than the ledger recorded. COGS Food measured 109%. The cause
 * WAS un-ingested credit notes, and no longer is -- migration 031 pulls
 * ACCPAYCREDIT and stores it negative, so credits already net against bills
 * here. What is left over is timing or a mis-coded line, and the caveat says so
 * rather than sending somebody to fix what is fixed.
 */

/** One bill line, reduced to what coverage needs. */
export interface CoverageLine {
  account_id: string | null;
  account: string | null;
  amount: number;
}

export interface AccountCoverage {
  account: string;
  bills_total: number;
  /** The P&L figure for the same account and period, or null if it has none. */
  ledger_total: number | null;
  /** Bills as a percentage of the ledger, to one decimal. Null when unmeasurable. */
  coverage_pct: number | null;
  bill_lines: number;
  /**
   * What to say about this account, or null when the bills genuinely do
   * explain it. Per-account rather than one blanket warning, because the reason
   * differs per account and a caveat repeated identically everywhere is a
   * caveat nobody reads.
   */
  caveat: string | null;
}

/** Below this, a breakdown must not be described as the whole picture. */
export const COVERAGE_TRUSTWORTHY_PCT = 80;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function coverageByAccount(
  lines: CoverageLine[],
  ledgerTotals: Map<string, number>,
): AccountCoverage[] {
  const byAccount = new Map<string, { account: string; bills_total: number; bill_lines: number }>();

  for (const line of lines) {
    // A line whose account we cannot name still counts -- dropping it would
    // quietly shrink the numerator and flatter the coverage figure.
    const key = line.account_id ?? 'unmapped';
    const entry = byAccount.get(key) ?? {
      account: line.account ?? 'Unmapped account',
      bills_total: 0,
      bill_lines: 0,
    };
    entry.bills_total += line.amount;
    entry.bill_lines += 1;
    byAccount.set(key, entry);
  }

  const out: AccountCoverage[] = [];

  for (const [accountId, entry] of byAccount) {
    const ledger = ledgerTotals.get(accountId);
    // A zero ledger total cannot be a denominator, and is not the same as a
    // missing one -- both are unmeasurable, neither is 0% or 100%.
    const measurable = ledger !== undefined && ledger !== 0;
    const pct = measurable ? Math.round((entry.bills_total / ledger!) * 1000) / 10 : null;

    out.push({
      account: entry.account,
      bills_total: round2(entry.bills_total),
      ledger_total: ledger !== undefined ? round2(ledger) : null,
      coverage_pct: pct,
      bill_lines: entry.bill_lines,
      caveat: caveatFor(pct, ledger ?? null),
    });
  }

  return out.sort((a, b) => b.bills_total - a.bills_total);
}

export function caveatFor(pct: number | null, ledgerTotal?: number | null): string | null {
  if (pct === null) {
    /**
     * A ZERO ledger line and a MISSING one both give a null percentage and are
     * not the same fact. Zero means the P&L reported this account and it came
     * to nothing -- so bills coded to it are in the wrong period, or the
     * account nets off within it. Missing means the account is not on the
     * report at all, which is the balance-sheet case below. Collapsing them
     * would send someone looking for an asset that is really a timing error.
     */
    if (ledgerTotal === 0) {
      return 'The P&L reports this account at ZERO for the period, yet bills were coded to it. A percentage is meaningless against zero. Either those bills belong to a different period, or the account nets off within this one. The P&L total is the authority.';
    }
    /**
     * "Unmeasurable" was read as "missing", and they are opposite things.
     *
     * Investigated 2 Sep 2026. Four Neon Pigeon accounts carried $22,641 of
     * June bills with no P&L line, which this reported as coverage that could
     * not be measured -- indistinguishable, to a reader, from cost we had
     * failed to capture. Two of the four were 620 Prepayments and 730
     * Renovation: a Current Asset and a Fixed Asset. That spend is correctly
     * absent from a profit and loss report, and nothing was wrong.
     *
     * Since migration 8a19fa5 the P&L is fetched with standardLayout=true and
     * reports every account with activity, so a bill coded to an account with
     * no P&L line is now most likely a balance-sheet account. Most likely is
     * not certain -- a P&L account with no activity in the period looks the
     * same -- so this says which is probable and names the other rather than
     * asserting one.
     */
    return 'No P&L line for this account in this period. The P&L reports every account with activity, so this is most likely a BALANCE-SHEET account — a prepayment, an asset purchase, stock — which is real spend that correctly never appears in a profit and loss. Do not describe it as missing cost or as a gap in coverage. It can also mean a P&L account with no activity this period.';
  }
  if (pct > 100) {
    /**
     * Credit notes ARE ingested now (migration 031), stored negative so they
     * net against bills. So this no longer has a known cause, and saying it
     * does would send someone to fix something already fixed.
     *
     * What remains: a bill dated in one period and its credit in the next, a
     * bill coded to an account the P&L reports differently, or a genuine
     * mis-coding. The P&L stays the authority either way.
     */
    return `ABOVE 100% (${pct}%) — bills and credits together exceed the ledger total for this account, which should not happen. Credit notes ARE included (stored negative), so the likely causes are timing (a bill in one period credited in the next) or a mis-coded line. Treat the P&L account total as the authority and say the bill-derived figure does not reconcile.`;
  }
  if (pct < COVERAGE_TRUSTWORTHY_PCT) {
    return `These bills explain only ${pct}% of the ledger account. The rest was card- or bank-settled and never became a bill, so it is invisible here. Never present this as the full breakdown.`;
  }
  return null;
}
