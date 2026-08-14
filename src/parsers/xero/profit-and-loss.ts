/**
 * Xero Profit & Loss report parser.
 *
 * Xero returns the P&L as a nested report: a list of Sections ("Income",
 * "Less Cost of Sales", "Less Operating Expenses"), each holding detail Rows
 * and a SummaryRow with that section's total. This flattens it into rows the
 * warehouse can store next to revenue and covers.
 *
 * NOTHING PARSED HERE IS TRUSTED UNTIL IT HAS BEEN RECONCILED against a real
 * report. The structure below follows Xero's documented shape, and a shape
 * that looks right while meaning something else is exactly the defect in
 * BUILD_LOG 2.2 -- Fat Prince's DAY/LEGACY shifts produced $212/head dinners
 * from code that read perfectly well. reconcileSections() is the check.
 */

export interface PlLine {
  /** Section heading as Xero reports it, e.g. "Less Cost of Sales". */
  section: string;
  account_name: string;
  /** Xero's account UUID, when the cell carries one. Summary rows have none. */
  account_id: string | null;
  amount: number;
  /** True for a section total ("Total Income"), false for a detail line. */
  is_summary: boolean;
  sort_order: number;
}

export interface PlReport {
  report_name: string;
  /** Titles as Xero renders them -- includes the organisation and the period. */
  titles: string[];
  lines: PlLine[];
}

interface XeroCell { Value?: string; Attributes?: Array<{ Value: string; Id: string }> }
interface XeroRow { RowType: string; Title?: string; Cells?: XeroCell[]; Rows?: XeroRow[] }

/**
 * Parse an amount cell.
 *
 * Returns null rather than 0 for an unparseable value. A missing figure and a
 * genuine zero are different facts, and collapsing them would let a failed
 * extraction read as a month with no costs.
 */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Xero renders negatives in parentheses in some locales.
  const negated = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[(),]/g, '').replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negated ? -n : n;
}

function accountIdOf(cell: XeroCell | undefined): string | null {
  const attr = cell?.Attributes?.find(a => a.Id === 'account' || a.Value?.length === 36);
  return attr?.Value ?? null;
}

/**
 * Flatten Xero's nested report into lines.
 *
 * Amounts are stored exactly as Xero reports them. Xero already applies its
 * own sign convention -- costs appear as positive numbers under a "Less ..."
 * heading -- and re-deriving that here would put a second, undocumented
 * convention between the ledger and the answer. The section name carries the
 * meaning; the number stays as the accountant would recognise it.
 */
export function parseProfitAndLoss(payload: any): PlReport {
  const report = payload?.Reports?.[0];
  if (!report) throw new Error('Xero P&L response contained no Reports entry');

  const rows: XeroRow[] = report.Rows ?? [];
  const sections = rows.filter(r => r.RowType === 'Section');
  if (sections.length === 0) {
    // An empty report is a failed extraction, not a month with no trading --
    // the same distinction the Revel operations parser had to make.
    throw new Error('Xero P&L report contained no sections — treating as a failed extraction, not an empty period');
  }

  const lines: PlLine[] = [];
  let order = 0;

  for (const section of sections) {
    // Xero leaves the title empty on some spacer sections; skip them rather
    // than inventing a heading.
    const title = (section.Title ?? '').trim();
    for (const row of section.Rows ?? []) {
      if (row.RowType !== 'Row' && row.RowType !== 'SummaryRow') continue;
      const cells = row.Cells ?? [];
      const name = (cells[0]?.Value ?? '').trim();
      const amount = parseAmount(cells[1]?.Value);
      if (!name || amount === null) continue;

      lines.push({
        section: title || 'Uncategorised',
        account_name: name,
        account_id: accountIdOf(cells[0]),
        amount,
        is_summary: row.RowType === 'SummaryRow',
        sort_order: order++,
      });
    }
  }

  if (lines.length === 0) {
    throw new Error('Xero P&L report parsed to zero lines — treating as a failed extraction');
  }

  return {
    report_name: report.ReportName ?? 'Profit and Loss',
    titles: report.ReportTitles ?? [],
    lines,
  };
}

export interface SectionCheck {
  section: string;
  detail_total: number;
  reported_total: number;
  difference: number;
  passed: boolean;
}

/**
 * Do the detail lines in each section add up to the total Xero reports?
 *
 * This is the reconciliation gate CLAUDE.md requires before a figure is
 * trusted: line items sum to totals. It catches a mis-flattened report, a
 * section whose rows were partially read, and a sign convention read the wrong
 * way -- all of which otherwise produce a confident, wrong P&L.
 *
 * Sections with no summary row are skipped, not failed: Xero does not give
 * every section a total.
 */
export function reconcileSections(lines: PlLine[], tolerance = 0.01): SectionCheck[] {
  const bySection = new Map<string, PlLine[]>();
  for (const line of lines) {
    const list = bySection.get(line.section) ?? [];
    list.push(line);
    bySection.set(line.section, list);
  }

  const checks: SectionCheck[] = [];
  for (const [section, sectionLines] of bySection) {
    const summary = sectionLines.find(l => l.is_summary);
    if (!summary) continue;

    const detailTotal = sectionLines
      .filter(l => !l.is_summary)
      .reduce((sum, l) => sum + l.amount, 0);

    const difference = Math.round((detailTotal - summary.amount) * 100) / 100;
    checks.push({
      section,
      detail_total: Math.round(detailTotal * 100) / 100,
      reported_total: summary.amount,
      difference,
      passed: Math.abs(difference) <= tolerance,
    });
  }
  return checks;
}
