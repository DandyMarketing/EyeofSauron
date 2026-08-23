import { supabase } from './supabase.js';

/**
 * What a ledger account name means once the three charts of accounts are
 * reconciled.
 *
 * The three venues name the same cost differently -- Fat Prince is the outlier
 * on all nine variants, with Firangi Superstar and Neon Pigeon agreeing. Ask
 * about marketing spend across venues and it splits across "Public Relations /
 * Marketing costs" and "Public Relations / Marketing fees", which never add up,
 * in an answer that looks complete. Cross-venue benchmarking is the product's
 * stated edge and it only holds if the same cost carries the same label.
 *
 * TWO AXES, and they are not alternatives:
 *
 *   canonical_account  unifies naming, so venues can be COMPARED
 *   business_line      separates sub-businesses, so they can be ISOLATED
 *
 * Neon Pigeon runs a sushi business inside Potus Pte Ltd. It rolls INTO the
 * entity's P&L -- improving Potus's profitability was the point of launching it
 * -- and it is also reportable alone. So COGS - Sushi carries canonical
 * 'COGS - Food' and business line 'sushi': comparable with the other venues'
 * food cost, and still separable on demand.
 */

export interface AccountMapping {
  account_name: string;
  canonical_account: string;
  business_line: string;
}

/** Everything an account might be relabelled as, for one venue. */
export type VenueAccountMap = Map<string, AccountMapping>;

export const DEFAULT_BUSINESS_LINE = 'main';

/**
 * Resolve one account name.
 *
 * UNMAPPED FALLS BACK TO ITSELF, deliberately unlike the BOH/FOH role mapping
 * where an unmapped role must never default. The difference is what the default
 * does: falling into a bucket makes a category drift with no visible cause,
 * while falling back to your own name merges nothing and moves no figure. The
 * only cost is that unification has not happened yet -- and the admin console
 * lists it so somebody can decide.
 */
export function resolveAccount(
  accountName: string | null | undefined,
  map: VenueAccountMap,
): AccountMapping {
  const name = accountName ?? '';
  const mapped = map.get(name);
  if (mapped) return mapped;
  return { account_name: name, canonical_account: name, business_line: DEFAULT_BUSINESS_LINE };
}

/** Which of these accounts nobody has reviewed yet. */
export function unmappedAccounts(accountNames: string[], map: VenueAccountMap): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of accountNames) {
    if (!name || seen.has(name) || map.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Fold rows onto their canonical account.
 *
 * Kept pure and separate from the query handlers because this is the step that
 * decides whether two venues' figures are comparable, and it should be provable
 * without a database.
 */
export function rollUpByCanonical<T extends { account_name: string | null; amount: number }>(
  rows: T[],
  map: VenueAccountMap,
): Array<{ canonical_account: string; business_line: string; amount: number; source_accounts: string[] }> {
  const groups = new Map<string, { canonical_account: string; business_line: string; amount: number; source_accounts: string[] }>();

  for (const row of rows) {
    const { canonical_account, business_line } = resolveAccount(row.account_name, map);
    // Keyed on both axes: rolling sushi into food must not erase which line it
    // came from, or the sub-business becomes unreportable.
    const key = `${canonical_account}|${business_line}`;
    const group = groups.get(key) ?? {
      canonical_account,
      business_line,
      amount: 0,
      source_accounts: [],
    };
    group.amount += Number(row.amount ?? 0);
    const source = row.account_name ?? '';
    // Named so a reader can see what was merged. A rolled-up figure whose
    // inputs are invisible is one nobody can check.
    if (source && !group.source_accounts.includes(source)) group.source_accounts.push(source);
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

/**
 * The map for one venue.
 *
 * Paged, because this table has one row per account per venue and the 1,000-row
 * PostgREST cap has cost this project data four times. Small today; not
 * necessarily small at the fiftieth customer.
 */
export async function fetchAccountMap(venueId: string): Promise<VenueAccountMap> {
  const map: VenueAccountMap = new Map();
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('account_map')
      .select('account_name, canonical_account, business_line')
      .eq('venue_id', venueId)
      .order('account_name', { ascending: true })
      .range(from, from + PAGE - 1);

    /**
     * A failed read returns an EMPTY map, not an error, and that is the right
     * call here only because the fallback is harmless: every account resolves
     * to itself, so figures stay exactly where they were and no comparison is
     * silently merged. The alternative -- failing the whole query -- would take
     * down cost reporting because a cosmetic relabelling table was unreachable.
     */
    if (error) {
      console.error(`[account-map] could not read account_map (${error.message}). Accounts will resolve to their own names.`);
      return map;
    }

    for (const row of data ?? []) {
      map.set(row.account_name, {
        account_name: row.account_name,
        canonical_account: row.canonical_account,
        business_line: row.business_line ?? DEFAULT_BUSINESS_LINE,
      });
    }

    if (!data || data.length < PAGE) break;
  }

  return map;
}
