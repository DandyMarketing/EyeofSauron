import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { parseFilename, parseProductMix, parseOperationsReport, parseHourlySalesXlsx, parseHourlySalesCsv, reconcile } from './parsers/revel/index.js';
import { resolveVenueId, resolveVenueSlug, ingestProductMix, ingestOperations, ingestHourlySales } from './ingest/revel.js';
import { logIngestion, checkDataGaps } from './ingest/log.js';
import { askSauron } from './ai/engine.js';
import { noteVenueAllowed, knowledgeHealth } from './ai/knowledge.js';
import { validateSession, listUsers, inviteUser, assignRole, removeRole, deleteUser, resetUserPassword, supabaseAdmin } from './auth/session.js';
import type { ChatMessage } from './ai/engine.js';
import type { SessionUser } from './auth/session.js';
import type { ProductMixRow, OperationsData, HourlySalesData } from './parsers/revel/types.js';

const app = new Hono();

app.use('/ask', cors());
app.use('/api/*', cors());
app.use('/admin/api/*', cors());

// --- Public config endpoint (anon key + URL for frontend auth) ---

app.get('/api/config', (c) => {
  return c.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// --- Ingest auth (API key) ---

const API_KEY = process.env.INGEST_API_KEY;

app.use('/ingest/*', async (c, next) => {
  if (!API_KEY) return next();
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${API_KEY}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// --- User auth middleware (session token) ---

async function requireAuth(c: any): Promise<SessionUser | null> {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return validateSession(token);
}

async function requireOwner(c: any): Promise<SessionUser | null> {
  const user = await requireAuth(c);
  if (!user || !user.isOwner) return null;
  return user;
}

// --- Health ---

app.get('/health', (c) => c.json({ status: 'ok', service: 'eyeofsauron' }));

// Which build is actually live. A deploy pointing at a stale branch is
// otherwise invisible from the outside -- the app answers normally, just with
// old tools. `tools` lists the AI tool names in this build, so a missing tool
// is diagnosable without reading deploy logs.
app.get('/version', async (c) => {
  const { queryTools } = await import('./ai/tools.js');
  return c.json({
    service: 'eyeofsauron',
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
    branch: process.env.RAILWAY_GIT_BRANCH ?? 'unknown',
    deployed_at: process.env.RAILWAY_DEPLOYMENT_ID ? undefined : 'local',
    tools: queryTools.map(t => t.name),
  });
});

// --- Auth info ---

app.get('/api/me', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated' }, 401);
  return c.json({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    venues: user.venues,
    isOwner: user.isOwner,
  });
});

// --- Ingest (unchanged) ---

app.post('/ingest/revel', async (c) => {
  const body = await c.req.parseBody({ all: true });

  let uploads = body['files'];
  if (!uploads) return c.json({ error: 'No files provided. Send as multipart field "files".' }, 400);
  if (!Array.isArray(uploads)) uploads = [uploads];

  const files = uploads.filter((f): f is File => f instanceof File);
  if (files.length === 0) return c.json({ error: 'No valid files found in upload.' }, 400);

  const results: Array<{ filename: string; status: string; detail?: string }> = [];

  const parsed: Array<{
    filename: string;
    venueKey: string;
    businessDate: string;
    productMix?: ProductMixRow[];
    operations?: OperationsData;
    hourlySales?: HourlySalesData;
  }> = [];

  for (const file of files) {
    try {
      const meta = parseFilename(file.name);

      if (meta.reportType === 'product_mix') {
        const content = await file.text();
        parsed.push({ filename: file.name, venueKey: meta.venueKey, businessDate: meta.businessDate, productMix: parseProductMix(content) });
      } else if (meta.reportType === 'hourly_sales') {
        const ext = file.name.split('.').pop()?.toLowerCase();
        let hourlySales: HourlySalesData;
        if (ext === 'xlsx') {
          const buf = Buffer.from(await file.arrayBuffer());
          hourlySales = parseHourlySalesXlsx(buf);
        } else {
          hourlySales = parseHourlySalesCsv(await file.text());
        }
        parsed.push({ filename: file.name, venueKey: meta.venueKey, businessDate: meta.businessDate, hourlySales });
      } else {
        const content = await file.text();
        parsed.push({ filename: file.name, venueKey: meta.venueKey, businessDate: meta.businessDate, operations: parseOperationsReport(content) });
      }
    } catch (e: any) {
      results.push({ filename: file.name, status: 'parse_error', detail: e.message });
      await logIngestion({ filename: file.name, report_type: 'product_mix', status: 'parse_error', error_message: e.message });
    }
  }

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
      if (pm) {
        results.push({ filename: pm.filename, status: 'error', detail: e.message });
        await logIngestion({ venue_key: venueKey, business_date: businessDate, filename: pm.filename, report_type: 'product_mix', status: 'unknown_venue', error_message: e.message });
      }
      if (ops) {
        results.push({ filename: ops.filename, status: 'error', detail: e.message });
        await logIngestion({ venue_key: venueKey, business_date: businessDate, filename: ops.filename, report_type: 'operations', status: 'unknown_venue', error_message: e.message });
      }
      continue;
    }

    if (pm?.productMix && ops?.operations) {
      const recon = reconcile(pm.productMix, ops.operations);
      if (!recon.passed) {
        const detail = `diff $${recon.difference.toFixed(2)}`;
        results.push({ filename: pm.filename, status: 'reconciliation_failed', detail });
        results.push({ filename: ops.filename, status: 'reconciliation_failed', detail });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: pm.filename, report_type: 'product_mix', status: 'reconciliation_failed', error_message: detail });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: ops.filename, report_type: 'operations', status: 'reconciliation_failed', error_message: detail });
        continue;
      }
    }

    if (pm?.productMix) {
      try {
        const count = await ingestProductMix(venueId, businessDate, pm.productMix);
        results.push({ filename: pm.filename, status: 'ingested', detail: `${count} rows` });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: pm.filename, report_type: 'product_mix', status: 'success', row_count: count });
      } catch (e: any) {
        results.push({ filename: pm.filename, status: 'error', detail: e.message });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: pm.filename, report_type: 'product_mix', status: 'ingestion_error', error_message: e.message });
      }
    }

    if (ops?.operations) {
      try {
        const opsRows = await ingestOperations(venueId, businessDate, ops.operations);
        results.push({ filename: ops.filename, status: 'ingested', detail: `${opsRows} sales-by-class rows` });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: ops.filename, report_type: 'operations', status: 'success', row_count: opsRows });
      } catch (e: any) {
        results.push({ filename: ops.filename, status: 'error', detail: e.message });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: ops.filename, report_type: 'operations', status: 'ingestion_error', error_message: e.message });
      }
    }
  }

  const hourlyFiles = parsed.filter(p => p.hourlySales);
  for (const hf of hourlyFiles) {
    let venueId: string;
    try {
      venueId = await resolveVenueId(hf.venueKey);
    } catch (e: any) {
      results.push({ filename: hf.filename, status: 'error', detail: e.message });
      await logIngestion({ venue_key: hf.venueKey, business_date: hf.businessDate, filename: hf.filename, report_type: 'hourly_sales', status: 'unknown_venue', error_message: e.message });
      continue;
    }

    try {
      const venueSlug = await resolveVenueSlug(venueId);
      const count = await ingestHourlySales(venueId, venueSlug, hf.businessDate, hf.hourlySales!);
      results.push({ filename: hf.filename, status: 'ingested', detail: `${count} hours` });
      await logIngestion({ venue_id: venueId, venue_key: hf.venueKey, business_date: hf.businessDate, filename: hf.filename, report_type: 'hourly_sales', status: 'success', row_count: count });
    } catch (e: any) {
      results.push({ filename: hf.filename, status: 'error', detail: e.message });
      await logIngestion({ venue_id: venueId, venue_key: hf.venueKey, business_date: hf.businessDate, filename: hf.filename, report_type: 'hourly_sales', status: 'ingestion_error', error_message: e.message });
    }
  }

  const hasErrors = results.some(r => r.status !== 'ingested');
  return c.json({ results }, hasErrors ? 207 : 200);
});

// --- AI query endpoint (auth required) ---

app.post('/ask', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const body = await c.req.json<{ question: string; history?: ChatMessage[] }>();
  if (!body.question) return c.json({ error: 'Missing "question" field' }, 400);

  try {
    const venueFilter = user.isOwner ? undefined : user.venues.map(v => v.slug);
    const result = await askSauron(body.question, body.history ?? [], venueFilter);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// --- Admin API (owner only) ---

app.get('/admin/api/users', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);
  const users = await listUsers();
  return c.json({ users });
});

app.post('/admin/api/users/invite', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { email, full_name, password } = await c.req.json();
  if (!email || !password) return c.json({ error: 'Email and password required' }, 400);

  try {
    const invited = await inviteUser(email, full_name ?? '', password);
    return c.json({ user: { id: invited.id, email: invited.email } });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/admin/api/users/:userId/roles', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const userId = c.req.param('userId');
  const { venue_id, role } = await c.req.json();
  if (!venue_id || !role) return c.json({ error: 'venue_id and role required' }, 400);

  try {
    const result = await assignRole(userId, venue_id, role);
    return c.json({ role: result });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.delete('/admin/api/roles/:roleId', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  try {
    await removeRole(c.req.param('roleId'));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.delete('/admin/api/users/:userId', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const userId = c.req.param('userId');
  if (userId === user.id) return c.json({ error: 'Cannot delete yourself' }, 400);

  try {
    await deleteUser(userId);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/admin/api/users/:userId/reset-password', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { password } = await c.req.json();
  if (!password) return c.json({ error: 'Password required' }, 400);

  try {
    await resetUserPassword(c.req.param('userId'), password);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- Venue notes (AI context) ---

// --- Knowledge layer ---
//
// Notes are accumulated operator judgment. Anyone may propose one; only an
// owner may approve it into the knowledge base. That review step is the point:
// the system must never write its own lessons, because a confident wrong
// answer then becomes a permanent stored fact. BUILD_LOG 1.1 is the example --
// a paging bug was reported as a finding about the business, and would have
// been saved as one.

const NOTE_FIELDS =
  'id, venue_id, note, category, confidence, portability, status, source, review_by, author_id, created_at, venues(name)';

app.get('/admin/api/notes', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const status = c.req.query('status');
  let query = supabaseAdmin.from('venue_notes').select(NOTE_FIELDS);
  if (status) query = query.eq('status', status);

  const { data } = await query.order('created_at', { ascending: false });

  // Flag notes past their re-confirmation date so the admin screen can show a
  // review list without duplicating the staleness rule in the front end.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
  const notes = (data ?? []).map((n: any) => ({
    ...n,
    needs_review: n.review_by !== null && n.review_by < today,
  }));

  return c.json({ notes });
});

app.post('/admin/api/notes', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { venue_id, note, category, confidence, portability, review_by } = await c.req.json();
  if (!note) return c.json({ error: 'Note text required' }, 400);

  const { data, error } = await supabaseAdmin
    .from('venue_notes')
    .insert({
      venue_id: venue_id || null,
      note,
      category: category || 'general',
      confidence: confidence || 'observed',
      // Defaults to the safe direction: a note does not travel to another
      // customer unless someone says it is general F&B truth.
      portability: portability || 'dandy_specific',
      review_by: review_by || null,
      author_id: user.id,
      source: 'manual',
      status: 'approved', // entered by an owner, which is itself the approval
    })
    .select(NOTE_FIELDS)
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ note: data });
});

/**
 * Teach Sauron — capture a lesson from anyone, for review.
 *
 * Deliberately open to any authenticated user: the expertise worth capturing
 * is spoken by people who are not owners, and proposing costs nothing because
 * nothing reaches a prompt before approval.
 */
app.post('/api/notes/capture', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const { venue_id, note, category, confidence } = await c.req.json();
  if (!note || typeof note !== 'string' || !note.trim()) {
    return c.json({ error: 'Note text required' }, 400);
  }

  const venueId = venue_id || null;
  if (!noteVenueAllowed(user, venueId)) {
    return c.json({ error: 'You do not have access to that venue.' }, 403);
  }

  const { data, error } = await supabaseAdmin
    .from('venue_notes')
    .insert({
      venue_id: venueId,
      note: note.trim(),
      category: category || 'general',
      confidence: confidence || 'observed',
      portability: 'dandy_specific',
      author_id: user.id,
      source: 'captured',
      status: 'pending', // never reaches a prompt until an owner approves it
    })
    .select(NOTE_FIELDS)
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ note: data, message: 'Captured — an owner will review it before Sauron uses it.' });
});

/** Approve, reject, or retire a note. Owner only. */
app.post('/admin/api/notes/:noteId/review', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { status, confidence, portability, review_by, note } = await c.req.json();
  if (!['approved', 'rejected', 'retired'].includes(status)) {
    return c.json({ error: 'status must be approved, rejected or retired' }, 400);
  }

  // A reviewer may correct the note as they approve it -- that edit is the
  // senior's judgment being applied, which is the whole point of the queue.
  const update: Record<string, unknown> = { status };
  if (typeof note === 'string' && note.trim()) update.note = note.trim();
  if (confidence) update.confidence = confidence;
  if (portability) update.portability = portability;
  if (review_by !== undefined) update.review_by = review_by || null;

  const { data, error } = await supabaseAdmin
    .from('venue_notes')
    .update(update)
    .eq('id', c.req.param('noteId'))
    .select(NOTE_FIELDS)
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ note: data });
});

app.delete('/admin/api/notes/:noteId', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { error } = await supabaseAdmin
    .from('venue_notes')
    .delete()
    .eq('id', c.req.param('noteId'));

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

app.get('/admin/api/venues', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { data } = await supabaseAdmin.from('venues').select('id, name, slug');
  return c.json({ venues: data ?? [] });
});

app.get('/admin/api/system', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const days = Number(c.req.query('days') ?? 3);
  const report = await checkDataGaps(days);

  const { data: recentLogs } = await supabaseAdmin
    .from('ingestion_log')
    .select('filename, report_type, status, row_count, created_at, business_date')
    .order('created_at', { ascending: false })
    .limit(20);

  return c.json({ ...report, recent_ingestions: recentLogs ?? [] });
});

// --- Watchdog (public for monitoring) ---

app.get('/watchdog', async (c) => {
  const days = Number(c.req.query('days') ?? 3);
  const report = await checkDataGaps(days);
  // A knowledge layer that has silently stopped being readable looks exactly
  // like one nobody has written to yet, so it is checked here rather than
  // left to a log line.
  const knowledge = await knowledgeHealth();
  const healthy =
    report.missing.length === 0 && report.recent_errors.length === 0 && knowledge.ok;
  return c.json({ healthy, knowledge, ...report });
});

// --- Static frontend ---

app.use('/*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`EyeofSauron API listening on :${port}`);
});
