/**
 * Which ledger accounts hold personal pay, and must never reach the warehouse
 * at line level.
 *
 * WHY THIS EXISTS. On 19 Aug 2026 supplier bills were ingested for the first
 * time and Neon Pigeon's June came back with 168 bill lines across four payroll
 * accounts -- roughly forty people times four accounts. Payroll is posted as
 * supplier bills in this chart of accounts, so pulling bills pulled individual
 * pay, which the security model says never to hold at all.
 *
 * The brief's reasoning is worth restating because it is what makes this the
 * right shape: the strongest protection is not ingesting personal pay, not
 * filtering it later. A filter has to be remembered at every read; an exclusion
 * at ingest has to be right once. Aggregate labour cost still reaches the
 * warehouse through the P&L, where it belongs -- a section total, no names, no
 * individual amounts.
 *
 * MATCHED BY NAME, deliberately. Account CODES differ between the three
 * organisations and would need a lookup per venue that somebody has to maintain;
 * names come from the same chart of accounts and read the same way. A name that
 * matches nothing costs nothing, and a payroll account named unusually will show
 * up as a coverage anomaly in the P&L rather than as personal data in a table.
 */

/**
 * Deliberately broad. A false positive drops one aggregate cost line from the
 * bills table -- recoverable, and the figure is still in the P&L. A false
 * negative puts somebody's salary in a warehouse, which is not.
 */
export const PAYROLL_ACCOUNT_PATTERNS = [
  'wages',
  'salar',        // salary, salaries
  'payroll',
  'cpf',          // Singapore: Central Provident Fund
  'sdl',          // Skills Development Levy
  'foreign workers',
  'fwl',
  'bonus',
  'commission paid to staff',
  'director',     // directors' fees are individual remuneration
  'staff advance',
];

/** True when an account name looks like personal pay. */
export function isPayrollAccount(accountName: string | null | undefined): boolean {
  if (!accountName) return false;
  const name = accountName.toLowerCase();
  return PAYROLL_ACCOUNT_PATTERNS.some(p => name.includes(p));
}

/**
 * Split account ids into the ones bills may carry and the ones they may not.
 *
 * Takes the P&L rows already in the warehouse, because that is where account
 * names live -- a bill line carries only a code and a UUID, so it cannot be
 * judged on its own.
 */
export function payrollAccountIds(
  plRows: Array<{ account_id: string | null; account_name: string | null }>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of plRows) {
    if (row.account_id && isPayrollAccount(row.account_name)) ids.add(row.account_id);
  }
  return ids;
}
