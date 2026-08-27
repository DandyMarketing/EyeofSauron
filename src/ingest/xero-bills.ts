import { supabase } from '../lib/supabase.js';
import { getAccessToken } from './xero.js';
import { toBillRow, toBillLineRows, isSpend, type BillRow, type BillLineRow } from '../parsers/xero/bills.js';
import { toCreditNoteRow, toCreditNoteLineRows } from '../parsers/xero/credit-notes.js';
import { payrollAccountIds, looksLikePersonalPay } from '../lib/payroll-accounts.js';

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
  /** ACCPAY for bills, ACCPAYCREDIT for supplier credit notes. */
  document_type?: string;
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
  /** Bill lines dropped because they carry personal pay. Never stored. */
  payroll_lines_excluded: number;
  /**
   * Of those, the ones caught by reading the LINE rather than its account.
   *
   * Reported separately because it measures the blind spot: an account the P&L
   * never reports has no name for payrollAccountIds() to match, so anything
   * counted here would have reached the warehouse under the old filter alone.
   */
  personal_pay_caught_by_description: number;
  /**
   * Lines coded to an account with no P&L row.
   *
   * Not an error -- balance-sheet accounts legitimately never appear in a P&L
   * -- but it is exactly the condition that hid two salary accounts, so it is
   * counted and surfaced rather than left to an audit somebody happens to run.
   */
  unmapped_account_lines: number;
  stored: boolean;
}

/**
 * How many rows PostgREST returns before it stops without saying so.
 *
 * Supabase caps a request at 1,000 rows and reports nothing when it truncates.
 * That has cost this project data four times already, which is why every read
 * that can exceed it pages instead of hoping.
 */
const PG_PAGE = 1000;

export interface PlAccountRow {
  account_id: string | null;
  account_name: string | null;
}

/** One page of P&L account rows, or an error message. Injectable for tests. */
export type PlAccountPage = (
  venueId: string,
  from: number,
  to: number,
) => Promise<{ rows: PlAccountRow[] | null; error: string | null }>;

const fetchPlAccountPage: PlAccountPage = async (venueId, from, to) => {
  const { data, error } = await supabase
    .from('profit_and_loss')
    .select('account_id, account_name')
    .eq('venue_id', venueId)
    .not('account_id', 'is', null)
    // Ordered so the pages are stable. Without it Postgres may return rows in
    // a different order per request and a page boundary can drop rows.
    .order('account_id', { ascending: true })
    .range(from, to);
  return { rows: data ?? null, error: error ? error.message : null };
};

/**
 * EVERY P&L account row for a venue, paged.
 *
 * This feeds the payroll exclusion, so a truncated read is not a smaller
 * answer -- it is personal pay reaching the warehouse. Two years of P&L is
 * roughly 43 to 55 lines a month, so 24 months is about 1,030 to 1,090 rows
 * per venue: just over the cap, unordered, with no error. The exclusion would
 * have kept working by luck, because the same four payroll accounts repeat in
 * every month and would almost certainly survive any 1,000-row slice. "Almost
 * certainly" is the wrong standard for the one filter standing between
 * somebody's salary and a queryable table.
 */
export async function allPlAccounts(
  venueId: string,
  fetchPage: PlAccountPage = fetchPlAccountPage,
  pageSize: number = PG_PAGE,
): Promise<PlAccountRow[]> {
  const rows: PlAccountRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { rows: page, error } = await fetchPage(venueId, from, from + pageSize - 1);

    // A failed read must not look like "this venue has no payroll accounts",
    // which would silently disable the exclusion for the whole run.
    if (error) {
      throw new Error(
        `Could not read P&L accounts for the payroll exclusion (${error}). ` +
        `Refusing to ingest bills: without this list, payroll lines would be stored.`,
      );
    }

    rows.push(...(page ?? []));
    if (!page || page.length < pageSize) break;
  }

  return rows;
}

/** Xero's `where` syntax wants DateTime(y,m,d), not an ISO string. */
function xeroDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `DateTime(${Number(y)},${Number(m)},${Number(d)})`;
}

/**
 * What distinguishes a bill from a credit note, and nothing else.
 *
 * PARAMETERISED RATHER THAN COPIED, and the reason is the payroll guards. This
 * function drops personal pay twice over -- by account, and by what the line
 * itself looks like -- and those exclusions are the strongest protection in the
 * security model. Two code paths would mean two copies, and the day they drift
 * is the day a credit note reversing a wage payment carries a person's name
 * into the warehouse. One path cannot drift.
 */
interface DocumentSource {
  /** Xero's Type filter: ACCPAY for bills, ACCPAYCREDIT for supplier credits. */
  xeroType: string;
  /** Endpoint path. */
  endpoint: string;
  /** Key the array arrives under in the response body. */
  responseKey: string;
  /** Stored on every row so a credit is distinguishable from a bill. */
  documentType: string;
  /** For error messages. */
  label: string;
  toRow: (raw: any) => BillRow | null;
  toLines: (raw: any) => BillLineRow[];
}

const BILLS: DocumentSource = {
  xeroType: 'ACCPAY',
  endpoint: 'Invoices',
  responseKey: 'Invoices',
  documentType: 'ACCPAY',
  label: 'bills',
  toRow: toBillRow,
  toLines: toBillLineRows,
};

/**
 * Supplier credit notes -- refunds and returns.
 *
 * Without them bill-derived cost is OVERSTATED: Neon Pigeon's COGS Food came
 * back at 109% of its ledger total in June 2026, which is impossible and is
 * exactly the size of the credits nobody was counting.
 *
 * No new scope. Credit notes sit under `accounting.invoices`, which this app
 * already holds -- checked against Xero's granular scope mapping before any
 * work began, because the one-scope-at-a-time rule exists so nobody guesses at
 * this and spends a consent round on three organisations finding out.
 */
const CREDIT_NOTES: DocumentSource = {
  xeroType: 'ACCPAYCREDIT',
  endpoint: 'CreditNotes',
  responseKey: 'CreditNotes',
  documentType: 'ACCPAYCREDIT',
  label: 'credit notes',
  toRow: toCreditNoteRow,
  toLines: toCreditNoteLineRows,
};

export function ingestSupplierBills(
  tenantId: string,
  fromDate: string,
  toDate: string,
  paceMs = 1100,
): Promise<BillIngestResult> {
  return ingestDocuments(BILLS, tenantId, fromDate, toDate, paceMs);
}

export function ingestCreditNotes(
  tenantId: string,
  fromDate: string,
  toDate: string,
  paceMs = 1100,
): Promise<BillIngestResult> {
  return ingestDocuments(CREDIT_NOTES, tenantId, fromDate, toDate, paceMs);
}

async function ingestDocuments(
  source: DocumentSource,
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

  /**
   * Which accounts hold personal pay, for THIS venue.
   *
   * Payroll is posted as supplier bills in this chart of accounts, so pulling
   * bills pulls individual pay -- 168 lines for one venue in one month, roughly
   * forty people times four accounts. The security model says not to hold that
   * at all, and an exclusion at ingest has to be right once where a filter at
   * read time has to be remembered every time.
   *
   * Read from the P&L because that is where account NAMES live: a bill line
   * carries only a code and a UUID and cannot be judged on its own.
   */
  const plAccounts = await allPlAccounts(venueId);
  const excludedAccounts = payrollAccountIds(plAccounts);
  // Which accounts the P&L knows about at all. A line coded outside this set is
  // one the account-name exclusion is structurally unable to judge.
  const knownAccounts = new Set(plAccounts.map(a => a.account_id).filter(Boolean) as string[]);

  const accessToken = await getAccessToken(tenantId);
  const where = encodeURIComponent(
    `Type=="${source.xeroType}" AND Date>=${xeroDate(fromDate)} AND Date<=${xeroDate(toDate)}`,
  );

  let page = 1;
  let bills = 0;
  let lines = 0;
  let nonSpend = 0;
  let unusable = 0;
  let payrollExcluded = 0;
  let caughtByDescription = 0;
  let unmappedAccountLines = 0;

  for (;;) {
    const res = await fetch(`${XERO_API}/${source.endpoint}?where=${where}&page=${page}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Xero ${source.label} request failed: ${res.status} ${text.slice(0, 300)}`);

    const invoices = (JSON.parse(text)?.[source.responseKey] ?? []) as any[];
    if (invoices.length === 0) break;

    /**
     * A PAGE at a time, not a bill at a time.
     *
     * The first version upserted each bill, selected its id back, then upserted
     * its lines -- two round-trips per bill. Neon Pigeon alone posts 390 bills a
     * month, so two years across three venues is roughly 28,000 round-trips and
     * several hours, nearly all of it waiting.
     *
     * Batched by page it is two round-trips per hundred bills: about 600 for the
     * whole backfill. The Xero side is unchanged -- four calls a month per venue
     * -- so this is purely the write pattern, which is where the time was.
     */
    const pageBills: any[] = [];
    const linesByInvoice = new Map<string, BillLineRow[]>();

    for (const invoice of invoices) {
      const bill = source.toRow(invoice);
      if (!bill) {
        // No id, or no readable date. Counted rather than skipped silently: a
        // bill nobody can date is a gap somebody should be able to see.
        unusable++;
        continue;
      }
      if (!isSpend(bill)) nonSpend++;

      pageBills.push({
        ...bill,
        venue_id: venueId,
        tenant_id: tenantId,
        document_type: source.documentType,
        fetched_at: new Date().toISOString(),
      });
      // Dropped BEFORE anything is written. Aggregate labour cost still reaches
      // the warehouse through the P&L, where it is a section total with no names
      // and no individual amounts.
      const allLines = source.toLines(invoice);
      const keep = allLines.filter(line => {
        // Guard one: the account is known to hold personal pay.
        if (line.account_id && excludedAccounts.has(line.account_id)) {
          payrollExcluded++;
          return false;
        }
        /**
         * Guard two: the LINE looks like a payment to a person, whatever
         * account it was coded to. This is the one that catches an account the
         * P&L never reported -- the hole that let named salaries through until
         * 23 Aug 2026.
         */
        if (looksLikePersonalPay(line.description, bill.supplier_name)) {
          payrollExcluded++;
          caughtByDescription++;
          return false;
        }
        if (line.account_id && !knownAccounts.has(line.account_id)) unmappedAccountLines++;
        return true;
      });
      linesByInvoice.set(bill.invoice_id, keep);
    }

    if (pageBills.length > 0) {
      const { data: storedBills, error } = await supabase
        .from('supplier_bills')
        .upsert(pageBills, { onConflict: 'tenant_id,invoice_id' })
        .select('id, invoice_id');

      if (error) throw new Error(`supplier_bills upsert failed: ${error.message}`);
      bills += storedBills?.length ?? 0;

      // Keyed by the invoice id we sent, never by position: an upsert makes no
      // promise about the order it returns rows in, and lines attached to the
      // wrong bill would be spend filed against the wrong supplier.
      const idOf = new Map((storedBills ?? []).map(b => [b.invoice_id, b.id]));

      const lineRows = [];
      for (const [invoiceId, invoiceLines] of linesByInvoice) {
        const billId = idOf.get(invoiceId);
        if (!billId) continue;
        for (const line of invoiceLines) {
          lineRows.push({
            ...line,
            bill_id: billId,
            venue_id: venueId,
            fetched_at: new Date().toISOString(),
          });
        }
      }

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
    document_type: source.documentType,
    venue_id: venueId,
    tenant_id: tenantId,
    from_date: fromDate,
    to_date: toDate,
    pages: page,
    bills,
    lines,
    non_spend: nonSpend,
    unusable,
    payroll_lines_excluded: payrollExcluded,
    personal_pay_caught_by_description: caughtByDescription,
    unmapped_account_lines: unmappedAccountLines,
    stored: bills > 0,
  };
}
