import { supabase } from '../lib/supabase.js';

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
    case 'query_hourly_sales':
      return queryHourlySales(input);
    case 'list_available_data':
      return listAvailableData(input);
    case 'web_search':
      return webSearch(input);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
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
    return JSON.stringify({ venue: input.venue_slug, date: dateLabel(dateFilter), ...data });
  }

  // Date range — return daily breakdown + totals
  const { data, error } = await query.order('business_date', { ascending: true });
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date_range: dateLabel(dateFilter), message: 'No operations data found for this venue and date range.' });

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
  };

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

    return {
      date: d.business_date,
      gross_sales: d.gross_sales,
      net_sales: d.net_sales,
      total_discounts: Number(d.item_discounts) + Number(d.order_discounts),
      guests: d.total_guests,
      avg_check: d.avg_check,
      transactions: d.total_transactions,
    };
  });

  const avgCheck = totals.total_transactions > 0
    ? Number((totals.net_to_account_for / totals.total_transactions).toFixed(2))
    : 0;
  const avgDailyGross = Number((totals.gross_sales / totals.days).toFixed(2));

  return JSON.stringify({
    venue: input.venue_slug,
    date_range: dateLabel(dateFilter),
    totals: { ...totals, avg_check_overall: avgCheck, avg_daily_gross: avgDailyGross },
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
      guests,
      avg_check: avgCheck,
      transactions,
    });
  }

  return JSON.stringify({ date: dateLabel(dateFilter), venues: results });
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
