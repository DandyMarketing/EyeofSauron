import { supabase } from '../lib/supabase.js';
import { getAccessToken } from './xero.js';
import { parseProfitAndLoss, reconcileSections, type SectionCheck } from '../parsers/xero/profit-and-loss.js';

/**
 * Fetch and store a Profit & Loss period from Xero.
 *
 * The reconciliation gate is not advisory here. A P&L whose detail lines do
 * not add up to its own totals is not stored, because a plausible wrong P&L is
 * worse than none: nobody questions a number that looks reasonable, and every
 * margin, food-cost percentage and recommendation built on it inherits the
 * error silently.
 */

const XERO_API = 'https://api.xero.com/api.xro/2.0';

export interface PlIngestResult {
  venue_id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  lines: number;
  checks: SectionCheck[];
  stored: boolean;
  error?: string;
}

export async function fetchProfitAndLoss(
  tenantId: string,
  fromDate: string,
  toDate: string,
): Promise<any> {
  const accessToken = await getAccessToken(tenantId);
  const url = `${XERO_API}/Reports/ProfitAndLoss?fromDate=${fromDate}&toDate=${toDate}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    // Xero's 401 here usually means the connection was revoked in Xero rather
    // than a token problem, and the body says which.
    throw new Error(`Xero P&L request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Ingest one period for one mapped organisation.
 *
 * Refuses to run against an unmapped tenant. A P&L filed under the wrong venue
 * is not a smaller version of being right -- it is a wrong answer about a
 * different business, and it is the exact failure BUILD_LOG 2.2 records.
 */
export async function ingestProfitAndLoss(
  tenantId: string,
  fromDate: string,
  toDate: string,
): Promise<PlIngestResult> {
  const { data: conn } = await supabase
    .from('xero_connections')
    .select('tenant_id, venue_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!conn) throw new Error(`No Xero connection for tenant ${tenantId}`);
  if (!conn.venue_id) {
    throw new Error(
      `Xero organisation ${tenantId} is not mapped to a venue. Map it in the admin page first — ` +
      `organisation names are legal entities and must not be guessed at.`,
    );
  }

  const base = {
    venue_id: conn.venue_id,
    tenant_id: tenantId,
    period_start: fromDate,
    period_end: toDate,
  };

  const report = parseProfitAndLoss(await fetchProfitAndLoss(tenantId, fromDate, toDate));
  const checks = reconcileSections(report.lines);
  const failed = checks.filter(c => !c.passed);

  if (failed.length > 0) {
    const detail = failed
      .map(f => `${f.section}: lines sum to ${f.detail_total}, report says ${f.reported_total} (out by ${f.difference})`)
      .join('; ');
    return {
      ...base,
      lines: report.lines.length,
      checks,
      stored: false,
      error: `P&L failed reconciliation and was NOT stored — ${detail}`,
    };
  }

  const rows = report.lines.map(line => ({
    ...base,
    section: line.section,
    account_name: line.account_name,
    account_id: line.account_id,
    amount: line.amount,
    is_summary: line.is_summary,
    sort_order: line.sort_order,
    fetched_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('profit_and_loss')
    /**
     * Neither `section` nor `is_summary` is in this key -- see migration 023.
     *
     * Both were, and both are the parser's DESCRIPTION of a row rather than
     * its identity. One bug fix rewrote both at once: Gross Profit, Operating
     * Profit and Net Profit went from detail lines under positional labels
     * ("Section 3", "Section 9/10/11/12") to totals under their own names. The
     * upsert matched nothing and INSERTED -- 213 duplicate rows across three
     * venues and two years, each line present once correctly and once still
     * claiming to be a detail line. Both real, both the same amount, invisible
     * unless somebody counted.
     *
     * The positional labels even drifted month to month, because they came
     * from the report's shape. Nothing that unstable belongs in a key.
     *
     * A column a bug fix might change must never be part of the key, or the
     * fix forks the row instead of repairing it.
     */
    .upsert(rows, { onConflict: 'venue_id,period_start,period_end,account_name' });

  if (error) throw new Error(`P&L upsert failed: ${error.message}`);

  return { ...base, lines: rows.length, checks, stored: true };
}
