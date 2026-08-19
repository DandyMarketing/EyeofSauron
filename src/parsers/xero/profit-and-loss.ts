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

  sections.forEach((section, index) => {
    /**
     * Xero leaves several sections UNTITLED -- Gross Profit, Net Profit, and
     * spacers -- and they are not the same section as each other.
     *
     * The first version called every one of them "Uncategorised", which merged
     * them into a single bucket. Reconciliation then took the first summary row
     * it found there and compared it against detail lines from unrelated
     * sections: Neon Pigeon's August 2026 came back as lines summing to
     * -44,768.62 against a reported 20,705.02, two numbers that were never
     * meant to meet. The gate refused the period, correctly, for the wrong
     * reason.
     *
     * An untitled section takes its name from its own summary row instead --
     * which is where Xero puts "Gross Profit" and "Net Profit" -- and falls
     * back to its position if it has neither. Never merged: two sections that
     * cannot be told apart is worse than one with an ugly name.
     */
    const title = (section.Title ?? '').trim();
    const usable = (section.Rows ?? []).filter(
      r => r.RowType === 'Row' || r.RowType === 'SummaryRow',
    );

    /**
     * A COMPUTED TOTAL standing on its own.
     *
     * Gross Profit, Operating Profit and Net Profit are derived from other
     * sections, and this chart of accounts delivers them as a plain Row inside
     * an untitled section -- not as a SummaryRow. So RowType alone calls them
     * detail lines, and anything summing detail lines to get total costs would
     * add Gross Profit and Net Profit into the total. Neon Pigeon's June would
     * have gained 129,086.62 and lost 27,511.66 out of nowhere.
     *
     * An untitled section holding exactly one row is that shape. Treating its
     * row as a total is a heuristic, and it fails safe: a genuine detail line
     * misread this way is left OUT of a sum, where the opposite error puts a
     * whole section's total INTO one.
     */
    const isLoneComputedTotal = !title && usable.length === 1;

    const summaryLabel = usable.find(r => r.RowType === 'SummaryRow')?.Cells?.[0]?.Value?.trim();
    const loneLabel = isLoneComputedTotal ? usable[0]?.Cells?.[0]?.Value?.trim() : undefined;
    const sectionName = title || summaryLabel || loneLabel || `Section ${index + 1}`;

    for (const row of usable) {
      const cells = row.Cells ?? [];
      const name = (cells[0]?.Value ?? '').trim();
      const amount = parseAmount(cells[1]?.Value);
      if (!name || amount === null) continue;

      lines.push({
        section: sectionName,
        account_name: name,
        account_id: accountIdOf(cells[0]),
        amount,
        is_summary: row.RowType === 'SummaryRow' || isLoneComputedTotal,
        sort_order: order++,
      });
    }
  });

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
 *
 * Sections with a summary row and NO detail lines are skipped too, and that is
 * not a loophole. Gross Profit and Net Profit are COMPUTED totals -- derived
 * from other sections, with nothing beneath them to add up. Reconciling one
 * compares a real figure against a sum of zero, which can never pass and would
 * refuse every P&L Xero has ever produced.
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

    const details = sectionLines.filter(l => !l.is_summary);
    // A total with nothing under it is computed elsewhere, not summed here.
    if (details.length === 0) continue;

    const detailTotal = details.reduce((sum, l) => sum + l.amount, 0);

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
