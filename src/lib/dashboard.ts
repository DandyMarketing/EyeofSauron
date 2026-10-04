/**
 * The week-to-date figures behind the dashboard, for one venue or several.
 *
 * ONE CALL FOR THE WHOLE PAGE. The front-end rules in CLAUDE.md say never to
 * serialise two requests that do not depend on each other, and the strongest
 * version of that is not to make the second request at all: the page needs
 * figures, a daily line, tonight's book and the week's advice, and asking for
 * them separately would put four round trips on a phone on mobile data between
 * services. The handler assembles them in parallel and returns one object.
 *
 * NOTHING IS COMPUTED IN THE BROWSER. Every figure here comes out of the
 * warehouse through src/lib/sales.ts, including the percentages -- a share the
 * page worked out itself is a number nobody can check, and it is the easiest
 * kind to get subtly wrong. Same rule as the query tools.
 *
 * VENUE SCOPE IS THE CALLER'S JOB AND IT IS NOT OPTIONAL. This runs with the
 * service role, which bypasses RLS entirely, so the venue list passed in IS the
 * control. `venueIds: []` must never be read as "no restriction" -- that is the
 * exact trap BUILD_LOG 4.3 records, and the endpoint refuses rather than
 * widening.
 */

import { supabaseAdmin } from '../auth/session.js';
import { salesFiguresOf, classSplitOf } from './sales.js';
import { getCovers } from './covers.js';
import { periodWindow, movement, defaultPeriod, type PeriodKind, type PeriodWindow } from './dashboard-window.js';
import { rollUp, type VenueWeek } from './dashboard-rollup.js';
import {
  lastCompleteMonth, retentionShares, sumCounts, leftCensored, inPlainWords,
  type RetentionCounts, type RetentionShares,
} from './retention-month.js';
import { costRatios, costCaveats, classifyCogs, type CostRatios, type PLRow } from './cost-ratios.js';
import { weeklyCogs, coverageFor, type WeeklyCogs, type BillLine, type AccountNames } from './weekly-cogs.js';
import { fetchAccountMap, resolveAccount } from './account-map.js';
export type { VenueWeek };
export { rollUp };
import { getClosedWeekdays } from '../ingest/revel.js';
import { weekdayOf } from '../ingest/closures.js';


interface SalesRowFromDb {
  venue_id: string;
  business_date: string;
  gross_sales: unknown;
  net_sales: unknown;
  item_discounts: unknown;
  order_discounts: unknown;
  total_transactions: unknown;
  sales_by_class: unknown;
}

/**
 * Read daily_operations for a window, PAGED.
 *
 * PostgREST caps a response at 1,000 rows and BUILD_LOG section 1 records that
 * costing data five separate times. Three venues times fourteen days cannot
 * reach it today, which is exactly the reasoning that was wrong every previous
 * time: the cap is a property of the database layer, not of this query's
 * current size.
 */
async function readOperations(venueIds: string[], start: string, end: string): Promise<SalesRowFromDb[]> {
  const PAGE = 1000;
  const rows: SalesRowFromDb[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('daily_operations')
      .select('venue_id, business_date, gross_sales, net_sales, item_discounts, order_discounts, total_transactions, sales_by_class')
      .in('venue_id', venueIds)
      .gte('business_date', start)
      .lte('business_date', end)
      .order('business_date', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`dashboard: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as SalesRowFromDb[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

/** Zero sales and zero transactions means the venue did not open. */
function closed(row: SalesRowFromDb): boolean {
  return Number(row.gross_sales ?? 0) === 0 && Number(row.total_transactions ?? 0) === 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RetentionBlock {
  /** The month measured. Never the current week — see retention-month.ts. */
  month: { start: string; end: string; label: string };
  counts: RetentionCounts;
  shares: RetentionShares;
  /** The sentence to put in front of a manager, with the counts in it. */
  plain: string;
  /**
   * Set when the month's 365-day lookback reaches past the start of the
   * records. The rate is understated and must not be shown as a measurement.
   */
  withheld: boolean;
}

export interface CostBlock {
  month: { start: string; end: string; label: string };
  ratios: CostRatios;
  caveats: string[];
  /** False when no P&L has been ingested for that month. Never inferred. */
  available: boolean;
}

export interface DashboardPayload {
  window: PeriodWindow;
  /**
   * Food and beverage cost for the SELECTED period, from supplier bills.
   *
   * Bills carry a date, so unlike the P&L this follows whatever window is on
   * screen -- which is the correction Khai made: "a weekly cogs is based on the
   * same week sales, invoices are uploaded at their best daily." Null when the
   * venue has no bills ingested. It sits BESIDE the ledger figure rather than
   * replacing it: bills are earlier and noisier, the ledger is slower and
   * settled, and the coverage percentage is what says which to believe.
   */
  period_costs: Record<string, WeeklyCogs> | null;
  /**
   * Cost of sales for the last COMPLETE month, beside the retention block and
   * for the same reason: the P&L's finest grain is a month, so there is no
   * week-to-date version of a food cost percentage. Null when nothing could be
   * computed at all.
   */
  costs: Record<string, CostBlock> | null;
  /**
   * MONTHLY, and labelled as such. Null when SevenRooms has nothing to measure.
   * It sits on a week-to-date page because a week holds too few returning
   * guests for the rate to mean anything — the same reason create_chart forces
   * both retention measures to monthly whatever it is asked for.
   */
  retention: Record<string, RetentionBlock> | null;
  venues: VenueWeek[];
  /** Present only when more than one venue is in scope. */
  group: VenueWeek | null;
}

export async function buildDashboard(
  venues: Array<{ id: string; name: string; slug: string }>,
  today?: string,
  period?: PeriodKind,
): Promise<DashboardPayload> {
  if (venues.length === 0) {
    throw new Error('dashboard: no venues in scope — refusing rather than reading every venue');
  }

  /**
   * THE LAST DAY WE ACTUALLY HAVE, before any window is built.
   *
   * Revel delivers overnight carrying the previous day, so during any given day
   * the warehouse's most recent complete day is yesterday. A window running to
   * the calendar's today therefore holds one day less TRADE than the window it
   * is compared against -- five days against six -- and reports a fall every
   * day of every week. The dates were right and the data behind one of them
   * was not, which is the hardest version of this to see.
   */
  const { data: latest } = await supabaseAdmin
    .from('daily_operations')
    .select('business_date')
    .in('venue_id', venues.map(v => v.id))
    .lte('business_date', today ?? new Date().toISOString().slice(0, 10))
    .order('business_date', { ascending: false })
    .limit(1);
  const dataThrough: string | null = latest?.[0]?.business_date ?? null;

  const window = periodWindow(period ?? defaultPeriod(today), today, dataThrough);
  const ids = venues.map(v => v.id);

  /**
   * Everything that does not depend on anything else, at once.
   *
   * The two sales reads and the covers reads have no ordering between them, and
   * awaiting them in sequence would make the slowest page in the app out of the
   * one people open most.
   */
  const [currentRows, priorRows, coversCurrent, coversPrior, coversUpcoming, closedWeekdays] = await Promise.all([
    readOperations(ids, window.current.start, window.current.end),
    readOperations(ids, window.prior.start, window.prior.end),
    Promise.all(venues.map(v => getCovers(v.id, window.current.start, window.current.end))),
    Promise.all(venues.map(v => getCovers(v.id, window.prior.start, window.prior.end))),
    // Today forward, so "tonight's book" is there without a second request.
    Promise.all(venues.map(v => getCovers(v.id, window.today, addDays(window.today, 6)))),
    Promise.all(venues.map(v => getClosedWeekdays(v.id))),
  ]);

  const out: VenueWeek[] = venues.map((v, i) => {
    const mine = currentRows.filter(r => r.venue_id === v.id);
    const theirs = priorRows.filter(r => r.venue_id === v.id);

    const sum = (rows: SalesRowFromDb[]) => {
      const t = {
        gross_sales: 0, food_bev_sales: 0, food_sales: 0, beverage_sales: 0,
        net_sales: 0, service_charge: 0, total_discounts: 0, transactions: 0,
        trading_days: 0, closed_days: [] as string[],
      };
      for (const r of rows) {
        if (closed(r)) { t.closed_days.push(r.business_date); continue; }
        t.trading_days++;
        const f = salesFiguresOf(r as any);
        const split = classSplitOf(r as any);
        t.gross_sales += f.gross_sales;
        t.food_bev_sales += f.food_bev_sales;
        t.net_sales += f.net_sales;
        t.service_charge += f.service_charge ?? 0;
        t.total_discounts += f.total_discounts;
        t.food_sales += split.food_sales;
        t.beverage_sales += split.beverage_sales;
        t.transactions += Number(r.total_transactions ?? 0);
      }
      return t;
    };

    const cur = sum(mine);
    const pri = sum(theirs);

    /**
     * Covers are counted over the days that TRADED, matching the sales above.
     * A closed day has no covers and including it would not change the total,
     * but a venue with no SevenRooms data at all must come back null rather
     * than 0 — "nobody came" and "we cannot see" are different answers.
     */
    const coversOf = (m: Map<string, { covers: number }>) => {
      if (m.size === 0) return null;
      let n = 0;
      for (const c of m.values()) n += c.covers;
      return n;
    };
    const covers = coversOf(coversCurrent[i]);
    const priorCovers = coversOf(coversPrior[i]);

    const sph = covers && covers > 0 ? round2(cur.food_bev_sales / covers) : null;
    const priorSph = priorCovers && priorCovers > 0 ? round2(pri.food_bev_sales / priorCovers) : null;

    const daily = mine.map(r => ({
      date: r.business_date,
      // A closed day is a GAP, never a zero. Plotted as zero it reads as a
      // collapse; the chart layer already works this way and the dashboard
      // must not disagree with it.
      net_sales: closed(r) ? null : round2(salesFiguresOf(r as any).net_sales),
      covers: coversCurrent[i].get(r.business_date)?.covers ?? null,
    }));

    /**
     * The next seven days, EVERY one of them, not only the ones with a booking.
     *
     * Building this from the covers map alone would silently drop any day with
     * no reservations -- so a quiet Tuesday would vanish from the row rather
     * than show a zero, and the week would look shorter than it is. The dates
     * are generated and the bookings looked up, never the other way round.
     */
    const shut = new Set(closedWeekdays[i]);
    const upcoming = Array.from({ length: 7 }, (_, d) => {
      const date = addDays(window.today, d);
      return {
        date,
        covers: coversUpcoming[i].get(date)?.covers ?? 0,
        closed: shut.has(weekdayOf(date)),
      };
    });

    return {
      venue_id: v.id,
      venue: v.name,
      slug: v.slug,
      gross_sales: round2(cur.gross_sales),
      food_bev_sales: round2(cur.food_bev_sales),
      food_sales: round2(cur.food_sales),
      beverage_sales: round2(cur.beverage_sales),
      food_pct: cur.food_bev_sales > 0 ? round2(cur.food_sales / cur.food_bev_sales * 100) : null,
      net_sales: round2(cur.net_sales),
      service_charge: round2(cur.service_charge),
      total_discounts: round2(cur.total_discounts),
      discount_rate_pct: cur.gross_sales > 0 ? round2(cur.total_discounts / cur.gross_sales * 100) : null,
      covers,
      transactions: cur.transactions,
      avg_spend_per_head: sph,
      avg_check: cur.transactions > 0 ? round2(cur.net_sales / cur.transactions) : null,
      trading_days: cur.trading_days,
      closed_days: cur.closed_days,
      prior: { net_sales: round2(pri.net_sales), covers: priorCovers, avg_spend_per_head: priorSph },
      change: {
        net_sales: movement(round2(cur.net_sales), pri.trading_days > 0 ? round2(pri.net_sales) : null),
        covers: movement(covers, priorCovers),
        avg_spend_per_head: movement(sph, priorSph),
      },
      daily,
      upcoming,
    };
  });

  // Independent of each other and of everything above; neither blocks the page.
  const [retention, costs, periodCosts] = await Promise.all([
    buildRetention(venues, window.today),
    buildCosts(venues, window.today),
    buildPeriodCosts(venues, window.current.start, window.current.end, window.today),
  ]);
  return { window, retention, costs, period_costs: periodCosts, venues: out, group: out.length > 1 ? rollUp(out) : null };
}



/**
 * Retention for the last COMPLETE month, keyed by venue slug plus "group".
 *
 * A FAILURE HERE COSTS THE PANEL, NEVER THE PAGE. The function is a database
 * RPC that has timed out in production before (22 Sep 2026), and a dashboard
 * that will not load because one panel could not be computed is a worse outcome
 * than a dashboard without that panel. Same rule as the terms gate and
 * warnSchema: a degraded page beats a dead one.
 */
async function buildRetention(
  venues: Array<{ id: string; name: string; slug: string }>,
  today: string,
): Promise<Record<string, RetentionBlock> | null> {
  const month = lastCompleteMonth(today);

  try {
    const [{ data, error }, { data: earliest }] = await Promise.all([
      supabaseAdmin.rpc('guest_retention', { p_start: month.start, p_end: month.end, p_lookback: 365 }),
      supabaseAdmin.from('reservations').select('business_date')
        .order('business_date', { ascending: true }).limit(1),
    ]);

    if (error) {
      // Named, not swallowed. An unapplied migration otherwise looks exactly
      // like a month in which nobody ever came back.
      console.warn(`[dashboard] retention unavailable: ${error.message}`);
      return null;
    }

    const rows = (data ?? []) as Array<RetentionCounts & { venue_id: string }>;
    if (rows.length === 0) return null;

    const dataStartsAt = earliest?.[0]?.business_date ?? null;
    const withheld = leftCensored(month.start, dataStartsAt);

    const out: Record<string, RetentionBlock> = {};
    const mine: RetentionCounts[] = [];

    for (const v of venues) {
      const r = rows.find(x => x.venue_id === v.id);
      const counts: RetentionCounts = r
        ? {
            booked_guests: Number(r.booked_guests), returning_here: Number(r.returning_here),
            crossed_from_sister: Number(r.crossed_from_sister), new_to_group: Number(r.new_to_group),
            walk_in_guests: Number(r.walk_in_guests),
          }
        : { booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0, walk_in_guests: 0 };
      mine.push(counts);
      const shares = retentionShares(counts);
      out[v.slug] = { month, counts, shares, plain: inPlainWords(counts, shares, month.label), withheld };
    }

    if (venues.length > 1) {
      /**
       * SUMMED, then the rate recomputed -- never an average of the venue
       * rates, which would weight a quiet venue the same as a busy one.
       *
       * Note this is not the same as the group retention the FUNCTION reports:
       * a guest who ate at two venues in the month is one guest at each and the
       * venue rows deliberately do not sum to a group row. This is the group's
       * venues added up, which is the right figure for "how did the group do"
       * and the wrong one for "how many distinct people", so the page says
       * "across the venues" rather than implying a headcount.
       */
      const counts = sumCounts(mine);
      const shares = retentionShares(counts);
      out.group = { month, counts, shares, plain: inPlainWords(counts, shares, month.label), withheld };
    }

    return out;
  } catch (e: any) {
    console.warn(`[dashboard] retention failed: ${e?.message ?? e}`);
    return null;
  }
}


/**
 * Food and beverage cost for the last complete month, keyed by venue slug.
 *
 * SAME MONTH AS RETENTION, deliberately. Two monthly panels under one period
 * heading means the reader changes context once; two panels on different months
 * beside a week-to-date table is three periods on one screen and nobody holds
 * that.
 *
 * SALES ARE SUMMED OVER THE LEDGER'S MONTH, not the dashboard's week. That is
 * the whole alignment risk and it is the same one query_food_beverage_cost
 * handles: cost for September over sales for a week in October is not a
 * percentage of anything.
 *
 * A failure costs the panel, never the page.
 */
async function buildCosts(
  venues: Array<{ id: string; name: string; slug: string }>,
  today: string,
): Promise<Record<string, CostBlock> | null> {
  const month = lastCompleteMonth(today);

  try {
    const out: Record<string, CostBlock> = {};
    let anyAvailable = false;

    const perVenue = await Promise.all(venues.map(async v => {
      const [{ data: pl }, { data: ops }, accountMap] = await Promise.all([
        supabaseAdmin.from('profit_and_loss')
          .select('section, account_name, amount, is_summary')
          .eq('venue_id', v.id)
          .gte('period_start', month.start)
          .lte('period_end', month.end),
        supabaseAdmin.from('daily_operations')
          .select('gross_sales, sales_by_class')
          .eq('venue_id', v.id)
          .gte('business_date', month.start)
          .lte('business_date', month.end),
        fetchAccountMap(v.id),
      ]);

      const rows: PLRow[] = (pl ?? []).map((r: any) => {
        const { canonical_account, business_line } = resolveAccount(r.account_name, accountMap);
        return { ...r, amount: Number(r.amount), canonical_account, business_line };
      });

      let food = 0, bev = 0;
      for (const o of ops ?? []) {
        const split = classSplitOf(o as any);
        food += split.food_sales;
        bev += split.beverage_sales;
      }

      return { slug: v.slug, rows, sales: { food_sales: food, beverage_sales: bev } };
    }));

    for (const v of perVenue) {
      const available = v.rows.length > 0;
      if (available) anyAvailable = true;
      const ratios = costRatios(v.rows, v.sales);
      out[v.slug] = { month, ratios, caveats: costCaveats(ratios, 1), available };
    }

    if (venues.length > 1) {
      /**
       * The group ratio is recomputed from the summed parts, never averaged
       * across venues -- a 40% venue and a 25% venue are not a group at 32.5%
       * unless they are the same size, and they never are.
       */
      const allRows = perVenue.flatMap(v => v.rows);
      const allSales = perVenue.reduce(
        (t, v) => ({ food_sales: t.food_sales + v.sales.food_sales, beverage_sales: t.beverage_sales + v.sales.beverage_sales }),
        { food_sales: 0, beverage_sales: 0 });
      const ratios = costRatios(allRows, allSales);
      out.group = { month, ratios, caveats: costCaveats(ratios, 1), available: allRows.length > 0 };
    }

    return anyAvailable ? out : null;
  } catch (e: any) {
    console.warn(`[dashboard] cost of sales failed: ${e?.message ?? e}`);
    return null;
  }
}


/**
 * Food and beverage cost for the SELECTED window, from supplier bills.
 *
 * WHY THIS EXISTS BESIDE THE LEDGER ONE. The P&L closes monthly, so a food cost
 * from it is six weeks behind by the time anybody could act on it. Bills carry
 * a date and arrive daily, so they give the same measurement at whatever grain
 * is on screen -- at the cost of being purchasing rather than consumption, and
 * of only covering what actually came through a bill.
 *
 * COVERAGE IS MEASURED ON THE LAST COMPLETE MONTH, never on the window being
 * reported. A part-month has bills not yet entered and a ledger not yet closed;
 * measuring coverage there compares two different kinds of incomplete.
 */
async function buildPeriodCosts(
  venues: Array<{ id: string; name: string; slug: string }>,
  start: string,
  end: string,
  today: string,
): Promise<Record<string, WeeklyCogs> | null> {
  const month = lastCompleteMonth(today);

  try {
    let any = false;
    const out: Record<string, WeeklyCogs> = {};

    await Promise.all(venues.map(async v => {
      const [{ data: pl }, { data: windowLines }, { data: monthLines }, { data: ops }, accountMap] = await Promise.all([
        // The P&L is read for TWO things: the account_id -> name map, and the
        // ledger totals coverage is measured against.
        supabaseAdmin.from('profit_and_loss')
          .select('account_id, account_name, section, amount, is_summary')
          .eq('venue_id', v.id)
          .gte('period_start', month.start)
          .lte('period_end', month.end),
        supabaseAdmin.from('supplier_bill_lines')
          .select('account_id, line_amount, supplier_bills!inner(bill_date)')
          .eq('venue_id', v.id)
          .gte('supplier_bills.bill_date', start)
          .lte('supplier_bills.bill_date', end),
        supabaseAdmin.from('supplier_bill_lines')
          .select('account_id, line_amount, supplier_bills!inner(bill_date)')
          .eq('venue_id', v.id)
          .gte('supplier_bills.bill_date', month.start)
          .lte('supplier_bills.bill_date', month.end),
        supabaseAdmin.from('daily_operations')
          .select('gross_sales, sales_by_class')
          .eq('venue_id', v.id)
          .gte('business_date', start)
          .lte('business_date', end),
        fetchAccountMap(v.id),
      ]);

      if (!windowLines || windowLines.length === 0) return;
      any = true;

      /**
       * account_id -> canonical name. The join that makes this possible at all:
       * profit_and_loss.account_id holds the same Xero UUID as a bill line, so a
       * bill reaches its P&L account without a chart-of-accounts lookup.
       */
      const names: AccountNames = new Map();
      const ledger = { food: 0, beverage: 0 };
      for (const r of pl ?? []) {
        if (!r.account_id) continue;
        const canonical = resolveAccount(r.account_name, accountMap).canonical_account;
        names.set(r.account_id, canonical);
        if (r.is_summary || !/cost of sales/i.test(r.section ?? '')) continue;
        const kind = classifyCogs(canonical);
        if (kind === 'food') ledger.food += Number(r.amount);
        else if (kind === 'beverage') ledger.beverage += Number(r.amount);
      }

      const toLines = (rows: any[]): BillLine[] =>
        rows.map(r => ({ account_id: r.account_id, line_amount: Number(r.line_amount), bill_date: '' }));

      let food = 0, bev = 0;
      for (const o of ops ?? []) {
        const split = classSplitOf(o as any);
        food += split.food_sales;
        bev += split.beverage_sales;
      }

      out[v.slug] = weeklyCogs(
        toLines(windowLines),
        names,
        { food_sales: food, beverage_sales: bev },
        coverageFor(toLines(monthLines ?? []), names, ledger),
      );
    }));

    return any ? out : null;
  } catch (e: any) {
    console.warn(`[dashboard] period costs failed: ${e?.message ?? e}`);
    return null;
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
