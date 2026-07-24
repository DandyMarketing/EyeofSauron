import type { FilenameMetadata } from './types.js';

const FILENAME_RE =
  /^(Product_Mix(?:_Daily)?_Report|Operations_Report)_(.+)_(\d{8})_(\d{8})\.(csv|xlsx)$/;

export function parseFilename(filename: string): FilenameMetadata {
  const match = filename.match(FILENAME_RE);
  if (!match) {
    throw new Error(`Unrecognised Revel filename format: ${filename}`);
  }

  const [, reportPrefix, venueKey, startDate, endDate] = match;

  const reportType: FilenameMetadata['reportType'] =
    reportPrefix.startsWith('Product_Mix') ? 'product_mix' : 'operations';

  const y = startDate.slice(0, 4);
  const m = startDate.slice(4, 6);
  const d = startDate.slice(6, 8);
  const businessDate = `${y}-${m}-${d}`;

  return {
    reportType,
    venueKey,
    businessDate,
    startDateRaw: startDate,
    endDateRaw: endDate,
    originalFilename: filename,
  };
}
