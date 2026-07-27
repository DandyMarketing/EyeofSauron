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
    case 'list_available_data':
      return listAvailableData(input);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function queryProductMix(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const rowType = input.row_type ?? 'Product';
  const cls = input.class ?? 'all';
  const limit = input.limit ?? 20;

  let query = supabase
    .from('product_mix')
    .select('name, row_type, class, category, subcategory, qty, sales, pct_total, parent_product')
    .eq('venue_id', venueId)
    .eq('business_date', input.business_date);

  if (rowType !== 'all') query = query.eq('row_type', rowType);
  if (cls !== 'all') query = query.eq('class', cls);

  const orderCol = input.order_by?.startsWith('qty') ? 'qty' : input.order_by === 'name' ? 'name' : 'sales';
  const ascending = input.order_by?.endsWith('asc') || input.order_by === 'name';
  query = query.order(orderCol, { ascending }).limit(limit);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });

  const totalSales = (data ?? []).reduce((s, r) => s + Number(r.sales), 0);
  return JSON.stringify({
    venue: input.venue_slug,
    date: input.business_date,
    row_count: data?.length ?? 0,
    query_total_sales: totalSales,
    rows: data,
  });
}

async function queryDailyOperations(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);

  const { data, error } = await supabase
    .from('daily_operations')
    .select('*')
    .eq('venue_id', venueId)
    .eq('business_date', input.business_date)
    .maybeSingle();

  if (error) return JSON.stringify({ error: error.message });
  if (!data) return JSON.stringify({ venue: input.venue_slug, date: input.business_date, message: 'No operations data found for this venue and date.' });
  return JSON.stringify({ venue: input.venue_slug, date: input.business_date, ...data });
}

async function compareVenues(input: Record<string, any>): Promise<string> {
  let venueFilter: string[] | undefined = input.venue_slugs;

  // Get all venues if none specified
  const { data: venues } = await supabase.from('venues').select('id, name, slug');
  if (!venues) return JSON.stringify({ error: 'No venues found' });

  const targetVenues = venueFilter
    ? venues.filter(v => venueFilter!.includes(v.slug))
    : venues;

  const results = [];
  for (const venue of targetVenues) {
    const { data: ops } = await supabase
      .from('daily_operations')
      .select('gross_sales, net_sales, item_discounts, order_discounts, tax_total, tips_total, net_to_account_for, total_transactions, total_guests, avg_check, avg_sale_per_guest, sales_by_class')
      .eq('venue_id', venue.id)
      .eq('business_date', input.business_date)
      .single();

    if (!ops) continue;

    const salesByClass = (ops.sales_by_class as any[]) ?? [];
    const foodSales = salesByClass.find(c => c.class === 'Food')?.grossSales ?? 0;
    const bevSales = salesByClass.find(c => c.class === 'Beverage')?.grossSales ?? 0;
    const totalDisc = Number(ops.item_discounts) + Number(ops.order_discounts);
    const discRate = Number(ops.gross_sales) > 0 ? (totalDisc / Number(ops.gross_sales) * 100) : 0;

    results.push({
      venue: venue.name,
      slug: venue.slug,
      gross_sales: ops.gross_sales,
      net_sales: ops.net_sales,
      total_discounts: totalDisc,
      discount_rate_pct: Number(discRate.toFixed(1)),
      food_sales: foodSales,
      beverage_sales: bevSales,
      food_pct: Number(ops.gross_sales) > 0 ? Number((foodSales / Number(ops.gross_sales) * 100).toFixed(1)) : 0,
      tax_total: ops.tax_total,
      tips: ops.tips_total,
      net_to_account_for: ops.net_to_account_for,
      guests: ops.total_guests,
      avg_check: ops.avg_check,
      transactions: ops.total_transactions,
    });
  }

  return JSON.stringify({ date: input.business_date, venues: results });
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
      .limit(1);

    const uniquePmDates = [...new Set((pmDates ?? []).map(r => r.business_date))];

    results.push({
      venue: venue.name,
      slug: venue.slug,
      operations_dates: (ops ?? []).map(r => r.business_date),
      product_mix_dates: uniquePmDates,
    });
  }

  return JSON.stringify({ venues: results });
}
