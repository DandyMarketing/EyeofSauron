import { supabase } from '../lib/supabase.js';
import { getCovers, coversVariance, normaliseShift } from '../lib/covers.js';
import { buildChart } from './charts.js';
import { renderChartSvg } from './chart-svg.js';

async function getVenueId(slug: string): Promise<string> {
  const { data, error } = await supabase
    .from('venues')
    .select('id')
    .eq('slug', slug)
    .single();
  if (error || !data) throw new Error(`Unknown venue: "${slug}"`);
  return data.id;
}

function getDateFilter(input: Record<string, any>): { single: string } | { start: string; end: string } {
  if (input.business_date) return { single: input.business_date };
  if (input.start_date && input.end_date) return { start: input.start_date, end: input.end_date };
  throw new Error('Provide either business_date or start_date+end_date');
}

function applyDateFilter(query: any, dateFilter: ReturnType<typeof getDateFilter>) {
  if ('single' in dateFilter) {
    return query.eq('business_date', dateFilter.single);
  }
  return query.gte('business_date', dateFilter.start).lte('business_date', dateFilter.end);
}

function dateLabel(dateFilter: ReturnType<typeof getDateFilter>): string {
  if ('single' in dateFilter) return dateFilter.single;
  return `${dateFilter.start} to ${dateFilter.end}`;
}

export async function handleToolCall(
  name: string,
  input: Record<string, any>,
): Promise<string> {
  switch (name) {
    case 'query_product_mix':
      return queryProductMix(input);
    case 'query_daily_operations':
      return queryDailyOperations(input);
    case 'compare_venues':
      return compareVenues(input);
    case 'query_meal_period_sales':
      return queryMealPeriodSales(input);
    case 'query_reservations':
      return queryReservations(input);
    case 'query_hourly_sales':
      return queryHourlySales(input);
    case 'list_available_data':
      return listAvailableData(input);
    case 'create_chart':
      return createChart(input);
    case 'web_search':
      return webSearch(input);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/**
 * Build a chart from warehouse data.
 *
 * The model passes parameters only; every plotted number is re-queried here.
 * The SVG is returned alongside a compact summary so the model can interpret
 * the shape of the data without the full point list bloating its context.
 */
async function createChart(input: Record<string, any>): Promise<string> {
  const spec = await buildChart({
    metric: input.metric,
    start_date: input.start_date,
    end_date: input.end_date,
    venue_slugs: input.venue_slugs,
    granularity: input.granularity,
    chart_type: input.chart_type,
    title: input.title,
  });

  if ('error' in spec) return JSON.stringify({ error: spec.error });

  const svg = renderChartSvg(spec);

  // Give the model first/last/min/max per series rather than every point, so it
  // can describe the trend accurately without re-listing the data.
  const firstLabel = spec.series[0]?.points[0]?.label;
  const lastLabel = spec.series[0]?.points[spec.series[0].points.length - 1]?.label;

  const summary = spec.series.map(s => {
    const vals = s.points.filter(p => p.value !== null) as Array<{ label: string; value: number }>;
    if (vals.length === 0) return { venue: s.name, note: 'no data in range' };

    // Trend maths ignores partial buckets. A range ending today leaves a stub
    // period, and measuring two days of a month against full months reads as a
    // collapse that never happened.
    const complete = vals.filter(v =>
      !(spec.partial_first && v.label === firstLabel) &&
      !(spec.partial_last && v.label === lastLabel));
    const basis = complete.length >= 2 ? complete : vals;

    const first = basis[0], last = basis[basis.length - 1];
    const peak = basis.reduce((a, b) => (b.value > a.value ? b : a));
    const low = basis.reduce((a, b) => (b.value < a.value ? b : a));
    const partialTail = spec.partial_last && vals[vals.length - 1].label === lastLabel
      ? { period: lastLabel, value: vals[vals.length - 1].value, note: 'PARTIAL period — not comparable to full ones' }
      : undefined;

    return {
      venue: s.name,
      first: { period: first.label, value: first.value },
      last: { period: last.label, value: last.value },
      peak: { period: peak.label, value: peak.value },
      lowest: { period: low.label, value: low.value },
      change_pct: first.value !== 0 ? Number((((last.value - first.value) / first.value) * 100).toFixed(1)) : null,
      partial_final_period: partialTail,
    };
  });

  return JSON.stringify({
    chart_created: true,
    title: spec.title,
    metric: spec.metric,
    granularity: spec.granularity,
    source: spec.source,
    periods: spec.series[0]?.points.length ?? 0,
    summary,
    note: 'The chart is already displayed to the user. Interpret what it shows — do not list every value.',
    partial_periods_note: (spec.partial_first || spec.partial_last)
      ? 'The first and/or last bucket covers only part of its period. change_pct already excludes them. Do NOT describe the final stub period as a decline — say the period is still in progress if you mention it at all.'
      : undefined,
    __chart_svg: svg,
  });
}

/**
 * Booking-level detail from SevenRooms. This is the only tool that can answer
 * walk-in, no-show, cancellation, booking-channel and table-turn questions --
 * Revel has none of that.
 */
async function queryReservations(input: Record<string, any>): Promise<string> {
  const dateFilter = getDateFilter(input);
  const range = 'single' in dateFilter
    ? { from: dateFilter.single, to: dateFilter.single }
    : { from: dateFilter.start, to: dateFilter.end };

  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return JSON.stringify({ error: 'No venues found' });
  const venues = input.venue_slug
    ? allVenues.filter(v => v.slug === input.venue_slug)
    : allVenues;
  if (venues.length === 0) return JSON.stringify({ error: `Unknown venue: "${input.venue_slug}"` });

  const results = [];
  for (const venue of venues) {
    let rows: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data } = await supabase
        .from('reservations')
        .select('business_date, party_size, status_simple, shift_category, arrival_time, is_walk_in, is_vip, booked_by, duration_min, seated_at, left_at')
        .eq('venue_id', venue.id)
        .gte('business_date', range.from)
        .lte('business_date', range.to)
        .order('business_date', { ascending: true })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }

    if (rows.length === 0) {
      // No reservations is ambiguous on its own: the venue may have been shut,
      // or the feed may have failed. Revel settles it. If the POS took money
      // and served guests, reservations are genuinely missing and someone
      // should look. If it took nothing, the venue was closed and there is
      // nothing to chase -- Super Firangi is shut every Sunday, so treating
      // those as failures would cry wolf weekly.
      const { data: posRows } = await supabase
        .from('daily_operations')
        .select('business_date, gross_sales, total_guests')
        .eq('venue_id', venue.id)
        .gte('business_date', range.from)
        .lte('business_date', range.to);

      const posGross = (posRows ?? []).reduce((a: number, o: any) => a + Number(o.gross_sales ?? 0), 0);
      const posGuests = (posRows ?? []).reduce((a: number, o: any) => a + Number(o.total_guests ?? 0), 0);

      // Revel lands nightly (~04:26 SGT), so a missing POS row means different
      // things depending on the date's age: recently, that it has not arrived
      // yet; a week back, that the venue never traded.
      const ageDays = Math.floor((Date.now() - new Date(`${range.to}T00:00:00Z`).getTime()) / 86_400_000);

      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

      let status: string;
      let message: string;
      if (range.from > todayStr) {
        // A future date with no bookings is an empty book, not a failure and
        // not a closure. Revel obviously has nothing for it either.
        status = 'no_bookings_yet';
        message = 'No reservations on the book for this future date yet. That is an empty book, not a data problem.';
      } else if (!posRows || posRows.length === 0) {
        if (ageDays <= 1) {
          status = 'awaiting_revel';
          message = 'No SevenRooms reservations, and Revel has not landed for this date yet — it arrives nightly around 4:26am SGT. Check again tomorrow before treating this as a gap.';
        } else {
          status = 'venue_closed';
          message = 'Venue was closed — no reservations, and Revel recorded no trading day at all. Not a data gap.';
        }
      } else if (posGross <= 0) {
        status = 'venue_closed';
        message = 'Venue was closed — no reservations and no POS sales. Not a data gap.';
      } else if (posGuests <= 0) {
        status = 'minimal_pos_activity';
        message = `No reservations, and the POS recorded $${posGross.toLocaleString()} but zero guests — too small to be a service. Likely a test transaction or a private/staff sale rather than a missing feed.`;
      } else {
        status = 'data_gap';
        message = `Reservations are MISSING: the POS recorded $${posGross.toLocaleString()} across ${posGuests} guests but SevenRooms has no bookings. This is a genuine ingestion gap worth escalating.`;
      }

      results.push({
        venue: venue.name,
        slug: venue.slug,
        status,
        message,
        pos_gross_sales: posGross || null,
        pos_guests: posGuests || null,
      });
      continue;
    }

    const covers = (f: (r: any) => boolean) =>
      rows.filter(f).reduce((a, r) => a + Number(r.party_size ?? 0), 0);

    const complete = rows.filter(r => r.status_simple === 'Complete');
    const byShift: Record<string, number> = {};
    for (const r of complete) {
      const s = normaliseShift(r.shift_category, r.arrival_time);
      byShift[s] = (byShift[s] ?? 0) + Number(r.party_size ?? 0);
    }

    const byChannel: Record<string, { bookings: number; covers: number }> = {};
    for (const r of rows) {
      const k = r.booked_by || 'Unknown';
      byChannel[k] = byChannel[k] ?? { bookings: 0, covers: 0 };
      byChannel[k].bookings++;
      byChannel[k].covers += Number(r.party_size ?? 0);
    }

    const bookedCovers = covers(() => true);
    const noShow = rows.filter(r => r.status_simple === 'No Show');
    const cancelled = rows.filter(r => r.status_simple === 'Canceled');

    // Table turn from actual seated/left stamps, not the booked duration.
    const turns = complete
      .filter(r => r.seated_at && r.left_at)
      .map(r => (new Date(r.left_at).getTime() - new Date(r.seated_at).getTime()) / 60000)
      .filter(m => m > 0 && m < 480);

    const completedCovers = covers(r => r.status_simple === 'Complete');

    // Upcoming bookings are 'Incomplete' in SevenRooms, never 'Complete', so a
    // completion-based count reports zero for every future date. Report the
    // book instead: everything not cancelled and not a no-show.
    const expectedCovers = covers(r => r.status_simple !== 'Canceled' && r.status_simple !== 'No Show');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    // Today is neither past nor future: service is part-done. Reporting
    // completed covers for tonight answers "how many have finished eating",
    // when the operator asked "how many are we expecting". Treat today like an
    // upcoming date for the headline, and report arrivals separately.
    const isToday = range.from === today && range.to === today;
    const isUpcoming = range.from > today || isToday;
    const spansFuture = range.to > today;

    const expectedByShift: Record<string, number> = {};
    for (const r of rows) {
      if (r.status_simple === 'Canceled' || r.status_simple === 'No Show') continue;
      const sh = normaliseShift(r.shift_category, r.arrival_time);
      expectedByShift[sh] = (expectedByShift[sh] ?? 0) + Number(r.party_size ?? 0);
    }

    // Revel's paid-guest count over the same range, for the SOP variance check.
    const { data: ops } = await supabase
      .from('daily_operations')
      .select('total_guests')
      .eq('venue_id', venue.id)
      .gte('business_date', range.from)
      .lte('business_date', range.to);
    const revelGuests = (ops ?? []).reduce((a: number, o: any) => a + Number(o.total_guests ?? 0), 0);

    results.push({
      venue: venue.name,
      slug: venue.slug,
      period: isToday ? 'today_in_progress' : isUpcoming ? 'upcoming' : spansFuture ? 'includes_future_dates' : 'historical',
      bookings: rows.length,
      // For upcoming dates report the book; for past dates report what actually
      // happened. Both are always present so the model can be explicit.
      covers: isUpcoming ? expectedCovers : completedCovers,
      covers_meaning: isToday
        ? `EXPECTED covers for today — service is still in progress. ${completedCovers} of these have finished dining so far; the rest are still to come or currently seated.`
        : isUpcoming
          ? 'EXPECTED covers — guests booked in and not yet cancelled. These have not happened yet.'
          : 'COMPLETED covers — guests who actually dined.',
      expected_covers: expectedCovers,
      completed_covers: completedCovers,
      booked_covers: bookedCovers,
      covers_by_meal_period: isUpcoming ? expectedByShift : byShift,
      walk_in_covers: covers(r => r.is_walk_in && r.status_simple === 'Complete'),
      reservation_covers: covers(r => !r.is_walk_in && r.status_simple === 'Complete'),
      walk_in_pct: completedCovers > 0
        ? Number((covers(r => r.is_walk_in && r.status_simple === 'Complete') / completedCovers * 100).toFixed(1))
        : null,
      no_show_bookings: noShow.length,
      no_show_covers: covers(r => r.status_simple === 'No Show'),
      no_show_rate_pct: rows.length > 0 ? Number((noShow.length / rows.length * 100).toFixed(1)) : null,
      cancelled_bookings: cancelled.length,
      cancelled_covers: covers(r => r.status_simple === 'Canceled'),
      cancellation_rate_pct: rows.length > 0 ? Number((cancelled.length / rows.length * 100).toFixed(1)) : null,
      avg_party_size: rows.length > 0 ? Number((bookedCovers / rows.length).toFixed(1)) : null,
      vip_bookings: rows.filter(r => r.is_vip).length,
      avg_table_turn_min: turns.length > 0 ? Math.round(turns.reduce((a, b) => a + b, 0) / turns.length) : null,
      by_booking_channel: Object.fromEntries(
        Object.entries(byChannel).sort((a, b) => b[1].covers - a[1].covers)
      ),
      covers_check: isUpcoming ? undefined : coversVariance(completedCovers, revelGuests || null),
    });
  }

  return JSON.stringify({
    date: dateLabel(dateFilter),
    source: 'sevenrooms',
    note: 'Covers are the booked party size. Revenue questions must use query_daily_operations (Revel).',
    venues: results,
  });
}

async function queryProductMix(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const dateFilter = getDateFilter(input);
  const rowType = input.row_type ?? 'Product';
  const cls = input.class ?? 'all';
  const limit = input.limit ?? 20;

  let query = supabase
    .from('product_mix')
    .select('name, row_type, class, category, subcategory, qty, sales, pct_total, parent_product, business_date')
    .eq('venue_id', venueId)
    .limit(10000);

  query = applyDateFilter(query, dateFilter);
  if (rowType !== 'all') query = query.eq('row_type', rowType);
  if (cls !== 'all') query = query.eq('class', cls);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date: dateLabel(dateFilter), message: 'No product mix data found.' });

  // For date ranges, aggregate by product name
  if ('start' in dateFilter) {
    const agg = new Map<string, { name: string; class: string; category: string; subcategory: string; row_type: string; qty: number; sales: number; days: number }>();
    for (const row of data) {
      const key = `${row.name}|${row.row_type}|${row.class}`;
      const existing = agg.get(key);
      if (existing) {
        existing.qty += Number(row.qty);
        existing.sales += Number(row.sales);
        existing.days += 1;
      } else {
        agg.set(key, {
          name: row.name,
          class: row.class,
          category: row.category,
          subcategory: row.subcategory,
          row_type: row.row_type,
          qty: Number(row.qty),
          sales: Number(row.sales),
          days: 1,
        });
      }
    }

    let rows = [...agg.values()];
    const orderCol = input.order_by?.startsWith('qty') ? 'qty' : 'sales';
    const ascending = input.order_by?.endsWith('asc');
    rows.sort((a, b) => ascending ? a[orderCol] - b[orderCol] : b[orderCol] - a[orderCol]);
    rows = rows.slice(0, limit);

    const totalSales = rows.reduce((s, r) => s + r.sales, 0);
    return JSON.stringify({
      venue: input.venue_slug,
      date_range: dateLabel(dateFilter),
      unique_products: rows.length,
      query_total_sales: totalSales,
      rows,
    });
  }

  // Single date — existing behavior
  const orderCol = input.order_by?.startsWith('qty') ? 'qty' : input.order_by === 'name' ? 'name' : 'sales';
  const ascending = input.order_by?.endsWith('asc') || input.order_by === 'name';
  const sorted = [...data].sort((a, b) => {
    const av = orderCol === 'name' ? a.name : Number(a[orderCol]);
    const bv = orderCol === 'name' ? b.name : Number(b[orderCol]);
    if (typeof av === 'string' && typeof bv === 'string') return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    return ascending ? (av as number) - (bv as number) : (bv as number) - (av as number);
  }).slice(0, limit);

  const totalSales = sorted.reduce((s, r) => s + Number(r.sales), 0);
  return JSON.stringify({
    venue: input.venue_slug,
    date: dateLabel(dateFilter),
    row_count: sorted.length,
    query_total_sales: totalSales,
    rows: sorted,
  });
}

async function queryDailyOperations(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const dateFilter = getDateFilter(input);

  let query = supabase
    .from('daily_operations')
    .select('*')
    .eq('venue_id', venueId);

  query = applyDateFilter(query, dateFilter);

  if ('single' in dateFilter) {
    const { data, error } = await query.maybeSingle();
    if (error) return JSON.stringify({ error: error.message });
    if (!data) return JSON.stringify({ venue: input.venue_slug, date: dateLabel(dateFilter), message: 'No operations data found for this venue and date.' });

    // Covers come from SevenRooms, revenue from Revel. See src/lib/covers.ts.
    const coversMap = await getCovers(venueId, dateFilter.single, dateFilter.single);
    const c = coversMap.get(dateFilter.single);
    const gross = Number(data.gross_sales ?? 0);

    return JSON.stringify({
      venue: input.venue_slug,
      date: dateLabel(dateFilter),
      ...data,
      covers_source: 'sevenrooms',
      covers: c?.covers ?? null,
      covers_by_meal_period: c?.by_shift ?? null,
      booked_covers: c?.booked_covers ?? null,
      walk_in_covers: c?.walk_in_covers ?? null,
      cancelled_covers: c?.cancelled_covers ?? null,
      no_show_covers: c?.no_show_covers ?? null,
      avg_spend_per_head: c?.covers ? Number((gross / c.covers).toFixed(2)) : null,
      covers_check: coversVariance(c?.covers ?? null, data.total_guests),
    });
  }

  // Date range — return daily breakdown + totals
  const { data, error } = await query.order('business_date', { ascending: true });
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date_range: dateLabel(dateFilter), message: 'No operations data found for this venue and date range.' });

  // Covers come from SevenRooms, revenue from Revel. See src/lib/covers.ts.
  const coversMap = await getCovers(venueId, dateFilter.start, dateFilter.end);

  const totals = {
    days: data.length,
    gross_sales: 0,
    net_sales: 0,
    item_discounts: 0,
    order_discounts: 0,
    tax_total: 0,
    tips_total: 0,
    net_to_account_for: 0,
    total_transactions: 0,
    total_guests: 0,
    covers: 0,
  };
  const coversByShift: Record<string, number> = {};
  const sopBreaches: Array<{ date: string; sevenrooms_covers: number | null; revel_guests: number | null; variance: number | null }> = [];

  const daily = data.map(d => {
    totals.gross_sales += Number(d.gross_sales);
    totals.net_sales += Number(d.net_sales);
    totals.item_discounts += Number(d.item_discounts);
    totals.order_discounts += Number(d.order_discounts);
    totals.tax_total += Number(d.tax_total ?? 0);
    totals.tips_total += Number(d.tips_total);
    totals.net_to_account_for += Number(d.net_to_account_for ?? 0);
    totals.total_transactions += Number(d.total_transactions ?? 0);
    totals.total_guests += Number(d.total_guests ?? 0);

    const dayGross = Number(d.gross_sales ?? 0);
    const c = coversMap.get(d.business_date);
    const dayCovers = c?.covers ?? null;

    if (dayCovers !== null) {
      totals.covers += dayCovers;
      for (const [shift, n] of Object.entries(c!.by_shift)) {
        coversByShift[shift] = (coversByShift[shift] ?? 0) + n;
      }
    }

    const check = coversVariance(dayCovers, d.total_guests);
    if (check.status === 'review') {
      sopBreaches.push({
        date: d.business_date,
        sevenrooms_covers: check.sevenrooms_covers,
        revel_guests: check.revel_guests,
        variance: check.variance,
      });
    }

    return {
      date: d.business_date,
      gross_sales: d.gross_sales,
      net_sales: d.net_sales,
      total_discounts: Number(d.item_discounts) + Number(d.order_discounts),
      covers: dayCovers,
      covers_by_meal_period: c?.by_shift ?? null,
      walk_in_covers: c?.walk_in_covers ?? null,
      no_show_covers: c?.no_show_covers ?? null,
      avg_check: d.avg_check,
      avg_spend_per_head: dayCovers ? Number((dayGross / dayCovers).toFixed(2)) : null,
      transactions: d.total_transactions,
    };
  });

  const avgCheck = totals.total_transactions > 0
    ? Number((totals.net_to_account_for / totals.total_transactions).toFixed(2))
    : 0;
  const avgSpendPerHead = totals.covers > 0
    ? Number((totals.gross_sales / totals.covers).toFixed(2))
    : null;
  const avgDailyGross = Number((totals.gross_sales / totals.days).toFixed(2));

  return JSON.stringify({
    venue: input.venue_slug,
    date_range: dateLabel(dateFilter),
    covers_source: 'sevenrooms',
    revenue_source: 'revel',
    totals: {
      ...totals,
      covers_by_meal_period: coversByShift,
      avg_check_overall: avgCheck,
      avg_spend_per_head: avgSpendPerHead,
      avg_daily_gross: avgDailyGross,
    },
    // Days where SevenRooms covers and Revel's paid-guest count disagree by
    // more than 2. Covers are the SevenRooms number by design; a gap here
    // means the floor SOP was not followed, not that the figure is wrong.
    covers_sop_review: sopBreaches.length > 0 ? sopBreaches : undefined,
    daily,
  });
}

async function compareVenues(input: Record<string, any>): Promise<string> {
  const dateFilter = getDateFilter(input);
  let venueFilter: string[] | undefined = input.venue_slugs;

  const { data: venues } = await supabase.from('venues').select('id, name, slug');
  if (!venues) return JSON.stringify({ error: 'No venues found' });

  const targetVenues = venueFilter
    ? venues.filter(v => venueFilter!.includes(v.slug))
    : venues;

  const results = [];
  for (const venue of targetVenues) {
    let query = supabase
      .from('daily_operations')
      .select('gross_sales, net_sales, item_discounts, order_discounts, tax_total, tips_total, net_to_account_for, total_transactions, total_guests, avg_check, avg_sale_per_guest, sales_by_class')
      .eq('venue_id', venue.id);

    query = applyDateFilter(query, dateFilter);
    query = query.limit(1000);
    const { data: rows } = await query;
    if (!rows || rows.length === 0) continue;

    let grossSales = 0, netSales = 0, itemDisc = 0, orderDisc = 0, taxTotal = 0, tips = 0, netToAccount = 0, transactions = 0, guests = 0;
    let foodSales = 0, bevSales = 0;

    for (const ops of rows) {
      grossSales += Number(ops.gross_sales);
      netSales += Number(ops.net_sales);
      itemDisc += Number(ops.item_discounts);
      orderDisc += Number(ops.order_discounts);
      taxTotal += Number(ops.tax_total ?? 0);
      tips += Number(ops.tips_total);
      netToAccount += Number(ops.net_to_account_for ?? 0);
      transactions += Number(ops.total_transactions ?? 0);
      guests += Number(ops.total_guests ?? 0);

      const salesByClass = (ops.sales_by_class as any[]) ?? [];
      foodSales += salesByClass.find(c => c.class === 'Food')?.grossSales ?? 0;
      bevSales += salesByClass.find(c => c.class === 'Beverage')?.grossSales ?? 0;
    }

    const totalDisc = itemDisc + orderDisc;
    const discRate = grossSales > 0 ? (totalDisc / grossSales * 100) : 0;
    const avgCheck = transactions > 0 ? Number((netToAccount / transactions).toFixed(2)) : 0;

    // Covers from SevenRooms, revenue from Revel. See src/lib/covers.ts.
    const range = 'single' in dateFilter
      ? { from: dateFilter.single, to: dateFilter.single }
      : { from: dateFilter.start, to: dateFilter.end };
    const coversMap = await getCovers(venue.id, range.from, range.to);

    let covers = 0;
    const coversByShift: Record<string, number> = {};
    for (const c of coversMap.values()) {
      covers += c.covers;
      for (const [shift, n] of Object.entries(c.by_shift)) {
        coversByShift[shift] = (coversByShift[shift] ?? 0) + n;
      }
    }

    const avgSpendPerHead = covers > 0 ? Number((grossSales / covers).toFixed(2)) : null;

    results.push({
      venue: venue.name,
      slug: venue.slug,
      days: rows.length,
      gross_sales: grossSales,
      net_sales: netSales,
      total_discounts: totalDisc,
      discount_rate_pct: Number(discRate.toFixed(1)),
      food_sales: foodSales,
      beverage_sales: bevSales,
      food_pct: grossSales > 0 ? Number((foodSales / grossSales * 100).toFixed(1)) : 0,
      tax_total: taxTotal,
      tips,
      net_to_account_for: netToAccount,
      covers,
      covers_by_meal_period: coversByShift,
      revel_guests: guests,
      covers_check: coversVariance(covers, guests),
      avg_check: avgCheck,
      avg_spend_per_head: avgSpendPerHead,
      transactions,
    });
  }

  return JSON.stringify({
    date: dateLabel(dateFilter),
    covers_source: 'sevenrooms',
    revenue_source: 'revel',
    venues: results,
  });
}

async function listAvailableData(input: Record<string, any>): Promise<string> {
  const { data: venues } = await supabase.from('venues').select('id, name, slug');
  if (!venues) return JSON.stringify({ error: 'No venues found' });

  const venueFilter = input.venue_slug
    ? venues.filter(v => v.slug === input.venue_slug)
    : venues;

  const results = [];
  for (const venue of venueFilter) {
    const { data: ops } = await supabase
      .from('daily_operations')
      .select('business_date')
      .eq('venue_id', venue.id)
      .order('business_date', { ascending: false })
      .limit(30);

    const { data: pmDates } = await supabase
      .from('product_mix')
      .select('business_date')
      .eq('venue_id', venue.id)
      .order('business_date', { ascending: false })
      .limit(5000);

    const uniquePmDates = [...new Set((pmDates ?? []).map(r => r.business_date))];

    const { data: hsDates } = await supabase
      .from('hourly_sales')
      .select('business_date')
      .eq('venue_id', venue.id)
      .order('business_date', { ascending: false })
      .limit(1000);

    const uniqueHsDates = [...new Set((hsDates ?? []).map(r => r.business_date))];

    results.push({
      venue: venue.name,
      slug: venue.slug,
      operations_dates: (ops ?? []).map(r => r.business_date),
      product_mix_dates: uniquePmDates,
      hourly_sales_dates: uniqueHsDates,
    });
  }

  return JSON.stringify({ venues: results });
}

async function queryMealPeriodSales(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const dateFilter = getDateFilter(input);

  let query = supabase
    .from('hourly_sales')
    .select('business_date, meal_period, transactions, items, sales')
    .eq('venue_id', venueId)
    .limit(5000);

  query = applyDateFilter(query, dateFilter);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date: dateLabel(dateFilter), message: 'No hourly sales data found. This data comes from the Hourly Sales Report.' });

  const periods = new Map<string, { period: string; transactions: number; items: number; sales: number; days: Set<string> }>();

  for (const row of data) {
    const key = row.meal_period;
    const existing = periods.get(key);
    if (existing) {
      existing.transactions += Number(row.transactions);
      existing.items += Number(row.items);
      existing.sales += Number(row.sales);
      existing.days.add(row.business_date);
    } else {
      periods.set(key, {
        period: row.meal_period,
        transactions: Number(row.transactions),
        items: Number(row.items),
        sales: Number(row.sales),
        days: new Set([row.business_date]),
      });
    }
  }

  const totalSales = [...periods.values()].reduce((s, p) => s + p.sales, 0);

  const result = [...periods.values()].map(p => ({
    period: p.period,
    transactions: p.transactions,
    items: p.items,
    sales: p.sales,
    pct_of_total: totalSales > 0 ? Number((p.sales / totalSales * 100).toFixed(1)) : 0,
    avg_check: p.transactions > 0 ? Number((p.sales / p.transactions).toFixed(2)) : null,
    days_counted: p.days.size,
  }));

  return JSON.stringify({
    venue: input.venue_slug,
    date: dateLabel(dateFilter),
    total_sales: totalSales,
    periods: result,
  });
}

async function queryHourlySales(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const businessDate = input.business_date;
  if (!businessDate) return JSON.stringify({ error: 'business_date is required for hourly sales query' });

  const { data, error } = await supabase
    .from('hourly_sales')
    .select('hour, time_label, transactions, items, avg_check, sales, pct_sales, meal_period')
    .eq('venue_id', venueId)
    .eq('business_date', businessDate)
    .order('hour', { ascending: true });

  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date: businessDate, message: 'No hourly sales data found for this date.' });

  const totalSales = data.reduce((s, r) => s + Number(r.sales), 0);
  const totalTx = data.reduce((s, r) => s + Number(r.transactions), 0);

  return JSON.stringify({
    venue: input.venue_slug,
    date: businessDate,
    total_sales: totalSales,
    total_transactions: totalTx,
    hours: data,
  });
}

async function webSearch(input: Record<string, any>): Promise<string> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return JSON.stringify({ error: 'Web search not configured. Ask admin to add BRAVE_SEARCH_API_KEY.' });
  }

  const query = input.query;
  if (!query) return JSON.stringify({ error: 'query is required' });

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return JSON.stringify({ error: `Search failed (${res.status})` });
  }

  const data: any = await res.json();
  const results = (data.web?.results ?? []).slice(0, 5).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));

  return JSON.stringify({ query, results });
}
