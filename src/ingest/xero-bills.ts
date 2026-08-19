import { supabase } from '../lib/supabase.js';
import { getAccessToken } from './xero.js';
import { toBillRow, toBillLineRows, isSpend } from '../parsers/xero/bills.js';

/**
 * Supplier bills from Xero, with their lines.
 *
 * The P&L reports an account total; this is what makes it up. A bill carries a
 * supplier, a description and a line coded to an account -- and the line's
 * AccountID is the same UUID profit_and_loss stores, so the two join directly
 * without a chart-of-accounts lookup.
 *
 * PAGINATION IS NOT OPTIONAL. Xero returns 100 invoices per page and says
 * nothing when there are more. The probe on 19 Aug 2026 reported "100 bills"
 * for one month of one venue, which is exactly the page size -- so the true
 * count was unknown and the volume estimate was a floor. A single-page pull
 * would have stored a third of the data and reported success, which is the
 * failure this codebase has now hit in four different sources.
 */

const XERO_API = 'https://api.xero.com/api.xro/2.0';
const PAGE_SIZE = 100;

export interface BillIngestResult {
  venue_id: string;
  tenant_id: string;
  from_date: string;
  to_date: string;
  pages: number;
  bills: number;
  lines: number;
  /** Bills stored but excluded from spend -- voided or deleted. */
  non_spend: number;
  /** Bills Xero returned that could not be stored: no id, or no readable date. */
  unusable: number;
  stored: boolean;
}

/** Xero's `where` syntax wants DateTime(y,m,d), not an ISO string. */
function xeroDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `DateTime(${Number(y)},${Number(m)},${Number(d)})`;
}

export async function ingestSupplierBills(
  tenantId: string,
  fromDate: string,
  toDate: string,
  paceMs = 1100,
): Promise<BillIngestResult> {
  const { data: conn } = await supabase
    .from('xero_connections')
    .select('tenant_id, venue_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!conn) throw new Error(`No Xero connection for tenant ${tenantId}`);
  if (!conn.venue_id) {
    throw new Error(
      `Xero organisation ${tenantId} is not mapped to a venue. Map it first — ` +
      `"Potus" and "20 Craig Road" name no venue anyone could guess.`,
    );
  }

  const venueId = conn.venue_id as string;
  const accessToken = await getAccessToken(tenantId);
  const where = encodeURIComponent(
    `Type=="ACCPAY" AND Date>=${xeroDate(fromDate)} AND Date<=${xeroDate(toDate)}`,
  );

  let page = 1;
  let bills = 0;
  let lines = 0;
  let nonSpend = 0;
  let unusable = 0;

  for (;;) {
    const res = await fetch(`${XERO_API}/Invoices?where=${where}&page=${page}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Xero bills request failed: ${res.status} ${text.slice(0, 300)}`);

    const invoices = (JSON.parse(text)?.Invoices ?? []) as any[];
    if (invoices.length === 0) break;

    for (const invoice of invoices) {
      const bill = toBillRow(invoice);
      if (!bill) {
        // No id, or no readable date. Counted rather than skipped silently: a
        // bill nobody can date is a gap somebody should be able to see.
        unusable++;
        continue;
      }
      if (!isSpend(bill)) nonSpend++;

      const { data: stored, error } = await supabase
        .from('supplier_bills')
        .upsert(
          { ...bill, venue_id: venueId, tenant_id: tenantId, fetched_at: new Date().toISOString() },
          { onConflict: 'tenant_id,invoice_id' },
        )
        .select('id')
        .single();

      if (error) throw new Error(`supplier_bills upsert failed: ${error.message}`);
      bills++;

      const lineRows = toBillLineRows(invoice).map(l => ({
        ...l,
        bill_id: stored.id,
        venue_id: venueId,
        fetched_at: new Date().toISOString(),
      }));

      if (lineRows.length > 0) {
        const { error: lineError } = await supabase
          .from('supplier_bill_lines')
          .upsert(lineRows, { onConflict: 'bill_id,line_item_id' });
        if (lineError) throw new Error(`supplier_bill_lines upsert failed: ${lineError.message}`);
        lines += lineRows.length;
      }
    }

    // A short page is the last page. A FULL page means there is probably
    // another, and assuming otherwise is what makes a truncated pull look
    // complete.
    if (invoices.length < PAGE_SIZE) break;
    page++;
    if (paceMs > 0) await new Promise(r => setTimeout(r, paceMs));
  }

  return {
    venue_id: venueId,
    tenant_id: tenantId,
    from_date: fromDate,
    to_date: toDate,
    pages: page,
    bills,
    lines,
    non_spend: nonSpend,
    unusable,
    stored: bills > 0,
  };
}
