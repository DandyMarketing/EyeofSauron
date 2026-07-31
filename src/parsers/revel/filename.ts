import type { FilenameMetadata } from './types.js';

// Handles both date formats: YYYYMMDD and YYYY-MM-DD, optional trailing _1 suffix
const FILENAME_RE =
  /^(Product_Mix(?:_Daily)?_Report|Operations_Report|Hourly_Sales_Report)_(.+)_(\d{4}-?\d{2}-?\d{2})_(\d{4}-?\d{2}-?\d{2})(?:_\d+)?\.(csv|xlsx)$/;

function normaliseDate(raw: string): string {
  const digits = raw.replace(/-/g, '');
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export function parseFilename(filename: string): FilenameMetadata {
  const match = filename.match(FILENAME_RE);
  if (!match) {
    throw new Error(`Unrecognised Revel filename format: ${filename}`);
  }

  const [, reportPrefix, venueKey, startDate, endDate] = match;

  const reportType: FilenameMetadata['reportType'] =
    reportPrefix.startsWith('Product_Mix') ? 'product_mix'
    : reportPrefix.startsWith('Hourly_Sales') ? 'hourly_sales'
    : 'operations';

  const businessDate = normaliseDate(startDate);

  return {
    reportType,
    venueKey,
    businessDate,
    startDateRaw: startDate,
    endDateRaw: endDate,
    originalFilename: filename,
  };
}
