import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { parseFilename, parseProductMix, parseOperationsReport, parseHourlySalesXlsx, parseHourlySalesCsv, reconcile } from './parsers/revel/index.js';
import { resolveVenueId, resolveVenueSlug, ingestProductMix, ingestOperations, ingestHourlySales, getClosedWeekdays } from './ingest/revel.js';
import { classifyIngestFailure, isEmptyReportError } from './ingest/closures.js';
import { summarisePostLockChange } from './ingest/monday.js';
import { newState, verifyState, buildAuthorizeUrl, exchangeCode, fetchTenants, storeConnection } from './ingest/xero.js';
import { ingestProfitAndLoss } from './ingest/xero-pl.js';
import { discoverAccounts, ingestMetaInsights, probeMetrics, fetchInsights, redactTokens, calibrateDayAlignment } from './ingest/meta.js';
import { loadKey } from './lib/crypto.js';
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

/**
 * Decide what an ingestion failure should be logged as.
 *
 * An empty report from a venue that is shut that weekday is a closure, not an
 * error -- otherwise Firangi's Sundays turn the watchdog permanently red and
 * nobody reads it any more. Anything that cannot be resolved falls back to the
 * caller's original status, so a failure is never quietly downgraded.
 */
async function ingestFailureStatus<T extends string>(
  filename: string,
  message: string,
  fallback: T,
): Promise<T | 'closed'> {
  if (!isEmptyReportError(message)) return fallback;
  try {
    const meta = parseFilename(filename);
    const venueId = await resolveVenueId(meta.venueKey);
    const closed = await getClosedWeekdays(venueId);
    return classifyIngestFailure(message, closed, meta.businessDate, fallback);
  } catch {
    return fallback;
  }
}

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
      const status = await ingestFailureStatus(file.name, e.message, 'parse_error');
      results.push({ filename: file.name, status, detail: e.message });
      await logIngestion({ filename: file.name, report_type: 'product_mix', status, error_message: e.message });
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
        const status = classifyIngestFailure(e.message, await getClosedWeekdays(venueId), businessDate, 'ingestion_error');
        results.push({ filename: pm.filename, status: status === 'closed' ? 'closed' : 'error', detail: e.message });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: pm.filename, report_type: 'product_mix', status, error_message: e.message });
      }
    }

    if (ops?.operations) {
      try {
        const opsRows = await ingestOperations(venueId, businessDate, ops.operations);
        results.push({ filename: ops.filename, status: 'ingested', detail: `${opsRows} sales-by-class rows` });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: ops.filename, report_type: 'operations', status: 'success', row_count: opsRows });
      } catch (e: any) {
        const status = classifyIngestFailure(e.message, await getClosedWeekdays(venueId), businessDate, 'ingestion_error');
        results.push({ filename: ops.filename, status: status === 'closed' ? 'closed' : 'error', detail: e.message });
        await logIngestion({ venue_id: venueId, venue_key: venueKey, business_date: businessDate, filename: ops.filename, report_type: 'operations', status, error_message: e.message });
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

  const { venue_id, note, category, confidence, source_question } = await c.req.json();
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
      // Kept because a note is much harder to judge later without the
      // question that produced it.
      source_question: typeof source_question === 'string' ? source_question.slice(0, 2000) : null,
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

// --- Xero OAuth ---
//
// Owner-only to start, and the callback is protected by a signed state value
// rather than a session, because Xero redirects the browser back with no
// Authorization header. That is normal for OAuth; the state is what stops
// someone handing an operator a crafted callback URL and attaching their own
// Xero organisation to this installation.

function xeroRedirectUri(): string {
  return process.env.XERO_REDIRECT_URI
    ?? 'https://eyeofsauron-production.up.railway.app/xero/callback';
}

/**
 * Returns the URL to send the operator to, rather than redirecting.
 *
 * The admin page holds a bearer token and cannot attach it to a browser
 * navigation, so it fetches this and sets window.location itself. Passing the
 * session token in a query string instead would put it in every proxy and
 * access log between here and Xero.
 */
app.get('/xero/connect', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) return c.json({ error: 'XERO_CLIENT_ID is not set' }, 500);

  try {
    const state = newState(loadKey(process.env.XERO_TOKEN_KEY), Date.now());
    return c.json({ url: buildAuthorizeUrl(clientId, xeroRedirectUri(), state) });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/xero/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const denied = c.req.query('error');

  // The operator can decline on Xero's consent screen. That is a normal
  // outcome, not a failure to debug.
  if (denied) return c.html(`<p>Xero connection cancelled (${denied}). You can close this tab.</p>`, 400);
  if (!code || !state) return c.html('<p>Missing code or state from Xero.</p>', 400);

  try {
    const key = loadKey(process.env.XERO_TOKEN_KEY);
    if (!verifyState(key, state, Date.now())) {
      return c.html('<p>This authorization link is invalid or has expired. Start again from the admin page.</p>', 400);
    }

    const tokens = await exchangeCode(code, xeroRedirectUri());
    const tenants = await fetchTenants(tokens.access_token);
    if (tenants.length === 0) {
      return c.html('<p>Xero reported no organisations for this login. Check the account has access to at least one organisation.</p>', 400);
    }

    await storeConnection(tenants, tokens);

    // Named, not counted: the operator has to recognise these to map them, and
    // the names are legal entities that will not match venue names.
    const list = tenants.map(t => `<li>${t.tenantName}</li>`).join('');
    return c.html(
      `<h3>Xero connected</h3><p>Organisations now available:</p><ul>${list}</ul>` +
      `<p>Each still needs mapping to a venue before anything is ingested — nothing is assumed from the name.</p>`,
    );
  } catch (e: any) {
    return c.html(`<h3>Xero connection failed</h3><pre>${e.message}</pre>`, 500);
  }
});

/** Connected organisations and their venue mapping. Owner only. */
/**
 * What Meta accounts can this token actually reach?
 *
 * Not run on page load: it is several Graph calls and a probe per Instagram
 * account. Triggered from the admin page when someone is actually setting this
 * up, which is the only time the answer changes.
 */
app.get('/admin/api/meta/discover', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  try {
    const result = await discoverAccounts({ probe: c.req.query('probe') !== '0' });
    return c.json(result);
  } catch (e: any) {
    // A missing token throws rather than returning an empty list, and the
    // message says what to do about it -- surface it as-is.
    return c.json({ accounts: [], errors: [String(e?.message ?? e)] });
  }
});

/**
 * Ask Meta which metric names it will accept, per mapped account.
 *
 * One call per candidate per form, so it is slow and deliberately manual. It is
 * run when setting up or when a metric starts failing, not on a schedule.
 */
app.post('/admin/api/meta/probe-metrics', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { data: accounts } = await supabaseAdmin
    .from('social_accounts')
    .select('platform, account_id, account_name')
    .not('venue_id', 'is', null)
    .eq('is_active', true);

  if (!accounts || accounts.length === 0) {
    return c.json({ results: [], error: 'No Meta accounts are mapped to a venue yet.' });
  }

  // One account per platform is enough: the vocabulary is a property of the
  // platform, not of the account. Probing all six would be six times the calls
  // for the same answer.
  const seen = new Set<string>();
  const results = [];
  for (const a of accounts) {
    if (seen.has(a.platform)) continue;
    seen.add(a.platform);
    try {
      results.push({ platform: a.platform, account_name: a.account_name, probes: await probeMetrics(a.platform, a.account_id) });
    } catch (e: any) {
      results.push({ platform: a.platform, account_name: a.account_name, probes: [], error: String(e?.message ?? e) });
    }
  }

  return c.json({ results });
});

/**
 * Return Graph's raw response for one metric, unparsed.
 *
 * The probe answers "will Meta accept this name". It does not answer "what
 * shape comes back", and total_value metrics return an aggregate for the whole
 * window rather than a daily series. Storing one of those against a single
 * business_date would file a month's total as a day's figure -- a wrong number
 * that looks entirely reasonable.
 *
 * So: look at the actual JSON before writing the parser for it.
 */
app.get('/admin/api/meta/sample', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const platform = c.req.query('platform') ?? 'instagram';
  const metric = c.req.query('metric') ?? 'views';
  const form = c.req.query('form') ?? 'total_value';
  const days = Math.min(Math.max(Number(c.req.query('days')) || 3, 1), 10);

  const { data: account } = await supabaseAdmin
    .from('social_accounts')
    .select('account_id, account_name')
    .eq('platform', platform)
    .not('venue_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (!account) return c.json({ error: `No mapped ${platform} account to sample.` });

  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  try {
    const raw = await fetchInsights(
      account.account_id, [metric], since, until,
      form === 'total_value' ? 'total_value' : undefined,
    );
    // Graph echoes the access token back inside paging.next / paging.previous.
    // Never return a Graph response unfiltered.
    return c.json({ account: account.account_name, metric, form, since, until, raw: redactTokens(raw) });
  } catch (e: any) {
    return c.json({ account: account.account_name, metric, form, since, until, error: redactTokens(String(e?.message ?? e)) });
  }
});

/**
 * Measure which day a total_value figure belongs to, rather than assuming it.
 * See calibrateDayAlignment -- an off-by-one here reconciles perfectly and is
 * still wrong on every single day.
 */
app.get('/admin/api/meta/calibrate', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { data: account } = await supabaseAdmin
    .from('social_accounts')
    .select('account_id, account_name')
    .eq('platform', 'instagram')
    .not('venue_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (!account) return c.json({ error: 'No mapped Instagram account to calibrate against.' });

  try {
    return c.json({ account: account.account_name, ...(await calibrateDayAlignment(account.account_id)) });
  } catch (e: any) {
    return c.json({ account: account.account_name, error: redactTokens(String(e?.message ?? e)) });
  }
});

/**
 * Attach a Meta account to a venue. Confirmed by a human, never inferred.
 *
 * "superfirangi" is Firangi Superstar and "fatprincesg" is Fat Prince, which
 * looks obvious enough to automate -- and that is exactly the reasoning that
 * produced BUILD_LOG 2.2. A handle is not a venue name, and the one time it is
 * not obvious is the time the figures land against the wrong business.
 */
app.post('/admin/api/meta/map', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const { platform, account_id, account_name, venue_id } = body ?? {};

  if (typeof platform !== 'string' || typeof account_id !== 'string' || !account_id) {
    return c.json({ error: 'platform and account_id are required' }, 400);
  }
  if (typeof venue_id !== 'string' || !venue_id) {
    return c.json({ error: 'venue_id is required' }, 400);
  }

  const { error } = await supabaseAdmin
    .from('social_accounts')
    .upsert(
      { platform, account_id, account_name: account_name ?? null, venue_id, is_active: true },
      { onConflict: 'platform,account_id' },
    );

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ mapped: { platform, account_id, venue_id } });
});

/**
 * Pull social metrics for every mapped account over a date range.
 *
 * One account failing does not stop the others, and each result carries its own
 * error, because "the run failed" tells nobody which venue lost a week.
 */
app.post('/admin/api/meta/ingest', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const body = await c.req.json().catch(() => ({}));
  const days = Math.min(Math.max(Number(body?.days) || 30, 1), 90);
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const { data: accounts } = await supabaseAdmin
    .from('social_accounts')
    .select('platform, account_id, account_name, venue_id')
    .not('venue_id', 'is', null)
    .eq('is_active', true);

  if (!accounts || accounts.length === 0) {
    return c.json({ results: [], error: 'No Meta accounts are mapped to a venue yet.' });
  }

  const results = [];
  for (const a of accounts) {
    try {
      results.push({ account_name: a.account_name, ...(await ingestMetaInsights(a.platform, a.account_id, since, until)) });
    } catch (e: any) {
      results.push({
        account_name: a.account_name,
        platform: a.platform,
        account_id: a.account_id,
        stored: false,
        error: String(e?.message ?? e),
      });
    }
  }

  return c.json({ since, until, results });
});

app.get('/admin/api/xero/connections', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { data } = await supabaseAdmin
    .from('xero_connections')
    .select('id, tenant_id, tenant_name, venue_id, status, last_error, connected_at, last_refreshed_at, venues(name, slug)')
    .order('connected_at', { ascending: false });

  return c.json({ connections: data ?? [] });
});

/** Map a Xero organisation to a venue. Confirmed by a human, never inferred. */
app.post('/admin/api/xero/connections/:id/venue', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { venue_id } = await c.req.json();
  if (!venue_id) return c.json({ error: 'venue_id required' }, 400);

  const { data, error } = await supabaseAdmin
    .from('xero_connections')
    .update({ venue_id, status: 'active', updated_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .select('id, tenant_id, tenant_name, venue_id, status')
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ connection: data });
});

/**
 * Pull a P&L period for one connected organisation.
 *
 * Returns the reconciliation result whether or not it stored anything: a
 * period that failed the check is the single most important thing to surface,
 * because the alternative is a plausible wrong P&L nobody questions.
 */
app.post('/admin/api/xero/ingest', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { tenant_id, from_date, to_date } = await c.req.json();
  if (!tenant_id || !from_date || !to_date) {
    return c.json({ error: 'tenant_id, from_date and to_date are required' }, 400);
  }

  try {
    const result = await ingestProfitAndLoss(tenant_id, from_date, to_date);
    return c.json(result, result.stored ? 200 : 422);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

/** Unresolved reconciliation alerts, newest first. Owner only. */
app.get('/admin/api/alerts', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { data } = await supabaseAdmin
    .from('reconciliation_alerts')
    .select('id, venue_id, business_date, alert_type, monday_gross, revel_gross, difference, old_meal_periods, new_meal_periods, created_at, venues(name)')
    .eq('resolved', false)
    .order('business_date', { ascending: false });

  // One card per finding, not per row.
  //
  // De-duplication at write time only stops NEW duplicates. Alerts raised
  // before it existed sit in the table several deep for a single issue -- Neon
  // Pigeon, 30 July was four identical cards -- which buries the real findings
  // under repeats of one of them and makes the list something nobody reads.
  //
  // Say what actually moved, too. "Something changed on 30 July" leaves someone
  // diffing two boards by eye; the gap between a $2 service-charge correction
  // and a $4,000 revenue edit is what decides whether to investigate.
  const grouped = new Map<string, any>();
  for (const a of (data ?? []) as any[]) {
    const key = `${a.venue_id}|${a.business_date}|${a.alert_type}`;
    const seen = grouped.get(key);
    if (seen) { seen.duplicates++; continue; }
    grouped.set(key, {
      id: a.id,
      duplicates: 1,
      venue: a.venues?.name ?? 'Unknown venue',
      business_date: a.business_date,
      alert_type: a.alert_type,
      monday_gross: a.monday_gross,
      revel_gross: a.revel_gross,
      difference: a.difference,
      created_at: a.created_at,
      changes: a.alert_type === 'post_lock_change'
        ? summarisePostLockChange(a.old_meal_periods, a.new_meal_periods)
        : [],
    });
  }

  return c.json({ alerts: [...grouped.values()], total_rows: (data ?? []).length });
});

/**
 * Mark an alert dealt with.
 *
 * Resolution is what makes the alert list mean something. Without it every
 * finding accumulates forever, the watchdog is permanently red, and a red that
 * is always on is one nobody reads -- which is how the Monday cron went four
 * days without anyone noticing.
 */
app.post('/admin/api/alerts/:id/resolve', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const body = await c.req.json().catch(() => ({}));

  // Resolve the finding, not the row. The list groups duplicates into one card,
  // so resolving that card has to clear every row behind it -- otherwise three
  // of the four reappear on reload and the alert looks unresolvable.
  const { data: target, error: findError } = await supabaseAdmin
    .from('reconciliation_alerts')
    .select('venue_id, business_date, alert_type')
    .eq('id', c.req.param('id'))
    .single();

  if (findError || !target) return c.json({ error: 'Alert not found' }, 404);

  const { data, error } = await supabaseAdmin
    .from('reconciliation_alerts')
    .update({
      resolved: true,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      notes: typeof body.notes === 'string' ? body.notes : null,
    })
    .eq('venue_id', target.venue_id)
    .eq('business_date', target.business_date)
    .eq('alert_type', target.alert_type)
    .eq('resolved', false)
    .select('id');

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ resolved: data?.length ?? 0, ...target });
});

app.get('/watchdog', async (c) => {
  const days = Number(c.req.query('days') ?? 3);
  const report = await checkDataGaps(days);
  // A knowledge layer that has silently stopped being readable looks exactly
  // like one nobody has written to yet, so it is checked here rather than
  // left to a log line.
  const knowledge = await knowledgeHealth();
  // Open reconciliation alerts count against health -- they are real problems
  // with the numbers. They are resolvable by a human, which is what keeps this
  // from becoming a permanently-red signal nobody reads.
  const healthy =
    report.missing.length === 0 &&
    report.recent_errors.length === 0 &&
    report.open_alerts.length === 0 &&
    knowledge.ok;
  return c.json({ healthy, knowledge, ...report });
});

// --- Static frontend ---

/**
 * Make the browser re-check the HTML on every load.
 *
 * We were sending no Cache-Control at all, so browsers fell back to heuristic
 * caching off Last-Modified and held the admin page for hours. The effect is
 * nasty because it is partial: the SERVER updates immediately, so someone runs
 * last week's page against this week's API and sees new error messages from
 * buttons that are missing. It cost two rounds of "where is this button?"
 * before anyone suspected the cache.
 *
 * Only the HTML shell revalidates. Everything else keeps default caching --
 * the shell is the app, not an asset.
 */
app.use('/*', async (c, next) => {
  await next();
  const last = c.req.path.split('/').pop() ?? '';
  const isShell = last === '' || last.endsWith('.html') || !last.includes('.');
  if (!isShell) return;

  // Rebuilt rather than mutated: a Response's headers are immutable once it
  // has been constructed, so setting on c.res directly silently does nothing.
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set('Cache-Control', 'no-cache, must-revalidate');
});

app.use('/*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`EyeofSauron API listening on :${port}`);
});
