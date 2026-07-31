export interface FilenameMetadata {
  reportType: 'product_mix' | 'operations' | 'hourly_sales';
  venueKey: string;
  businessDate: string; // YYYY-MM-DD
  startDateRaw: string; // YYYYMMDD
  endDateRaw: string;
  originalFilename: string;
}

export interface ProductMixRow {
  rowType: 'Product' | 'Modifier';
  class: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  subcategory: string | null;
  parentProduct: string | null;
  qty: number;
  weight: number;
  nonTaxableSales: number;
  taxableSales: number;
  sales: number;
  pctTotal: number;
  cogs: number;
}

export interface SalesByClassRow {
  class: string;
  rawQty: number;
  rawSales: number;
  voidsQty: number;
  voidsAmount: number;
  compsQty: number;
  compsAmount: number;
  grossSales: number;
  itemDisc: number;
  orderDisc: number;
  netTotals: number;
}

export interface PaymentRow {
  type: string;
  qty: number;
  sales: number;
  deposits: number;
  houseAccounts: number;
  refunds: number;
  tips: number;
  total: number;
  isSubType: boolean;
  parentType: string | null;
}

export interface DiscountReasonRow {
  reason: string;
  qty: number;
  total: number;
}

export interface VoidCompReasonRow {
  reason: string;
  type: string;
  qty: number;
  total: number;
}

export interface OperationsData {
  salesByClass: SalesByClassRow[];
  grossProductSales: {
    taxedGrossSales: number;
    untaxedGrossSales: number;
    taxedServiceFee: number;
    untaxedServiceFee: number;
    total: number;
  };
  discounts: {
    itemDiscounts: number;
    orderDiscounts: number;
    coupons: number;
    total: number;
  };
  netSales: {
    taxedNetSales: number;
    untaxedNetSales: number;
    totalSales: number;
  };
  taxes: {
    taxOnSales: number;
    taxOnServiceFee: number;
    taxTotal: number;
  };
  tipsTotal: number;
  netToAccountFor: number;
  payments: PaymentRow[];
  servicePerformance: {
    totalTransactions: number;
    avgCheck: number;
    totalGuests: number;
    avgSalePerGuest: number;
  };
  discountReasons: DiscountReasonRow[];
  voidCompReasons: VoidCompReasonRow[];
}

export interface HourlySalesRow {
  hour: number; // 0-23
  timeLabel: string; // "12:00 PM - 12:59 PM"
  transactions: number;
  items: number;
  avgCheck: number | null;
  sales: number;
  pctSales: number;
}

export interface MealPeriodSummary {
  period: 'lunch' | 'brunch' | 'dinner';
  transactions: number;
  items: number;
  sales: number;
  pctSales: number;
  avgCheck: number | null;
}

export interface HourlySalesData {
  hours: HourlySalesRow[];
  totals: {
    transactions: number;
    items: number;
    avgCheck: number | null;
    sales: number;
  };
}

export interface ReconciliationResult {
  passed: boolean;
  productMixGrossSales: number;
  operationsGrossSales: number;
  difference: number;
  tolerance: number;
}
