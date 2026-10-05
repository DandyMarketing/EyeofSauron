import { parse } from 'csv-parse/sync';
import type {
  OperationsData,
  SalesByClassRow,
  PaymentRow,
  DiscountReasonRow,
  VoidCompReasonRow,
} from './types.js';

/**
 * A free-text label, safe to put in a row.
 *
 * `.trim()` is not enough, because the whole point of the fix below is that
 * these fields can legitimately contain newlines — somebody typed a discount
 * reason over three lines in Revel and it arrives as `Josh\n\nRunaway`. The
 * line break carries no information, and it does carry a cost: the system
 * prompt requires a markdown TABLE for anything past about three numbers, and
 * a newline inside a cell ends the table there.
 *
 * So internal whitespace is collapsed rather than preserved. This is only ever
 * applied to a human-typed label, never to a figure.
 */
function label(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function num(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.trim().replace(/[%,]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Split the report into its sections, WITHOUT cutting a quoted field in half.
 *
 * WHY THIS IS NOT `content.split('\n')`. Revel's operations report is a dozen
 * little tables separated by blank lines, so splitting on a blank line is the
 * obvious reading — and it is wrong, because a blank line can legitimately
 * appear INSIDE a quoted CSV field. RFC 4180 allows it, Revel emits it, and
 * csv-parse handles it correctly; only the pre-split did not.
 *
 * It cost a day of trade. Neon Pigeon, 29 Sep 2026: somebody had typed a
 * discount reason with a line break in it —
 *
 *     Dandy Family,5,65.50
 *     "Josh
 *                              <- a blank line, inside the quotes
 *     Runaway",1,42.00
 *
 * — so the section was cut after `"Josh`, csv-parse was handed an unclosed
 * quote, and the WHOLE FILE was rejected with "Quote Not Closed ... at line 4"
 * (line four of that section, which is why the number looked unrelated to
 * anything). Nothing was ingested, and the report said the file was damaged
 * when the file was fine.
 *
 * So the scan tracks quote state and only treats a line ending as a line
 * ending when it is outside one. `""` is an escaped quote inside a field and
 * does not toggle anything.
 *
 * RECURS AT EVERY CUSTOMER. Any free-text field somebody can type a newline
 * into — a discount reason, a void reason, a product name — does this, and it
 * rejects the day's entire report rather than one row.
 */
export function splitSections(content: string): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  let line = '';
  let inQuotes = false;

  const endLine = () => {
    if (line.trim() === '') {
      // A real section break, only ever reached outside a quoted field.
      if (current.length > 0) {
        sections.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
    line = '';
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (ch === '"') {
      // A doubled quote is an escaped quote within a field, not a delimiter.
      if (inQuotes && content[i + 1] === '"') {
        line += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      line += ch;
      continue;
    }

    if (ch === '\r' && content[i + 1] === '\n') continue;   // normalise CRLF

    if (ch === '\n' && !inQuotes) {
      endLine();
      continue;
    }

    line += ch;
  }

  // Whatever is left when the file ends, including a final line with no newline.
  if (line !== '') current.push(line);
  if (current.length > 0) sections.push(current);

  return sections;
}

function parseCSVRows(lines: string[]): string[][] {
  return parse(lines.join('\n'), {
    relax_column_count: true,
    relax_quotes: true,
  });
}

function sectionName(rows: string[][]): string {
  return (rows[0]?.[0] ?? '').trim().replace(/^"|"$/g, '').toUpperCase();
}

function findKV(rows: string[][], label: string): number {
  // Skip row 0 (header) — avoids collisions when section name equals a data label
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0]?.trim().toLowerCase().startsWith(label.toLowerCase())) {
      return num(rows[i][1]);
    }
  }
  return 0;
}

function parseSalesByClass(rows: string[][]): SalesByClassRow[] {
  return rows.slice(1).map(r => ({
    class: label(r[0]),
    rawQty: num(r[1]),
    rawSales: num(r[2]),
    voidsQty: num(r[3]),
    voidsAmount: num(r[4]),
    compsQty: num(r[5]),
    compsAmount: num(r[6]),
    grossSales: num(r[7]),
    itemDisc: num(r[8]),
    orderDisc: num(r[9]),
    netTotals: num(r[10]),
  }));
}

/**
 * Which payment rows are a METHOD and which are a card brand underneath one.
 *
 * The report gives no indentation — `American Express` sits flush against
 * `Credit` in the CSV — so the hierarchy has to come from a list, and a list is
 * wrong for anything not on it. `NETS` was missing, which in Singapore is not a
 * detail: it made the country's most common debit rail look like a sub-type of
 * `House Account`, so anything summing `!isSubType` would have dropped it. It
 * was zero at Neon Pigeon on 29 Sep 2026, which is why nothing complained.
 *
 * The same file settles it: the TIPS section lists NETS alongside Cash, Credit
 * and Custom Payment, all methods. The only sub-types here are the card brands.
 *
 * `paymentsReconcile()` below is the guard against the NEXT missing one, since
 * a sub-type wrongly promoted double-counts and a method wrongly demoted
 * vanishes — and both show up as a mismatch against Grand Total.
 */
const TOP_LEVEL_PAYMENTS = new Set([
  'Cash', 'Credit', 'Debit', 'NETS', 'House Account', 'Other', 'Custom Payment', 'Grand Total',
]);

/**
 * Do the payment METHODS add up to the Grand Total the report states?
 *
 * Free, and it is the only check on the hardcoded list above. Returns null when
 * there is no Grand Total row to check against — an absent check and a passing
 * one must not look the same.
 */
export function paymentsReconcile(
  payments: PaymentRow[],
  tolerance = 0.02,
): { passed: boolean; methodsTotal: number; grandTotal: number; difference: number } | null {
  const grand = payments.find(p => p.type.toLowerCase() === 'grand total');
  if (!grand) return null;

  const methodsTotal = payments
    .filter(p => !p.isSubType && p.type.toLowerCase() !== 'grand total')
    .reduce((sum, p) => sum + p.total, 0);

  const difference = Math.abs(methodsTotal - grand.total);
  return {
    passed: difference <= tolerance,
    methodsTotal,
    grandTotal: grand.total,
    difference,
  };
}

/**
 * THE LIST NAMES METHODS; THE ARITHMETIC DECIDES WHEN A LISTED NAME IS A BRAND.
 *
 * Neon Pigeon, 4 Oct 2026: Revel listed a card brand called `Other` under
 * `Credit` -- MasterCard 794.94, Other 502.38, UnionPay 202.63, Visa 1,637.47,
 * summing exactly to Credit's 3,137.42. `Other` is ALSO a payment method name,
 * so the list promoted it and $502.38 was counted twice: methods summed to
 * $4,696.13 against a Grand Total of $4,193.75. The NETS failure in the
 * opposite direction -- and since a name can be both, no list can settle it.
 *
 * The report can: a method's brands sum to the method. A listed name is read
 * as a brand only when PROVEN to be one -- the rows under a method add up to
 * its total exactly, and include at least one ordinary brand name. Anything
 * short of that proof falls back to the list, exactly as before, so this can
 * only ever correct a promotion, never invent one. Two traps the first attempt
 * fell into and the tests now hold:
 *
 *   - a ZERO row "fits" under anything, so `NETS 0.00` after Debit was filed as
 *     a Debit brand. A zero cannot be proven either way and stays on the list.
 *   - a method with no brands at all (Debit, here) leaves its whole total
 *     open, and a running-balance rule would let it swallow the next method.
 *     Requiring an exact sum that includes a real brand closes that.
 */
const ALLOCATION_TOLERANCE = 0.02;

function provenBrands(rows: Array<{ type: string; total: number }>): Set<number> {
  const proven = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const { type, total } = rows[i];
    if (!TOP_LEVEL_PAYMENTS.has(type) || type === 'Grand Total' || proven.has(i)) continue;
    if (Math.abs(total) <= ALLOCATION_TOLERANCE) continue;        // nothing to account for
    let sum = 0, sawBrand = false;
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].type === 'Grand Total') break;
      sum += rows[j].total;
      if (!TOP_LEVEL_PAYMENTS.has(rows[j].type)) sawBrand = true;
      if (Math.abs(sum - total) <= ALLOCATION_TOLERANCE) {
        if (sawBrand) for (let k = i + 1; k <= j; k++) proven.add(k);
        break;
      }
    }
  }
  return proven;
}

function parsePayments(rows: string[][]): PaymentRow[] {
  const body = rows.slice(1);
  const brands = provenBrands(body.map(r => ({ type: label(r[0]), total: num(r[7]) })));
  let parentType: string | null = null;
  return body.map((r, i) => {
    const type = label(r[0]);
    const isTop = TOP_LEVEL_PAYMENTS.has(type) && !brands.has(i);
    if (isTop) parentType = type;
    return {
      type,
      qty: num(r[1]),
      sales: num(r[2]),
      deposits: num(r[3]),
      houseAccounts: num(r[4]),
      refunds: num(r[5]),
      tips: num(r[6]),
      total: num(r[7]),
      isSubType: !isTop,
      parentType: isTop ? null : parentType,
    };
  });
}

function parseDiscountReasons(rows: string[][]): DiscountReasonRow[] {
  return rows.slice(1)
    .filter(r => r[0]?.trim().toUpperCase() !== 'TOTAL')
    .map(r => ({
      reason: label(r[0]),
      qty: num(r[1]),
      total: num(r[2]),
    }));
}

function parseVoidCompReasons(rows: string[][]): VoidCompReasonRow[] {
  return rows.slice(1).map(r => ({
    reason: label(r[0]),
    type: label(r[1]),
    qty: num(r[2]),
    total: num(r[3]),
  }));
}

function parseTaxAmount(rows: string[][], keyword: string): number {
  for (const row of rows.slice(1)) {
    const label = row[0]?.trim().toLowerCase() ?? '';
    if (label.includes(keyword) && !label.includes('service fee') && !label.includes('rounding') && !label.includes('surcharge') && !label.includes('pass through')) {
      return num(row[2]);
    }
  }
  return 0;
}

function parseTaxOnServiceFee(rows: string[][]): number {
  for (const row of rows.slice(1)) {
    const label = row[0]?.trim().toLowerCase() ?? '';
    if (label.includes('service fee')) {
      return num(row[2]);
    }
  }
  return 0;
}

function parseTaxTotal(rows: string[][]): number {
  for (const row of rows.slice(1)) {
    if (row[0]?.trim().toLowerCase().startsWith('total')) {
      return num(row[2]) || num(row[1]);
    }
  }
  return 0;
}

export function parseOperationsReport(content: string): OperationsData {
  const rawSections = splitSections(content);

  const sectionMap = new Map<string, string[][]>();
  for (const lines of rawSections) {
    const rows = parseCSVRows(lines);
    const name = sectionName(rows);
    sectionMap.set(name, rows);
  }

  const salesRows = sectionMap.get('SALES BY CLASS') ?? [];
  const salesByClass = parseSalesByClass(salesRows);
  const totalRow = salesByClass.find(r => r.class.toLowerCase() === 'total');

  const grossSection = sectionMap.get('GROSS PRODUCT SALES') ?? [];
  const discSection = sectionMap.get('DISCOUNTS') ?? [];
  const netSection = sectionMap.get('NET SALES') ?? [];
  const taxSection = sectionMap.get('TAXES') ?? [];
  const tipsSection = sectionMap.get('TIPS') ?? [];
  const netAcctSection = sectionMap.get('NET TO ACCOUNT FOR') ?? [];
  const paySection = sectionMap.get('PAYMENTS') ?? [];
  const perfSection = sectionMap.get('SERVICE PERFORMANCE') ?? [];
  const discReasonSection = sectionMap.get('DISCOUNT REASON') ?? [];
  const voidSection = sectionMap.get('VOIDS, RETURNS AND COMPS REASON') ?? [];

  const tipsTotal = tipsSection.length > 0
    ? num(tipsSection[tipsSection.length - 1]?.[4] ?? tipsSection[tipsSection.length - 1]?.[3])
    : 0;

  return {
    salesByClass: salesByClass.filter(r => r.class.toLowerCase() !== 'total'),

    grossProductSales: {
      taxedGrossSales: findKV(grossSection, 'Taxed Gross Sales'),
      untaxedGrossSales: findKV(grossSection, 'Untaxed Gross Sales'),
      taxedServiceFee: findKV(grossSection, 'Taxed Service Fee'),
      untaxedServiceFee: findKV(grossSection, 'Untaxed Service Fee'),
      total: findKV(grossSection, 'Total'),
    },

    discounts: {
      itemDiscounts: findKV(discSection, 'Item Discounts'),
      orderDiscounts: findKV(discSection, 'Order Discounts'),
      coupons: findKV(discSection, 'Coupons'),
      total: findKV(discSection, 'Total'),
    },

    netSales: {
      taxedNetSales: findKV(netSection, 'Taxed Net Sales'),
      untaxedNetSales: findKV(netSection, 'Untaxed Net Sales'),
      totalSales: findKV(netSection, 'Total Sales'),
    },

    taxes: {
      taxOnSales: parseTaxAmount(taxSection, '9.000%'),
      taxOnServiceFee: parseTaxOnServiceFee(taxSection),
      taxTotal: parseTaxTotal(taxSection),
    },

    tipsTotal,

    netToAccountFor: findKV(netAcctSection, 'Net To Account For'),

    payments: parsePayments(paySection),

    servicePerformance: {
      totalTransactions: findKV(perfSection, 'Total Transactions'),
      avgCheck: findKV(perfSection, 'Average Check'),
      totalGuests: findKV(perfSection, 'Total Guests'),
      avgSalePerGuest: findKV(perfSection, 'Average Sale Per Guest'),
    },

    discountReasons: parseDiscountReasons(discReasonSection),

    voidCompReasons: parseVoidCompReasons(voidSection),
  };
}
