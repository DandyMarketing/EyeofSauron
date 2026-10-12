/**
 * An event P&L as an Excel workbook, in the shape Khai already uses.
 *
 * THE TEMPLATE (26-1012_NP_NYE_2026.xlsx, 12 Oct 2026) and what was kept: the
 * revenue built bottom-up by floor x time slot x concept x covers x spend per
 * person, a target market and comment beside each slot, quantity x unit price
 * on every cost line, a % of revenue beside every line, sections with their own
 * totals, and one bottom line -- all live formulas.
 *
 * What was fixed, because each one changed the answer:
 *   - its "23% Product COGS" row had no formula, so product cost was $0 and the
 *     profit read 75%. Here product cost is computed on every revenue line at
 *     the venue's MEASURED food and drink cost, so free flow and tables carry
 *     the cost of what is poured;
 *   - the group's management and licensing fees were missing -- a real cost of
 *     about 5% of income at Neon Pigeon;
 *   - card and ticketing fees, promoter commission, security and ads are
 *     always present, blank and marked "to fill" until somebody has a number;
 *   - labour was =8*2*16*7 with nothing saying what 8, 2, 16 and 7 were; a
 *     line here is staff x hours x rate in labelled columns;
 *   - every line says where its number came from (BASIS), the same rule the
 *     planner follows: our data, a source, a proposal, or to fill;
 *   - a scenario block shows profit at 60/80/100% of covers sold, so the
 *     bottom line is not only the best case.
 *
 * FORMULAS AND RESULTS BOTH. Every formula carries its computed result, so the
 * figures show in a phone's file preview (which does not recalculate), and
 * Excel or Sheets recalculates the moment an input changes.
 */

import ExcelJS from 'exceljs';

export type Basis = 'our data' | 'source' | 'proposal' | 'to fill';
export type CostBasis = 'food' | 'drink' | 'food_and_drink' | 'none';
export type CostSection = 'operating' | 'furniture' | 'entertainment' | 'marketing' | 'additional' | 'labour';

export interface ProgrammingSlot {
  floor: string;
  time: string;
  concept: string;
  covers: number | null;
  per_person: number | null;
  /** What it costs to serve: drives the product cost of the line. */
  cost_basis: CostBasis;
  target_market?: string | null;
  comments?: string | null;
  basis: Basis;
}

export interface CostLine {
  section: CostSection;
  item: string;
  qty?: number | null;
  /** Labour: staff x HOURS x rate. Blank means 1. */
  hours?: number | null;
  unit_price?: number | null;
  note?: string | null;
  basis: Basis;
}

export interface EventPnlInput {
  name: string;
  venues: string[];
  dates: string;
  service_charge_pct?: number | null;
  programming: ProgrammingSlot[];
  costs: CostLine[];
}

/** A rate and where it came from. Null value means nobody has it. */
export interface Rate { value: number | null; label: string; basis: Basis }

export interface VenueRates {
  /** Fractions, e.g. 0.2559. */
  food_cost: Rate;
  drink_cost: Rate;
  /** Share of food in a food-and-drink line, from the venue's own split. */
  food_share: Rate;
  group_fees: Rate;
  card_fees: Rate;
}

export const SECTION_TITLES: Record<CostSection, string> = {
  operating: 'OPERATING COSTS',
  furniture: 'FURNITURE & EQUIPMENT RENTAL',
  entertainment: 'ENTERTAINMENT & PROGRAMMING',
  marketing: 'MARKETING',
  additional: 'ADDITIONAL COSTS',
  labour: 'LABOUR COSTS',
};

const SECTION_ORDER: CostSection[] = ['operating', 'furniture', 'entertainment', 'marketing', 'additional', 'labour'];

/**
 * Lines every event P&L carries, so a missing cost is a visible blank rather
 * than an absence. Added only where the input has nothing that matches.
 */
const STANDARD_LINES: Array<{ section: CostSection; item: string; match: RegExp; note: string }> = [
  { section: 'marketing', item: 'Paid ads (Instagram / TikTok / Google)', match: /\bads?\b|advert|boost|paid/i, note: 'Who signs it off, and what it should bring back' },
  { section: 'additional', item: 'Promoter commission', match: /promoter/i, note: 'Per head, capped -- paid on reconciled codes' },
  // Labour, not an additional cost (Khai, 12 Oct 2026: "security ... is labour").
  { section: 'labour', item: 'Security', match: /security|guard|bouncer/i, note: 'Door and floor, all rooms: guards x hours x rate' },
];

const BASES: Basis[] = ['our data', 'source', 'proposal', 'to fill'];
const asBasis = (b: unknown): Basis => (BASES.includes(b as Basis) ? (b as Basis) : 'to fill');
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The cost lines that will be written: the input's, plus any missing standard ones. */
export function withStandardLines(costs: CostLine[]): CostLine[] {
  const out = costs.map(c => ({ ...c, basis: asBasis(c.basis) }));
  for (const s of STANDARD_LINES) {
    if (!out.some(c => s.match.test(c.item))) {
      out.push({ section: s.section, item: s.item, note: s.note, basis: 'to fill' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- figures

export interface PnlFigures {
  gross: number;
  service_charge: number;
  nett: number;
  product_cost: number;
  group_fees: number;
  card_fees: number;
  sections: Record<CostSection, number>;
  /** Product cost + group fees + card fees: what scales with covers sold. */
  variable: number;
  fixed: number;
  profit: number;
  scenarios: Array<{ pct: number; revenue: number; profit: number; margin: number | null }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const rate = (r: Rate) => r.value ?? 0;

export function slotTotal(s: ProgrammingSlot): number {
  return (num(s.covers) ?? 0) * (num(s.per_person) ?? 0);
}

export function slotProductCost(s: ProgrammingSlot, rates: VenueRates): number {
  const t = slotTotal(s);
  switch (s.cost_basis) {
    case 'food': return t * rate(rates.food_cost);
    case 'drink': return t * rate(rates.drink_cost);
    case 'food_and_drink': {
      const f = rate(rates.food_share);
      return t * (f * rate(rates.food_cost) + (1 - f) * rate(rates.drink_cost));
    }
    default: return 0;
  }
}

export function lineNett(c: CostLine): number {
  return (num(c.qty) ?? 0) * (num(c.hours) ?? 1) * (num(c.unit_price) ?? 0);
}

export const SCENARIOS = [0.6, 0.8, 1];

/** The same arithmetic the workbook's formulas do, for the cached results and the tests. */
export function computePnl(input: EventPnlInput, rates: VenueRates): PnlFigures {
  const sc = (num(input.service_charge_pct) ?? 10) / 100;
  const gross = input.programming.reduce((t, s) => t + slotTotal(s), 0);
  const service_charge = gross * sc;
  const nett = gross + service_charge;
  const product_cost = input.programming.reduce((t, s) => t + slotProductCost(s, rates), 0);
  const group_fees = gross * rate(rates.group_fees);
  const card_fees = nett * rate(rates.card_fees);
  const sections = Object.fromEntries(SECTION_ORDER.map(s => [s, 0])) as Record<CostSection, number>;
  for (const c of withStandardLines(input.costs)) sections[c.section] += lineNett(c);
  sections.additional += card_fees;
  const variable = product_cost + group_fees + card_fees;
  const fixed = SECTION_ORDER.reduce((t, s) => t + sections[s], 0) - card_fees;
  const profit = nett - variable - fixed;
  return {
    gross: r2(gross), service_charge: r2(service_charge), nett: r2(nett),
    product_cost: r2(product_cost), group_fees: r2(group_fees), card_fees: r2(card_fees),
    sections: Object.fromEntries(SECTION_ORDER.map(s => [s, r2(sections[s])])) as Record<CostSection, number>,
    variable: r2(variable), fixed: r2(fixed), profit: r2(profit),
    scenarios: SCENARIOS.map(p => {
      const revenue = nett * p;
      const pr = revenue - variable * p - fixed;
      return { pct: p, revenue: r2(revenue), profit: r2(pr), margin: revenue > 0 ? pr / revenue : null };
    }),
  };
}

// ---------------------------------------------------------------- workbook

const MONEY = '"$"#,##0.00;[Red]-"$"#,##0.00;"-"';
const PCT = '0.00%';
const INPUT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const SECTION_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
const BASIS_FONT: Record<Basis, Partial<ExcelJS.Font>> = {
  'our data': { color: { argb: 'FF166534' } },
  source: { color: { argb: 'FF1D4ED8' } },
  proposal: { color: { argb: 'FFB45309' }, italic: true },
  'to fill': { color: { argb: 'FFB91C1C' }, bold: true },
};

type Cell = ExcelJS.Cell;
const f = (cell: Cell, formula: string, result: number) => { cell.value = { formula, result } as any; };
const inputCell = (cell: Cell, v: number | null, fmt?: string) => {
  cell.value = v ?? null;
  cell.fill = INPUT_FILL;
  if (fmt) cell.numFmt = fmt;
};
const basisCell = (cell: Cell, b: Basis) => { cell.value = b; cell.font = BASIS_FONT[b]; };

/** Assumptions sheet cell addresses, referenced absolutely from the P&L. */
const A = {
  service: 'Assumptions!$B$3',
  food: 'Assumptions!$B$4',
  drink: 'Assumptions!$B$5',
  share: 'Assumptions!$B$6',
  fees: 'Assumptions!$B$7',
  card: 'Assumptions!$B$8',
};

export async function buildEventPnlWorkbook(
  rawInput: EventPnlInput, rates: VenueRates, generatedOn: string,
): Promise<ExcelJS.Workbook> {
  const input: EventPnlInput = {
    ...rawInput,
    programming: rawInput.programming.map(s => ({ ...s, basis: asBasis(s.basis) })),
  };
  const figs = computePnl(input, rates);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sauron';
  wb.calcProperties.fullCalcOnLoad = true;

  // ---- Assumptions --------------------------------------------------------
  const as = wb.addWorksheet('Assumptions');
  as.columns = [{ width: 34 }, { width: 12 }, { width: 11 }, { width: 70 }];
  as.getCell('A1').value = 'Assumptions -- change a shaded cell and the P&L recalculates';
  as.getCell('A1').font = { bold: true, size: 13 };
  ['Assumption', 'Value', 'Basis', 'Where it comes from'].forEach((h, i) => {
    const c = as.getRow(2).getCell(i + 1); c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL;
  });
  const sc = num(input.service_charge_pct) ?? 10;
  const aRows: Array<[string, number | null, Basis, string]> = [
    ['Service charge', sc / 100, input.service_charge_pct == null ? 'proposal' : 'our data', 'On gross revenue'],
    ['Food cost % of food sales', rates.food_cost.value, rates.food_cost.basis, rates.food_cost.label],
    ['Drink cost % of drink sales', rates.drink_cost.value, rates.drink_cost.basis, rates.drink_cost.label],
    ['Food share of a food-and-drink line', rates.food_share.value, rates.food_share.basis, rates.food_share.label],
    ['Group fees % of revenue', rates.group_fees.value, rates.group_fees.basis, rates.group_fees.label],
    ['Card & ticketing fees % of nett revenue', rates.card_fees.value, rates.card_fees.basis, rates.card_fees.label],
  ];
  aRows.forEach(([label, v, b, src], i) => {
    const row = as.getRow(3 + i);
    row.getCell(1).value = label;
    inputCell(row.getCell(2), v, PCT);
    basisCell(row.getCell(3), b);
    row.getCell(4).value = src;
  });

  // ---- P&L ------------------------------------------------------------------
  const ws = wb.addWorksheet('P&L', { views: [{ state: 'frozen', ySplit: 5 }] });
  ws.columns = [
    { width: 38 }, { width: 7 }, { width: 7 }, { width: 13 }, { width: 14 }, { width: 9 }, { width: 10 }, { width: 34 },
    { width: 3 },
    { width: 14 }, { width: 16 }, { width: 30 }, { width: 8 }, { width: 11 }, { width: 13 }, { width: 13 },
    { width: 40 }, { width: 34 }, { width: 10 },
  ];
  ws.getCell('A1').value = `${input.name} -- P&L`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = `${input.venues.join(', ')} · ${input.dates} · generated by Sauron on ${generatedOn}. Shaded cells are inputs; everything else is a formula.`;
  ws.getCell('A3').value = 'Basis: our data = from Sauron\'s warehouse · source = read in a cited source · proposal = a suggestion, not a fact · to fill = nobody has a number yet';
  ws.getCell('A3').font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  const headers = (row: number, cols: string[], start: number) => cols.forEach((h, i) => {
    const c = ws.getRow(row).getCell(start + i);
    c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL;
  });
  headers(5, ['Item', 'No.', 'Hours', 'Unit price', 'Nett', '% gross', 'Basis', 'Note'], 1);
  headers(5, ['Floor', 'Time', 'Concept', 'Covers', 'Per person', 'Total', 'Product cost', 'Target market', 'Comments', 'Basis'], 10);

  // ---- Revenue programming (right) ------------------------------------------
  let pr = 6;
  const slotRows: number[] = [];
  const floors = [...new Set(input.programming.map(s => s.floor))];
  for (const floor of floors) {
    const fc = ws.getRow(pr).getCell(10);
    fc.value = floor; fc.font = { bold: true }; ws.getRow(pr).getCell(10).fill = SECTION_FILL;
    pr++;
    for (const s of input.programming.filter(x => x.floor === floor)) {
      const row = ws.getRow(pr);
      row.getCell(11).value = s.time;
      row.getCell(12).value = s.concept;
      inputCell(row.getCell(13), num(s.covers));
      inputCell(row.getCell(14), num(s.per_person), MONEY);
      f(row.getCell(15), `M${pr}*N${pr}`, slotTotal(s));
      row.getCell(15).numFmt = MONEY;
      const pc = {
        food: `O${pr}*${A.food}`,
        drink: `O${pr}*${A.drink}`,
        food_and_drink: `O${pr}*(${A.share}*${A.food}+(1-${A.share})*${A.drink})`,
        none: '0',
      }[s.cost_basis] ?? '0';
      f(row.getCell(16), pc, slotProductCost(s, rates));
      row.getCell(16).numFmt = MONEY;
      row.getCell(17).value = s.target_market ?? null;
      row.getCell(18).value = s.comments ?? null;
      basisCell(row.getCell(19), s.basis);
      [17, 18].forEach(c => { row.getCell(c).alignment = { wrapText: true, vertical: 'top' }; });
      slotRows.push(pr);
      pr++;
    }
  }
  const progTotalRow = pr;
  const sumOf = (col: string) => slotRows.length ? slotRows.map(r => `${col}${r}`).join(',') : '0';
  ws.getRow(progTotalRow).getCell(14).value = 'Total';
  ws.getRow(progTotalRow).getCell(14).font = { bold: true };
  f(ws.getRow(progTotalRow).getCell(15), `SUM(${sumOf('O')})`, figs.gross);
  f(ws.getRow(progTotalRow).getCell(16), `SUM(${sumOf('P')})`, figs.product_cost);
  [15, 16].forEach(c => { const x = ws.getRow(progTotalRow).getCell(c); x.numFmt = MONEY; x.font = { bold: true }; });

  // ---- P&L (left) -------------------------------------------------------------
  let r = 6;
  const pct = (row: number) => { f(ws.getCell(`F${row}`), `IF($E$6=0,0,E${row}/$E$6)`, 0); ws.getCell(`F${row}`).numFmt = PCT; };
  const money = (cell: Cell) => { cell.numFmt = MONEY; };

  ws.getCell('A6').value = 'Gross revenue (from the programming)';
  f(ws.getCell('E6'), `O${progTotalRow}`, figs.gross); money(ws.getCell('E6'));
  ws.getCell('A7').value = 'Service charge';
  f(ws.getCell('E7'), `E6*${A.service}`, figs.service_charge); money(ws.getCell('E7'));
  ws.getCell('A8').value = 'Nett revenue';
  f(ws.getCell('E8'), 'E6+E7', figs.nett); money(ws.getCell('E8'));
  [6, 7, 8].forEach(pct);
  ['A8', 'E8'].forEach(a => { ws.getCell(a).font = { bold: true }; });
  r = 10;

  const sectionTotals: string[] = [];
  const sectionHeader = (title: string) => {
    const c = ws.getCell(`A${r}`); c.value = title; c.font = { bold: true };
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach(col => { ws.getCell(`${col}${r}`).fill = SECTION_FILL; });
    r++;
  };
  const sectionTotal = (first: number, last: number, result: number) => {
    ws.getCell(`A${r}`).value = 'Total';
    ws.getCell(`A${r}`).font = { bold: true };
    f(ws.getCell(`E${r}`), last >= first ? `-SUM(E${first}:E${last})` : '0', -result);
    money(ws.getCell(`E${r}`)); ws.getCell(`E${r}`).font = { bold: true };
    pct(r);
    sectionTotals.push(`E${r}`);
    r += 2;
  };

  // Product cost: from every revenue line, at the venue's measured rates.
  sectionHeader('PRODUCT COST');
  const productRow = r;
  ws.getCell(`A${r}`).value = 'Food & drink cost of every revenue line';
  f(ws.getCell(`E${r}`), `P${progTotalRow}`, figs.product_cost); money(ws.getCell(`E${r}`)); pct(r);
  basisCell(ws.getCell(`G${r}`), rates.food_cost.basis === 'our data' && rates.drink_cost.basis === 'our data' ? 'our data' : 'to fill');
  ws.getCell(`H${r}`).value = 'Per line in the programming, at the rates on the Assumptions sheet';
  r++;
  sectionTotal(productRow, productRow, figs.product_cost);

  // Group fees: a real cost of each Pte Ltd.
  sectionHeader('GROUP FEES');
  const feeRow = r;
  ws.getCell(`A${r}`).value = 'Management & licensing fees (The Dandy Partnership)';
  f(ws.getCell(`E${r}`), `E6*${A.fees}`, figs.group_fees); money(ws.getCell(`E${r}`)); pct(r);
  basisCell(ws.getCell(`G${r}`), rates.group_fees.basis);
  ws.getCell(`H${r}`).value = rates.group_fees.label;
  r++;
  sectionTotal(feeRow, feeRow, figs.group_fees);

  let cardRow = 0;
  const lines = withStandardLines(input.costs);
  for (const section of SECTION_ORDER) {
    const mine = lines.filter(c => c.section === section);
    if (mine.length === 0 && section !== 'additional') continue;
    sectionHeader(SECTION_TITLES[section]);
    const first = r;
    for (const c of mine) {
      ws.getCell(`A${r}`).value = c.item;
      inputCell(ws.getCell(`B${r}`), num(c.qty));
      inputCell(ws.getCell(`C${r}`), num(c.hours));
      inputCell(ws.getCell(`D${r}`), num(c.unit_price), MONEY);
      f(ws.getCell(`E${r}`), `B${r}*IF(C${r}="",1,C${r})*D${r}`, lineNett(c)); money(ws.getCell(`E${r}`));
      pct(r);
      basisCell(ws.getCell(`G${r}`), c.basis);
      ws.getCell(`H${r}`).value = c.note ?? null;
      r++;
    }
    if (section === 'additional') {
      cardRow = r;
      ws.getCell(`A${r}`).value = 'Card & ticketing fees';
      f(ws.getCell(`E${r}`), `E8*${A.card}`, figs.card_fees); money(ws.getCell(`E${r}`)); pct(r);
      basisCell(ws.getCell(`G${r}`), rates.card_fees.basis);
      ws.getCell(`H${r}`).value = 'Rate on the Assumptions sheet';
      r++;
    }
    sectionTotal(first, r - 1, figs.sections[section]);
  }

  // Bottom line.
  const plRow = r;
  ws.getCell(`A${r}`).value = 'Profit & Loss';
  f(ws.getCell(`E${r}`), `E8+${sectionTotals.join('+')}`, figs.profit);
  ws.getCell(`A${r}`).font = { bold: true, size: 12 };
  money(ws.getCell(`E${r}`)); ws.getCell(`E${r}`).font = { bold: true, size: 12 };
  pct(r);
  r++;
  ws.getCell(`A${r}`).value = 'Margin on nett revenue';
  f(ws.getCell(`E${r}`), `IF(E8=0,0,E${plRow}/E8)`, figs.nett ? figs.profit / figs.nett : 0);
  ws.getCell(`E${r}`).numFmt = PCT;
  r += 2;

  // Scenarios: product cost, group fees and card fees scale with covers; the rest does not.
  sectionHeader('IF ONLY PART OF THE COVERS SELL');
  const varCell = `E${r}`;
  ws.getCell(`A${r}`).value = 'Costs that scale with covers (product, group fees, card fees)';
  f(ws.getCell(varCell), `E${productRow}+E${feeRow}+${cardRow ? `E${cardRow}` : '0'}`, figs.variable); money(ws.getCell(varCell));
  r++;
  const fixedCell = `E${r}`;
  ws.getCell(`A${r}`).value = 'Costs that do not (everything else)';
  f(ws.getCell(fixedCell), `-(${sectionTotals.join('+')})-${varCell}`, figs.fixed); money(ws.getCell(fixedCell));
  r++;
  headers(r, ['Covers sold', '', '', '', 'Revenue', '', 'Profit', 'Margin'], 1);
  r++;
  for (const s of figs.scenarios) {
    inputCell(ws.getCell(`A${r}`), s.pct, '0%');
    f(ws.getCell(`E${r}`), `$E$8*A${r}`, s.revenue); money(ws.getCell(`E${r}`));
    f(ws.getCell(`G${r}`), `E${r}-${varCell}*A${r}-${fixedCell}`, s.profit); money(ws.getCell(`G${r}`));
    f(ws.getCell(`H${r}`), `IF(E${r}=0,0,G${r}/E${r})`, s.margin ?? 0); ws.getCell(`H${r}`).numFmt = PCT;
    r++;
  }

  // Cached % results, computed now that every row is known.
  ws.eachRow(row => {
    const c = row.getCell(6);
    const v = c.value as any;
    if (v && typeof v === 'object' && 'formula' in v && /\$E\$6/.test(v.formula)) {
      const e = row.getCell(5).value as any;
      const n = typeof e === 'object' && e ? Number(e.result ?? 0) : Number(e ?? 0);
      c.value = { formula: v.formula, result: figs.gross ? n / figs.gross : 0 } as any;
    }
  });

  ws.getColumn(8).alignment = { wrapText: true, vertical: 'top' };
  wb.views = [{ activeTab: 1 } as any];
  return wb;
}
