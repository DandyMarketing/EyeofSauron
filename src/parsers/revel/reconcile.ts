import type { ProductMixRow, OperationsData, ReconciliationResult } from './types.js';

const DEFAULT_TOLERANCE = 1.0; // $1 tolerance for rounding

export function reconcile(
  productMix: ProductMixRow[],
  operations: OperationsData,
  tolerance = DEFAULT_TOLERANCE,
): ReconciliationResult {
  const productSales = productMix
    .filter(r => r.rowType === 'Product')
    .reduce((sum, r) => sum + r.sales, 0);

  const opsGross = operations.grossProductSales.taxedGrossSales
    + operations.grossProductSales.untaxedGrossSales;

  const difference = Math.abs(productSales - opsGross);

  return {
    passed: difference <= tolerance,
    productMixGrossSales: productSales,
    operationsGrossSales: opsGross,
    difference,
    tolerance,
  };
}
