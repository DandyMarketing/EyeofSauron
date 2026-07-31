import { parseFilename } from '../parsers/revel/index.js';

const testFiles = [
  'Hourly_Sales_Report_neonpigeon_neonpigeon_2026-07-30_2026-07-31.xlsx',
  'Hourly_Sales_Report_fatprincepteltd_fatprince_2026-07-30_2026-07-31.xlsx',
  'Hourly_Sales_Report_superfirangi_superfirangi_2026-07-30_2026-07-31.xlsx',
  'Hourly_Sales_Report_neon-pigeon_neon-pigeon_2026-07-30_2026-07-31_1.xlsx',
];

for (const f of testFiles) {
  try {
    const meta = parseFilename(f);
    console.log(f, '→', JSON.stringify(meta));
  } catch (e: any) {
    console.log(f, '→ ERROR:', e.message);
  }
}
