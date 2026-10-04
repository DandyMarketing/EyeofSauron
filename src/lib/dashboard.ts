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
import { dashboardWindow, movement, type DashboardWindow } from './dashboard-window.js';
import { rollUp, type VenueWeek } from './dashboard-rollup.js';
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

export interface DashboardPayload {
  window: DashboardWindow;
  venues: VenueWeek[];
  /** Present only when more than one venue is in scope. */
  group: VenueWeek | null;
}

export async function buildDashboard(
  venues: Array<{ id: string; name: string; slug: string }>,
  today?: string,
): Promise<DashboardPayload> {
  if (venues.length === 0) {
    throw new Error('dashboard: no venues in scope — refusing rather than reading every venue');
  }

  const window = dashboardWindow(today);
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

  return { window, venues: out, group: out.length > 1 ? rollUp(out) : null };
}


function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
