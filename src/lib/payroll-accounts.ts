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
 * The second guard, which does not depend on the P&L at all.
 *
 * WHY IT EXISTS. `payrollAccountIds` learns which accounts hold personal pay by
 * reading account NAMES out of the P&L. On 23 Aug 2026 an audit found bill
 * lines carrying named individuals' net salaries and SDL, with Ministry of
 * Manpower as the supplier, that the exclusion never had a chance of catching
 * -- because those accounts have NO P&L ROW. An account the report never
 * mentions has no name to match, so a name-based filter is blind to it by
 * construction. Two salary accounts at one venue, plus dividends and a
 * director loan repayment at the other two, all listing people.
 *
 * So this reads the LINE instead. A description saying "Net Salaries" is
 * personal pay whatever account it was coded to, and no chart of accounts has
 * to cooperate for it to be caught.
 *
 * DELIBERATELY BROAD, on the same reasoning as the account patterns: a false
 * positive drops one aggregate cost line, which is recoverable and still in the
 * P&L. A false negative puts somebody's salary in a queryable table.
 */
export const PERSONAL_PAY_DESCRIPTION_PATTERNS = [
  'net salar',
  'salaries',
  'salary',
  'payroll',
  'cpf',
  'sdl',
  'levy',
  'dividend',
  'loan repayment',
  'director fee',
  'staff advance',
];

/** Suppliers that only ever appear on payments to people. */
export const PERSONAL_PAY_SUPPLIER_PATTERNS = [
  'ministry of manpower',
  'dividends',
  'loan repayment',
];

/**
 * Does this bill line look like a payment to a person?
 *
 * Checked on every line regardless of its account, because the account-based
 * exclusion cannot see an account the P&L never reported.
 */
export function looksLikePersonalPay(
  description: string | null | undefined,
  supplierName: string | null | undefined,
): boolean {
  const text = (description ?? '').toLowerCase();
  if (PERSONAL_PAY_DESCRIPTION_PATTERNS.some(p => text.includes(p))) return true;

  const supplier = (supplierName ?? '').toLowerCase();
  return PERSONAL_PAY_SUPPLIER_PATTERNS.some(p => supplier.includes(p));
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
