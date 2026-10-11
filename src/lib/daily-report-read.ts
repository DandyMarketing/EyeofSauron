/**
 * The database half of the morning report. The logic is in daily-report.ts,
 * split out so it can be tested without credentials -- the same split as
 * dashboard-window.ts and dashboard.ts.
 */

import { supabaseAdmin } from '../auth/session.js';
import { getCovers } from './covers.js';
import { sgtToday } from './dashboard-window.js';
import { getClosedWeekdays } from '../ingest/revel.js';
import { selectAll } from './paged.js';
import { addDays, composeVenueReport, type SalesDay, type VenueDailyReport } from './daily-report.js';

/**
 * Build the report for every venue in scope.
 *
 * VENUE SCOPE IS THE CALLER'S JOB, as for the dashboard: this runs with the
 * service role, and an empty list is refused rather than read as "everything".
 */
export async function buildDailyReport(
  venues: Array<{ id: string; name: string; slug: string }>,
  today: string = sgtToday(),
): Promise<VenueDailyReport[]> {
  if (venues.length === 0) throw new Error('daily report: no venues in scope -- refusing rather than reading every venue');

  // The earliest date any comparison can reach is the month start less five
  // weeks (35 days); 40 leaves margin.
  const from = addDays(today.slice(0, 8) + '01', -40);
  const to = today;

  return Promise.all(venues.map(async v => {
    const [sales, covers, closedWeekdays] = await Promise.all([
      selectAll(() => supabaseAdmin
        .from('daily_operations')
        .select('business_date, gross_sales, net_sales, item_discounts, order_discounts, total_transactions')
        .eq('venue_id', v.id)
        .gte('business_date', from)
        .lte('business_date', to)),
      getCovers(v.id, from, to),
      getClosedWeekdays(v.id),
    ]);
    // A failed read must not become a quiet day in a message nobody can query.
    if (sales.error) throw new Error(`daily report: ${v.name}: ${sales.error.message}`);
    const rows = sales.data as SalesDay[];

    // The latest day with a ROW before today. Rows only exist for days Revel
    // (or the board) delivered, so this is "how far the data runs".
    let last: string | null = null;
    for (const r of rows) if (r.business_date < today && (!last || r.business_date > last)) last = r.business_date;

    return composeVenueReport({ venue: v, today, closedWeekdays, rows, covers, lastDataDate: last });
  }));
}
