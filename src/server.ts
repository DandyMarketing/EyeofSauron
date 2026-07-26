import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { parseFilename, parseProductMix, parseOperationsReport, reconcile } from './parsers/revel/index.js';
import { resolveVenueId, ingestProductMix, ingestOperations } from './ingest/revel.js';
import type { ProductMixRow, OperationsData } from './parsers/revel/types.js';

const app = new Hono();

const API_KEY = process.env.INGEST_API_KEY;

app.use('/ingest/*', async (c, next) => {
  if (!API_KEY) return next();
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${API_KEY}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

app.get('/', (c) => c.json({ status: 'ok', service: 'eyeofsauron' }));

app.post('/ingest/revel', async (c) => {
  const body = await c.req.parseBody({ all: true });

  // Accept one or more files under the "files" field
  let uploads = body['files'];
  if (!uploads) return c.json({ error: 'No files provided. Send as multipart field "files".' }, 400);
  if (!Array.isArray(uploads)) uploads = [uploads];

  const files = uploads.filter((f): f is File => f instanceof File);
  if (files.length === 0) return c.json({ error: 'No valid files found in upload.' }, 400);

  const results: Array<{ filename: string; status: string; detail?: string }> = [];

  // Parse all files first
  const parsed: Array<{
    filename: string;
    venueKey: string;
    businessDate: string;
    productMix?: ProductMixRow[];
    operations?: OperationsData;
  }> = [];

  for (const file of files) {
    try {
      const meta = parseFilename(file.name);
      const content = await file.text();

      if (meta.reportType === 'product_mix') {
        parsed.push({ filename: file.name, venueKey: meta.venueKey, businessDate: meta.businessDate, productMix: parseProductMix(content) });
      } else {
        parsed.push({ filename: file.name, venueKey: meta.venueKey, businessDate: meta.businessDate, operations: parseOperationsReport(content) });
      }
    } catch (e: any) {
      results.push({ filename: file.name, status: 'parse_error', detail: e.message });
    }
  }

  // Group by venueKey + businessDate
  const groups = new Map<string, { pm?: typeof parsed[0]; ops?: typeof parsed[0] }>();
  for (const p of parsed) {
    const key = `${p.venueKey}|${p.businessDate}`;
    const group = groups.get(key) ?? {};
    if (p.productMix) group.pm = p;
    if (p.operations) group.ops = p;
    groups.set(key, group);
  }

  for (const [key, { pm, ops }] of groups) {
    const [venueKey, businessDate] = key.split('|');

    let venueId: string;
    try {
      venueId = await resolveVenueId(venueKey);
    } catch (e: any) {
      if (pm) results.push({ filename: pm.filename, status: 'error', detail: e.message });
      if (ops) results.push({ filename: ops.filename, status: 'error', detail: e.message });
      continue;
    }

    // Reconcile if both files present
    if (pm?.productMix && ops?.operations) {
      const recon = reconcile(pm.productMix, ops.operations);
      if (!recon.passed) {
        results.push({ filename: pm.filename, status: 'reconciliation_failed', detail: `diff $${recon.difference.toFixed(2)}` });
        results.push({ filename: ops.filename, status: 'reconciliation_failed', detail: `diff $${recon.difference.toFixed(2)}` });
        continue;
      }
    }

    if (pm?.productMix) {
      try {
        const count = await ingestProductMix(venueId, businessDate, pm.productMix);
        results.push({ filename: pm.filename, status: 'ingested', detail: `${count} rows` });
      } catch (e: any) {
        results.push({ filename: pm.filename, status: 'error', detail: e.message });
      }
    }

    if (ops?.operations) {
      try {
        await ingestOperations(venueId, businessDate, ops.operations);
        results.push({ filename: ops.filename, status: 'ingested' });
      } catch (e: any) {
        results.push({ filename: ops.filename, status: 'error', detail: e.message });
      }
    }
  }

  const hasErrors = results.some(r => r.status !== 'ingested');
  return c.json({ results }, hasErrors ? 207 : 200);
});

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`EyeofSauron API listening on :${port}`);
});
