import { supabase } from '../lib/supabase.js';
import type { ProductMixRow, OperationsData, HourlySalesData, MealPeriodSummary } from '../parsers/revel/types.js';
import { deriveMealPeriods } from '../parsers/revel/meal-periods.js';

export async function resolveVenueId(reportKey: string): Promise<string> {
  const { data, error } = await supabase
    .from('revel_venue_keys')
    .select('venue_id')
    .eq('report_key', reportKey)
    .single();

  if (error || !data) {
    throw new Error(`Unknown venue key: "${reportKey}". Register it in revel_venue_keys first.`);
  }
  return data.venue_id;
}

export async function resolveVenueSlug(venueId: string): Promise<string> {
  const { data, error } = await supabase
    .from('venues')
    .select('slug')
    .eq('id', venueId)
    .single();

  if (error || !data) return 'unknown';
  return data.slug;
}

export async function ingestProductMix(
  venueId: string,
  businessDate: string,
  rows: ProductMixRow[],
): Promise<number> {
  // Delete existing rows for this venue+date, then insert fresh
  const { error: delError } = await supabase
    .from('product_mix')
    .delete()
    .eq('venue_id', venueId)
    .eq('business_date', businessDate);

  if (delError) throw new Error(`Delete failed: ${delError.message}`);

  const records = rows.map(r => ({
    venue_id: venueId,
    business_date: businessDate,
    row_type: r.rowType,
    class: r.class,
    name: r.name,
    sku: r.sku,
    barcode: r.barcode,
    category: r.category,
    subcategory: r.subcategory,
    parent_product: r.parentProduct,
    qty: r.qty,
    weight: r.weight,
    non_taxable_sales: r.nonTaxableSales,
    taxable_sales: r.taxableSales,
    sales: r.sales,
    pct_total: r.pctTotal,
    cogs: r.cogs,
  }));

  // Insert in chunks of 500 to avoid payload limits
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const { error } = await supabase.from('product_mix').insert(chunk);
    if (error) throw new Error(`Insert failed at chunk ${i}: ${error.message}`);
  }

  return records.length;
}

export async function ingestOperations(
  venueId: string,
  businessDate: string,
  ops: OperationsData,
): Promise<void> {
  const totalRow = ops.salesByClass.find(r => r.class.toLowerCase() === 'total');
  const classRows = ops.salesByClass.filter(r => r.class.toLowerCase() !== 'total');

  const record = {
    venue_id: venueId,
    business_date: businessDate,
    raw_qty: totalRow?.rawQty ?? null,
    raw_sales: totalRow?.rawSales ?? null,
    voids_qty: totalRow?.voidsQty ?? null,
    voids_amount: totalRow?.voidsAmount ?? null,
    comps_qty: totalRow?.compsQty ?? null,
    comps_amount: totalRow?.compsAmount ?? null,
    gross_sales: totalRow?.grossSales ?? ops.grossProductSales.taxedGrossSales + ops.grossProductSales.untaxedGrossSales,
    item_discounts: ops.discounts.itemDiscounts,
    order_discounts: ops.discounts.orderDiscounts,
    net_sales: ops.netSales.totalSales,
    taxed_gross_sales: ops.grossProductSales.taxedGrossSales,
    untaxed_gross_sales: ops.grossProductSales.untaxedGrossSales,
    taxed_service_fee: ops.grossProductSales.taxedServiceFee,
    untaxed_service_fee: ops.grossProductSales.untaxedServiceFee,
    tax_on_sales: ops.taxes.taxOnSales,
    tax_on_service_fee: ops.taxes.taxOnServiceFee,
    tax_total: ops.taxes.taxTotal,
    tips_total: ops.tipsTotal,
    net_to_account_for: ops.netToAccountFor,
    total_transactions: ops.servicePerformance.totalTransactions,
    avg_check: ops.servicePerformance.avgCheck,
    total_guests: ops.servicePerformance.totalGuests,
    avg_sale_per_guest: ops.servicePerformance.avgSalePerGuest,
    sales_by_class: classRows,
    payments: ops.payments,
    discount_reasons: ops.discountReasons,
    void_comp_reasons: ops.voidCompReasons,
  };

  // Upsert by (venue_id, business_date)
  const { error } = await supabase
    .from('daily_operations')
    .upsert(record, { onConflict: 'venue_id,business_date' });

  if (error) throw new Error(`Operations upsert failed: ${error.message}`);
}

export async function ingestHourlySales(
  venueId: string,
  venueSlug: string,
  businessDate: string,
  data: HourlySalesData,
): Promise<number> {
  const periods = deriveMealPeriods(data, { venueSlug, businessDate });
  const periodByHour = new Map<number, string>();
  for (const h of data.hours) {
    if (h.hour < 17) {
      const lunchPeriod = periods.find(p => p.period === 'lunch' || p.period === 'brunch');
      periodByHour.set(h.hour, lunchPeriod?.period ?? 'lunch');
    } else {
      periodByHour.set(h.hour, 'dinner');
    }
  }

  const { error: delError } = await supabase
    .from('hourly_sales')
    .delete()
    .eq('venue_id', venueId)
    .eq('business_date', businessDate);

  if (delError) throw new Error(`Hourly sales delete failed: ${delError.message}`);

  const records = data.hours
    .filter(h => h.transactions > 0 || h.sales > 0)
    .map(h => ({
      venue_id: venueId,
      business_date: businessDate,
      hour: h.hour,
      time_label: h.timeLabel,
      transactions: h.transactions,
      items: h.items,
      avg_check: h.avgCheck,
      sales: h.sales,
      pct_sales: h.pctSales,
      meal_period: periodByHour.get(h.hour) ?? 'dinner',
    }));

  if (records.length > 0) {
    const { error } = await supabase.from('hourly_sales').insert(records);
    if (error) throw new Error(`Hourly sales insert failed: ${error.message}`);
  }

  return records.length;
}
