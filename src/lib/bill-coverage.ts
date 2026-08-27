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
      caveat: caveatFor(pct),
    });
  }

  return out.sort((a, b) => b.bills_total - a.bills_total);
}

export function caveatFor(pct: number | null): string | null {
  if (pct === null) {
    return 'No P&L figure for this account in the period, so coverage cannot be measured. Do not describe this breakdown as complete.';
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
