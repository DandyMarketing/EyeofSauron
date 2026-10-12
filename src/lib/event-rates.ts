/**
 * The venue rates an event P&L is costed at, from the warehouse.
 *
 * THREE COMPLETE MONTHS, not one: a single month's cost of sales is purchases
 * rather than consumption, and one large delivery near a month end moves it by
 * points. Three months mostly cancels that. The window ends at the last
 * COMPLETE month, because the current one is still being booked.
 *
 * Every rate comes back with where it came from, and a rate that cannot be
 * computed comes back NULL and "to fill" -- never as zero, which would put a
 * free product cost into a P&L, exactly the template's mistake.
 */

import { supabaseAdmin } from '../auth/session.js';
import { selectAll } from './paged.js';
import { sumClassSplits } from './sales.js';
import { costRatios, type PLRow } from './cost-ratios.js';
import { fetchAccountMap, resolveAccount } from './account-map.js';
import { lastCompleteMonth } from './retention-month.js';
import type { VenueRates } from './event-pnl.js';

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function venueRates(venueId: string, today: string): Promise<VenueRates> {
  const last = lastCompleteMonth(today);
  const startD = new Date(`${last.start}T00:00:00Z`);
  startD.setUTCMonth(startD.getUTCMonth() - 2);
  const start = startD.toISOString().slice(0, 10);
  const span = `${MONTH[startD.getUTCMonth()]}–${MONTH[Number(last.end.slice(5, 7)) - 1]} ${last.end.slice(0, 4)}`;

  const [pl, ops, accountMap] = await Promise.all([
    selectAll(() => supabaseAdmin.from('profit_and_loss')
      .select('section, account_name, amount, is_summary')
      .eq('venue_id', venueId)
      .gte('period_start', start)
      .lte('period_end', last.end)),
    selectAll(() => supabaseAdmin.from('daily_operations')
      .select('business_date, gross_sales, sales_by_class, meal_periods')
      .eq('venue_id', venueId)
      .gte('business_date', start)
      .lte('business_date', last.end)),
    fetchAccountMap(venueId),
  ]);
  if (pl.error) throw new Error(`venue rates: ${pl.error.message}`);
  if (ops.error) throw new Error(`venue rates: ${ops.error.message}`);

  const rows: PLRow[] = (pl.data ?? []).map((r: any) => {
    const { canonical_account, business_line } = resolveAccount(r.account_name, accountMap);
    return { ...r, amount: Number(r.amount), canonical_account, business_line };
  });
  const sales = sumClassSplits(ops.data ?? []);
  const ratios = costRatios(rows, sales);

  // Same detection as the weekly fee check (src/scripts/recommend.ts): the
  // group's percentage charges, never "Licensing Expenses".
  const income = (pl.data ?? []).filter((r: any) => r.is_summary && /total income/i.test(r.account_name ?? ''))
    .reduce((t: number, r: any) => t + Number(r.amount), 0);
  const fees = (pl.data ?? []).filter((r: any) => !r.is_summary && /(management|licens\w*)\s*fee/i.test(r.account_name ?? ''))
    .reduce((t: number, r: any) => t + Number(r.amount), 0);

  const pct = (p: number | null) => (p === null ? null : Math.round(p * 100) / 10000);
  const fb = sales.food_sales + sales.beverage_sales;
  const food = pct(ratios.food.pct);
  const drink = pct(ratios.beverage.pct);

  return {
    food_cost: food === null
      ? { value: null, label: `Food cost could not be measured for ${span}: P&L or sales days missing`, basis: 'to fill' }
      : { value: food, label: `Food cost ÷ food sales, ${span} (Xero P&L + Revel)`, basis: 'our data' },
    drink_cost: drink === null
      ? { value: null, label: `Drink cost could not be measured for ${span}: P&L or sales days missing`, basis: 'to fill' }
      : { value: drink, label: `Drink cost ÷ drink sales, ${span} (Xero P&L + Revel)`, basis: 'our data' },
    food_share: fb > 0
      ? { value: Math.round((sales.food_sales / fb) * 10000) / 10000, label: `Food share of food & drink sales, ${span} (Revel)`, basis: 'our data' }
      : { value: null, label: 'No food and drink sales split to measure', basis: 'to fill' },
    group_fees: income > 0 && fees > 0
      ? { value: Math.round((fees / income) * 10000) / 10000, label: `Management + licensing fees ÷ total income, ${span} (Xero P&L)`, basis: 'our data' }
      : { value: null, label: `No group fee lines in the P&L for ${span}`, basis: 'to fill' },
    card_fees: { value: null, label: 'Ticketing platform and card rate: enter the quoted rate', basis: 'to fill' },
  };
}
