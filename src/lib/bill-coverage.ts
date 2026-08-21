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
 * ABOVE 100% IS ALSO REAL, and means the opposite problem. Credit notes
 * (ACCPAYCREDIT) reduce the ledger and we do not ingest them, so refunds and
 * returns are not deducted from the bill side. COGS Food measured 109%.
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
    return `ABOVE 100% (${pct}%) — credit notes (ACCPAYCREDIT) are not ingested, so refunds and returns are not deducted. This bill-derived figure is OVERSTATED; the P&L account total is the authority.`;
  }
  if (pct < COVERAGE_TRUSTWORTHY_PCT) {
    return `These bills explain only ${pct}% of the ledger account. The rest was card- or bank-settled and never became a bill, so it is invisible here. Never present this as the full breakdown.`;
  }
  return null;
}
