import { parse } from 'csv-parse/sync';
import type {
  OperationsData,
  SalesByClassRow,
  PaymentRow,
  DiscountReasonRow,
  VoidCompReasonRow,
} from './types.js';

function num(value: string | undefined): number {
  if (!value) return 0;
  const cleaned = value.trim().replace(/[%,]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function splitSections(content: string): string[][] {
  const lines = content.split('\n');
  const sections: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        sections.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current);
  }
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
    class: r[0]?.trim() ?? '',
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

const TOP_LEVEL_PAYMENTS = new Set([
  'Cash', 'Credit', 'Debit', 'House Account', 'Other', 'Custom Payment', 'Grand Total',
]);

function parsePayments(rows: string[][]): PaymentRow[] {
  let parentType: string | null = null;
  return rows.slice(1).map(r => {
    const type = r[0]?.trim() ?? '';
    const isTop = TOP_LEVEL_PAYMENTS.has(type);
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
      reason: r[0]?.trim() ?? '',
      qty: num(r[1]),
      total: num(r[2]),
    }));
}

function parseVoidCompReasons(rows: string[][]): VoidCompReasonRow[] {
  return rows.slice(1).map(r => ({
    reason: r[0]?.trim() ?? '',
    type: r[1]?.trim() ?? '',
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
