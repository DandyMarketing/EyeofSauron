import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { streamSSE } from 'hono/streaming';
import { injectConfig } from './lib/inject-config.js';
import { parseFilename, parseProductMix, parseOperationsReport, parseHourlySalesXlsx, parseHourlySalesCsv, reconcile } from './parsers/revel/index.js';
import { resolveVenueId, resolveVenueSlug, ingestProductMix, ingestOperations, ingestHourlySales, getClosedWeekdays } from './ingest/revel.js';
import { classifyIngestFailure, isEmptyReportError } from './ingest/closures.js';
import { warnSchema } from './lib/schema-check.js';
import { humanApiError } from './lib/api-fatal.js';
import { summarisePostLockChange } from './ingest/monday.js';
import { newState, verifyState, buildAuthorizeUrl, exchangeCode, fetchTenants, storeConnection, XERO_SCOPES } from './ingest/xero.js';
import { ingestProfitAndLoss } from './ingest/xero-pl.js';
import { discoverAccounts, ingestMetaInsights, probeMetrics, fetchInsights, redactTokens, calibrateDayAlignment, askMetaForValidMetrics } from './ingest/meta.js';
import { loadKey } from './lib/crypto.js';
import { logIngestion, checkDataGaps } from './ingest/log.js';
import { askSauron } from './ai/engine.js';
import { noteVenueAllowed, knowledgeHealth } from './ai/knowledge.js';
import { effectiveRole, mayRead, sensitivityOf, describeAllRoles } from './ai/data-domains.js';
import { queryTools } from './ai/tools.js';
import { EVENT_AGENT_PROMPT, eventDraftTool } from './ai/event-agent.js';
import { modelFor } from './ai/model-policy.js';
import { prettyVenue } from './ai/progress.js';
import type { ProgressEvent } from './ai/progress.js';
import Anthropic from '@anthropic-ai/sdk';

/**
 * A direct client for the ONE call that is not a conversation: the forced tool
 * that turns a settled plan into a draft. Everything else goes through the
 * engine, which owns the tool loop, the retries and the caching.
 */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
import { socialFreshness } from './lib/social-freshness.js';
import { rlsAudit } from './lib/rls-audit.js';
import { probeStaffAny } from './lib/staffany-probe.js';
import { fetchSections } from './lib/staffany-client.js';
import { validateSession, listUsers, inviteUser, assignRole, removeRole, deleteUser, resetUserPassword, acceptTerms, supabaseAdmin } from './auth/session.js';
import { TERMS_VERSION, TERMS_TITLE, TERMS_BODY } from './auth/terms.js';
import type { ChatMessage } from './ai/engine.js';
import type { SessionUser } from './auth/session.js';
import type { ProductMixRow, OperationsData, HourlySalesData } from './parsers/revel/types.js';

const app = new Hono();

/**
 * Compress every response, and register it FIRST so it wraps everything
 * including the static files.
 *
 * WHY. Nothing here was compressed at all -- admin.html went down the wire at
 * 87,178 bytes where gzip makes it 23,731, and index.html at 40,801 against
 * 12,874. That is 73% and 69% of the two pages people actually wait for,
 * given away for one line, and on a phone on mobile data it is the single
 * largest win available.
 *
 * MIDDLEWARE ORDER IS THE WHOLE POINT. Compression has to see the body on the
 * way back out, so it must be the OUTERMOST layer -- registered before the
 * handler that produces the body, so its `await next()` returns with the
 * finished response. Put it after serveStatic and it compresses nothing,
 * silently, while looking exactly as installed as it does here.
 *
 * THE /ask/stream EVENT STREAM IS SAFE HERE, and it was checked rather than
 * assumed, because the hazard is real: a gzip stream buffers until it has
 * enough bytes to be worth emitting, and an SSE progress frame is about eighty
 * of them. Compressed naively, those frames would sit in the compressor and
 * arrive together at the END of the answer -- the one moment they are
 * worthless, and a failure with nothing in any log to explain it.
 *
 * Hono already prevents that. `text/event-stream` is excluded from
 * COMPRESSIBLE_CONTENT_TYPE_REGEX by an explicit negative lookahead, so
 * compress() passes the stream through untouched. Measured end to end: with
 * `Accept-Encoding: gzip`, frames arrive at 0.00s, 0.40s, 0.80s, 1.20s, 1.60s
 * -- identical to an uncompressed route, in five separate chunks.
 *
 * So there is NO path exclusion here on purpose; one was written and removed
 * once this was measured, because a redundant guard that looks load-bearing is
 * its own kind of lie. `server.compress.test.ts` pins the behaviour, so a
 * future `contentTypeFilter` option cannot quietly take the protection away.
 */
app.use('*', compress());

/**
 * How long a slow request actually took, and which one it was.
 *
 * WHY. "The admin page loads slowly" took an afternoon to diagnose from the
 * code alone, and the answer — validateSession making four serial round trips
 * on each of twelve requests — was invisible from both ends: the browser sees
 * twelve slow requests, and the server said nothing at all. One line per slow
 * request turns the next report into a lookup.
 *
 * ONLY WHAT IS SLOW. A line per request would bury the ingest logs that
 * actually matter, so the threshold is 400ms: fast enough that a genuinely
 * sluggish endpoint always appears, slow enough that a healthy page load is
 * silent. A page that is slow because of TWELVE requests at 300ms each would
 * not trip it — which is why the count matters as much as the duration, and is
 * why the fix was a cache rather than a faster query.
 */
const SLOW_REQUEST_MS = 400;

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  const ms = Date.now() - started;
  if (ms >= SLOW_REQUEST_MS) {
    console.warn(`[slow] ${c.req.method} ${c.req.path} — ${ms}ms (status ${c.res.status})`);
  }
});

app.use('/ask', cors());
app.use('/ask/stream', cors());
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
    // Drives the blocking screen. The browser reads this to decide whether to
    // show the terms; the server refuses regardless, so a page that ignored it
    // would get a 403 rather than an answer.
    acceptedTerms: user.acceptedTerms,
    termsVersion: TERMS_VERSION,
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

/**
 * The same question as /ask, answered over an event stream.
 *
 * WHY IT EXISTS. A question that runs a twelve-round tool loop takes well over
 * a minute, and until now the only thing on screen was three bouncing dots.
 * Worse than dull: the error handler on /ask already records that "a six-minute
 * answer and a crash look identical from the front end and are nothing alike".
 * This makes them different, and it does it with the engine's own account of
 * what it is doing rather than a guess.
 *
 * ADDITIVE, NOT A REPLACEMENT, and /ask below is untouched. A browser that
 * cannot hold a stream -- or an intermediary that buffers one, which is a real
 * thing and invisible when it happens -- falls back to /ask and gets exactly
 * today's behaviour. Converting /ask in place would have made a proxy's
 * buffering into a broken product instead of a missing nicety.
 *
 * THE STREAM CARRIES THE ANSWER TOO, in a final `done` event, so there is no
 * second request and no window where the work is finished but the reply has not
 * arrived. An `error` event carries the same sentence /ask would have returned.
 */
app.post('/ask/stream', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const gated = requireTerms(c, user);
  if (gated) return gated;

  const body = await c.req.json<{ question: string; history?: ChatMessage[]; model?: string }>();
  if (!body.question) return c.json({ error: 'Missing "question" field' }, 400);

  const venueFilter = user.isOwner ? undefined : user.venues.map(v => v.slug);

  /**
   * Which venues a progress label may NAME. Labels only; not a boundary.
   *
   * A label is drawn from the model's chosen tool input BEFORE the tool runs,
   * so before enforceVenueScope() has refused anything. Without this, a model
   * that asked for a venue this reader cannot see would have had that venue's
   * name printed on their screen, by us, a moment before we refused the query.
   *
   * An owner passes `null`, meaning unrestricted -- there is no venue they may
   * not be told about, and the same `undefined` venueFilter is what the tool
   * layer already gets for them. Everyone else gets exactly their own venues,
   * and anything else renders as "another venue".
   */
  const venueNames = user.isOwner
    ? null
    : Object.fromEntries(user.venues.map(v => [v.slug, prettyVenue(v.slug)]));

  return streamSSE(c, async (stream) => {
    /**
     * Writes are CHAINED, not fired in parallel.
     *
     * The engine reports synchronously and writeSSE is async, so calling it
     * without sequencing would interleave frames under load and put a `done`
     * event on the wire before the `working` event that preceded it. A promise
     * chain keeps the order the engine produced, and never makes the engine
     * wait: the callback returns immediately whatever the socket is doing.
     */
    let chain: Promise<void> = Promise.resolve();
    const push = (event: ProgressEvent | { kind: 'done' | 'error'; [k: string]: any }) => {
      chain = chain
        .then(() => stream.writeSSE({ data: JSON.stringify(event) }))
        /**
         * A closed socket is the normal case, not an incident: the person
         * navigated away or closed the tab. Swallowed so it cannot reject the
         * chain and silence every write after it.
         */
        .catch(() => {});
    };

    /**
     * A comment frame every fifteen seconds.
     *
     * Not decoration. A single model call can think for well over a minute with
     * nothing to report, and an idle connection is exactly what a proxy or load
     * balancer decides to close -- which would look to the reader like the
     * answer dying partway through. ": " starts an SSE comment, which clients
     * ignore and intermediaries count as traffic.
     */
    const heartbeat = setInterval(() => {
      chain = chain.then(async () => { await stream.write(': ping\n\n'); }).catch(() => {});
    }, 15_000);

    try {
      const result = await askSauron(
        body.question, body.history ?? [], venueFilter, 'chat',
        effectiveRole(user), undefined, body.model, undefined,
        push, venueNames,
      );
      push({ kind: 'done', result });
    } catch (e: any) {
      // Logged for the same reason /ask logs: this used to be invisible in
      // Railway, and a log export covering a real failure held one line.
      console.error(`[ask/stream] failed for ${user.email ?? user.id}: ${e?.stack ?? e?.message ?? e}`);
      push({ kind: 'error', error: humanApiError(e) });
    } finally {
      clearInterval(heartbeat);
      // The chain holds every queued write; the stream must not close before
      // they have gone out, or the `done` event is lost and the browser sees a
      // clean end with no answer in it.
      await chain;
    }
  });
});

app.post('/ask', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const gated = requireTerms(c, user);
  if (gated) return gated;

  const body = await c.req.json<{ question: string; history?: ChatMessage[]; model?: string }>();
  if (!body.question) return c.json({ error: 'Missing "question" field' }, 400);

  try {
    const venueFilter = user.isOwner ? undefined : user.venues.map(v => v.slug);
    // WHO and WHAT are independent: the filter decides which venues, the role
    // decides which kinds of data. Both are enforced server-side in the tool
    // layer, never by what the model was offered.
    /**
     * The model the person asking chose, if they chose one.
     *
     * Offered because the tiering cannot know what a given question is worth to
     * the person paying for it -- and because 'lookup', the cheap tier the
     * brief specifies, was never wired to anything and so has never once run.
     * An explicit choice is honest where an automatic one would need to
     * classify the question before answering it, which costs a call on every
     * question to save on some of them.
     *
     * Unvalidated here on purpose: modelFor holds the allowlist, so an unknown
     * value degrades to the configured default rather than failing the
     * question, and no browser can point our API key at an arbitrary model.
     */
    const result = await askSauron(
      body.question, body.history ?? [], venueFilter, 'chat',
      effectiveRole(user), undefined, body.model,
    );
    return c.json(result);
  } catch (e: any) {
    /**
     * LOGGED, not just returned. This handed the message to the browser and
     * wrote nothing to the console, so every chat failure since it was written
     * was invisible in Railway -- and on 1 Sep 2026 a log export covering the
     * failure contained a single line, because there was nothing else to find.
     *
     * Worth knowing what this catch does NOT cover: the browser's "Request
     * failed" is its own fallback for a body that will not parse as JSON, and
     * this returns valid JSON. So that message means the response never came
     * from here at all -- the request outlived the edge timeout. A six-minute
     * answer and a crash look identical from the front end and are nothing
     * alike, which is exactly why this line has to exist.
     */
    console.error(`[ask] failed for ${user.email ?? user.id}: ${e?.stack ?? e?.message ?? e}`);
    // The log gets the raw error; the person gets a sentence. Returning the
    // raw one put `{"type":"error","error":{"type":"overloaded_error",...,
    // "request_id":"req_011Cec..."}` in front of a venue manager, which tells
    // them nothing and reads as a broken product rather than a busy minute.
    return c.json({ error: humanApiError(e) }, 500);
  }
});

// --- Event planning (its own surface, and the only one that ends in a write) ---

/**
 * A turn of the planning conversation.
 *
 * SEPARATE FROM /ask because it is a separate job. Sauron answers questions
 * about what happened; this argues a concept toward a plan and refuses to
 * finish while a blocking decision is open. Same engine, same tools, same venue
 * and role enforcement -- a different standing prompt, and therefore a
 * different cached prefix, which is correct rather than wasteful.
 */
app.post('/api/plan', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const gated = requireTerms(c, user);
  if (gated) return gated;

  const body = await c.req.json<{ message: string; history?: ChatMessage[] }>();
  if (!body.message) return c.json({ error: 'Missing "message" field' }, 400);

  try {
    const venueFilter = user.isOwner ? undefined : user.venues.map(v => v.slug);
    const result = await askSauron(
      body.message, body.history ?? [], venueFilter, 'chat',
      effectiveRole(user), undefined, undefined, EVENT_AGENT_PROMPT,
    );
    return c.json(result);
  } catch (e: any) {
    console.error(`[plan] failed for ${user.email ?? user.id}: ${e?.stack ?? e?.message ?? e}`);
    return c.json({ error: humanApiError(e) }, 500);
  }
});

/**
 * Turn a settled conversation into a draft. WRITES NOTHING.
 *
 * A forced tool over the transcript, the same shape the recommendation engine
 * uses: the arguing pass writes naturally and a separate call turns it into
 * records, because asking one model to end an argument with JSON produces
 * worse arguments and worse JSON.
 *
 * The draft comes back to the browser, a person reads it and clicks, and
 * POST /api/events does the writing. That ordering is the whole design -- see
 * the note there.
 */
app.post('/api/plan/draft', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const gated = requireTerms(c, user);
  if (gated) return gated;

  const body = await c.req.json<{ history?: ChatMessage[] }>();
  const history = body.history ?? [];
  if (history.length === 0) return c.json({ error: 'Nothing to draft yet.' }, 400);

  const transcript = history
    .map(m => `${m.role === 'user' ? 'PLANNER' : 'YOU'}: ${m.content}`)
    .join('\n\n');

  try {
    const structured = await anthropic.messages.create({
      model: modelFor('lookup', process.env).model,
      max_tokens: 16384,
      system: [{
        type: 'text',
        text: 'You are turning a finished planning conversation into a structured brief. Everything must already be in the transcript: do not add a decision, do not invent a figure, and do not fill a field that was never settled — leave it out. Numbers appear only where the conversation quoted them from a query tool.',
        cache_control: { type: 'ephemeral' },
      }],
      tools: [eventDraftTool() as any],
      tool_choice: { type: 'tool', name: 'record_event_draft' },
      messages: [{ role: 'user', content: `The planning conversation:\n\n${transcript}` }],
    });

    const call = structured.content.find((b: any) => b.type === 'tool_use') as any;
    if (!call?.input) return c.json({ error: 'Could not build a draft from this conversation.' }, 422);

    return c.json({ draft: call.input });
  } catch (e: any) {
    console.error(`[plan/draft] failed for ${user.email ?? user.id}: ${e?.stack ?? e?.message ?? e}`);
    return c.json({ error: humanApiError(e) }, 500);
  }
});

/**
 * Create the event. THE ONLY WRITE PATH, and a person is on the end of it.
 *
 * WHY THE MODEL CANNOT REACH THIS. If a write were a tool, the model could call
 * it having merely believed the person agreed -- and "the user confirmed" is
 * precisely the claim a language model is worst at, and the kind of mistake
 * nobody notices until a row is wrong. So the confirmation is a click that
 * happened rather than a sentence that was generated.
 *
 * Everything below is re-checked here rather than trusted from the draft: the
 * venues against what this user may see, the dates, the shape. The draft
 * arrived through a browser and a browser can send anything.
 */
app.post('/api/events', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const gated = requireTerms(c, user);
  if (gated) return gated;

  const d = await c.req.json<any>().catch(() => null);
  if (!d?.name || !d?.start_date || !d?.end_date) {
    return c.json({ error: 'An event needs a name and both dates.' }, 400);
  }
  if (d.end_date < d.start_date) {
    return c.json({ error: 'The end date is before the start date.' }, 400);
  }

  const { data: allVenues } = await supabaseAdmin.from('venues').select('id, slug, name');
  const mayUse = user.isOwner
    ? (allVenues ?? [])
    : (allVenues ?? []).filter(v => user.venues.some(uv => uv.venue_id === v.id));

  const slugs: string[] = Array.isArray(d.venue_slugs) ? d.venue_slugs : [];
  const chosen = mayUse.filter(v => slugs.includes(v.slug));

  // An empty list is NOT "all venues" — it is a half-written event, and the
  // migration makes those owner-only by construction. Refuse it here so
  // nobody creates one by accident.
  if (chosen.length === 0) {
    return c.json({ error: 'Name at least one venue you have access to.' }, 400);
  }
  if (chosen.length !== slugs.length) {
    const refused = slugs.filter(sl => !chosen.some(v => v.slug === sl));
    return c.json({ error: `You do not have access to: ${refused.join(', ')}` }, 403);
  }

  const { data: created, error } = await supabaseAdmin
    .from('events')
    .insert({
      name: d.name,
      start_date: d.start_date,
      end_date: d.end_date,
      occasion: d.occasion ?? null,
      concept_type: d.concept_type ?? null,
      partner: d.partner ?? null,
      format: d.format ?? null,
      demographic: d.demographic ?? null,
      concept: d.concept ?? null,
      usp: d.usp ?? null,
      venue_fit: d.venue_fit ?? null,
      target_net_sales: d.target_net_sales ?? null,
      target_covers: d.target_covers ?? null,
      target_spend_per_head: d.target_spend_per_head ?? null,
      baseline_net_sales: d.baseline_net_sales ?? null,
      baseline_covers: d.baseline_covers ?? null,
      baseline_spend_per_head: d.baseline_spend_per_head ?? null,
      baseline_basis: d.baseline_basis ?? null,
      price: d.price ?? null,
      price_basis_food_avg: d.price_basis_food_avg ?? null,
      price_basis_bev_avg: d.price_basis_bev_avg ?? null,
      cost_lines: Array.isArray(d.cost_lines) ? d.cost_lines : [],
      cost_total: d.cost_total ?? null,
      break_even_covers: d.break_even_covers ?? null,
      ad_budget: d.ad_budget ?? null,
      ad_plan: d.ad_plan ?? null,
      status: 'brief_issued',
      created_by: user.id,
    })
    .select('id')
    .single();

  if (error || !created) {
    console.error(`[events] insert failed for ${user.email ?? user.id}: ${error?.message}`);
    return c.json({ error: `Could not create the event: ${error?.message ?? 'unknown'}` }, 400);
  }

  const { error: venueError } = await supabaseAdmin
    .from('event_venues')
    .insert(chosen.map(v => ({ event_id: created.id, venue_id: v.id })));

  if (venueError) {
    /**
     * An event with no venues is owner-only and invisible to the person who
     * just made it, so a half-succeeded write is worse than none. Undo it and
     * say so rather than leaving a row nobody can see.
     */
    await supabaseAdmin.from('events').delete().eq('id', created.id);
    console.error(`[events] venue link failed, event rolled back: ${venueError.message}`);
    return c.json({ error: `Could not attach the venues: ${venueError.message}` }, 400);
  }

  const tasks = Array.isArray(d.tasks) ? d.tasks : [];
  if (tasks.length > 0) {
    const start = Date.parse(`${d.start_date}T00:00:00Z`);
    const { error: taskError } = await supabaseAdmin.from('event_tasks').insert(
      tasks.map((t: any) => {
        const tMinus = Number(t.t_minus_days);
        return {
          event_id: created.id,
          kind: ['content', 'outreach', 'ops', 'other'].includes(t.kind) ? t.kind : 'other',
          description: String(t.description ?? '').slice(0, 2000),
          channel: t.channel ?? null,
          // Stored as a NEGATIVE offset, matching the column's own definition,
          // while the draft speaks in "14 days before" like a person does.
          t_minus_days: Number.isFinite(tMinus) ? -Math.abs(tMinus) : null,
          due_date: Number.isFinite(tMinus)
            ? new Date(start - Math.abs(tMinus) * 86_400_000).toISOString().slice(0, 10)
            : null,
          owner_name: t.owner_name ?? null,
        };
      }),
    );
    // Not fatal: the event and its venues are real, and losing the schedule is
    // recoverable by hand where losing the event is not. Reported so nobody
    // discovers an empty task list a week later.
    if (taskError) {
      console.error(`[events] tasks failed for ${created.id}: ${taskError.message}`);
      return c.json({
        id: created.id,
        warning: `The event was created but its schedule was not: ${taskError.message}`,
      });
    }
  }

  /**
   * What the planner found in the city while working, written back.
   *
   * THIS IS HOW city_events FILLS. Nobody can maintain a calendar of everything
   * happening in Singapore by hand -- Khai's objection, and it is correct. The
   * table holds the anchors; the long tail arrives as a byproduct of somebody
   * planning around it, and the next planner finds it already there instead of
   * searching again.
   *
   * WRITTEN UNCONFIRMED, ALWAYS. These came from a search during a chat, which
   * is the weakest evidence in the system, and the query tool reports the
   * confirmed flag with every row so a reader knows which they are looking at.
   * A person promotes one by checking it.
   *
   * NEVER FATAL. The event is the thing that was asked for; a calendar row is a
   * bonus, and losing it must not take the event with it.
   */
  const found = Array.isArray(d.city_events_found) ? d.city_events_found : [];
  let calendarAdded = 0;

  if (found.length > 0) {
    const rows = found
      // A row with no source is worse than no row: it is an assertion nobody
      // can check, sitting in the table that everything else trusts.
      .filter((e: any) => e?.name && e?.start_date && e?.end_date && e?.source_url)
      .slice(0, 20)
      .map((e: any) => ({
        name: String(e.name).slice(0, 300),
        start_date: e.start_date,
        end_date: e.end_date,
        category: ['sport', 'festival', 'concert', 'nightlife', 'conference'].includes(e.category) ? e.category : 'other',
        location: e.location ?? null,
        ticket_price_low: Number.isFinite(Number(e.ticket_price_low)) ? Number(e.ticket_price_low) : null,
        ticket_price_high: Number.isFinite(Number(e.ticket_price_high)) ? Number(e.ticket_price_high) : null,
        audience: e.audience ?? null,
        source: 'Found while planning an event',
        source_url: String(e.source_url).slice(0, 1000),
        confirmed: false,
      }));

    if (rows.length > 0) {
      const { error: cityError } = await supabaseAdmin
        .from('city_events')
        .upsert(rows, { onConflict: 'name,start_date', ignoreDuplicates: true });
      if (cityError) console.error(`[events] city calendar additions failed: ${cityError.message}`);
      else calendarAdded = rows.length;
    }
  }

  console.log(`[events] ${user.email ?? user.id} created "${d.name}" (${created.id}) at ${chosen.map(v => v.slug).join(', ')} with ${tasks.length} task(s)${calendarAdded ? `, ${calendarAdded} city calendar row(s) added unconfirmed` : ''}`);
  return c.json({
    id: created.id,
    venues: chosen.map(v => v.name),
    tasks: tasks.length,
    city_events_added: calendarAdded || undefined,
  });
});

// --- Admin API (owner only) ---

app.get('/admin/api/users', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);
  const users = await listUsers();
  return c.json({ users });
});

/**
 * What each role grants, so an access decision is not made from a word.
 *
 * COMPUTED, not stored. describeRole() reads ROLE_DOMAINS and mayRead() -- the
 * same functions the tool layer enforces with -- and the tool list comes from
 * queryTools, so a tool added tomorrow appears against every role allowed to
 * call it without anybody remembering to update a page. A hand-written table
 * here would drift and then state the opposite of the truth confidently, which
 * is worse than saying nothing.
 */
app.get('/admin/api/roles', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);
  return c.json({ roles: describeAllRoles(queryTools.map(t => t.name)) });
});

app.post('/admin/api/users/invite', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  // No password. Supabase emails a one-time link and they set their own, so
  // nobody -- including whoever is on this screen -- ever knows it.
  const { email, full_name } = await c.req.json();
  if (!email) return c.json({ error: 'Email required' }, 400);

  try {
    const invited = await inviteUser(email, full_name ?? '');
    return c.json({ user: { id: invited?.id, email: invited?.email }, invited: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// --- the confidentiality terms ----------------------------------------------

/**
 * The text in force. Served rather than duplicated into the page, so there is
 * exactly one copy and it is the one in src/auth/terms.ts that acceptances are
 * recorded against.
 */
app.get('/api/terms', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated' }, 401);
  return c.json({
    version: TERMS_VERSION,
    title: TERMS_TITLE,
    body: TERMS_BODY,
    accepted: user.acceptedTerms,
  });
});

app.post('/api/terms/accept', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated' }, 401);

  try {
    await acceptTerms(user.id, {
      // Best effort and never relied on. Behind Railway's proxy the header is
      // what there is; a missing one is stored as null rather than guessed at.
      ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
    console.log(`[terms] ${user.email} accepted ${TERMS_VERSION}`);
    return c.json({ accepted: true, version: TERMS_VERSION });
  } catch (e: any) {
    console.error(`[terms] could not record acceptance for ${user.email}: ${e.message}`);
    return c.json({ error: e.message }, 500);
  }
});

/**
 * The gate, on the server side of it.
 *
 * The blocking screen in the browser is the experience; this is the control.
 * Same split as the AI tool list against enforceDomainScope() -- what we offer
 * is a hint, what we refuse is a boundary -- and it matters here because the
 * whole point of the terms is to be able to say somebody agreed before they
 * saw anything. A gate that a page reload defeats cannot support that claim.
 */
function requireTerms(c: any, user: SessionUser) {
  if (user.acceptedTerms) return null;
  return c.json({
    error: 'You need to read and accept the confidentiality terms before Sauron will answer.',
    terms_required: true,
    version: TERMS_VERSION,
  }, 403);
}

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

/**
 * This week's advice, for the venues the caller can see.
 *
 * SCOPED HERE AND NOT ONLY BY RLS. The route reads through the service role,
 * which bypasses row-level security -- the same hole enforceVenueScope() had to
 * plug for the query tools. The filter below is the control; the policy on the
 * table is what protects anything reading with a user token.
 */
app.get('/api/recommendations', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  // A briefing is the densest commercial document this app produces — margins,
  // wage lines, supplier names. If anything is behind the terms, this is.
  const gated = requireTerms(c, user);
  if (gated) return gated;

  let query = supabaseAdmin
    .from('recommendations')
    .select('id, venue_id, period_start, period_end, headline, body, domain, confidence, charts, evidence, generated_at, model, status, rating, feedback, venues(name)')
    .order('generated_at', { ascending: false })
    .order('confidence', { ascending: false })
    .limit(60);

  if (!user.isOwner) {
    const venueIds = user.venues.map(v => v.venue_id);
    // An empty list must mean NO venues, never "no restriction" — the same
    // trap the system prompt's venue paragraph had to be written around.
    if (venueIds.length === 0) return c.json({ recommendations: [] });
    query = query.in('venue_id', venueIds);
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 400);

  /**
   * The WHAT dimension applied to advice.
   *
   * The engine runs as the system and sees everything -- it must, or it cannot
   * say anything about margin. So the guard is on the way OUT, exactly like
   * namesOtherVenues() for the venue dimension: a recommendation quoting
   * payroll AMOUNTS is withheld from a reader whose role may not see them.
   * The percentage version is what a manager is meant to work with and passes.
   */
  const role = effectiveRole(user);
  const permitted = (data ?? []).filter((r: any) => mayRead(role, sensitivityOf(r)));
  const withheld = (data ?? []).length - permitted.length;

  return c.json({
    withheld_for_role: withheld > 0 ? withheld : undefined,
    recommendations: permitted.map((r: any) => ({
      ...r,
      venue: r.venues?.name ?? 'Unknown venue',
      /**
       * The QUERIES behind the claim, not the rows they returned. Re-runnable
       * rather than reproduced — say which, so a reader knows what they are
       * looking at.
       */
      evidence_note: 'The queries this rests on. Re-run them to check the figures.',
    })),
  });
});

/**
 * What happened to a recommendation, and whether it was any good.
 *
 * TWO INDEPENDENT FIELDS. "I did it" and "this was worth reading" are different
 * facts: advice can be acted on and turn out wrong, and good advice can be
 * right and impractical this month. Collapsing them would make the only measure
 * of whether this feature works unreadable.
 */
app.post('/api/recommendations/:id/rate', async (c) => {
  const user = await requireAuth(c);
  if (!user) return c.json({ error: 'Not authenticated. Please log in.' }, 401);

  const { status, rating, feedback } = await c.req.json().catch(() => ({}));

  if (status !== undefined && !['new', 'acted_on', 'dismissed'].includes(status)) {
    return c.json({ error: 'status must be new, acted_on or dismissed' }, 400);
  }
  if (rating !== undefined && rating !== null && !['useful', 'not_useful', 'wrong'].includes(rating)) {
    return c.json({ error: 'rating must be useful, not_useful or wrong' }, 400);
  }

  // Which venue is this, and may they touch it. Checked before the write
  // rather than trusted to the id in the URL.
  const { data: row } = await supabaseAdmin
    .from('recommendations')
    .select('venue_id')
    .eq('id', c.req.param('id'))
    .maybeSingle();

  if (!row) return c.json({ error: 'No such recommendation.' }, 404);
  if (!user.isOwner && !user.venues.some(v => v.venue_id === (row as any).venue_id)) {
    return c.json({ error: 'You do not have access to that venue.' }, 403);
  }

  const patch: Record<string, any> = { rated_by: user.id, rated_at: new Date().toISOString() };
  if (status !== undefined) patch.status = status;
  if (rating !== undefined) patch.rating = rating;
  if (typeof feedback === 'string') patch.feedback = feedback.slice(0, 2000);

  const { error } = await supabaseAdmin
    .from('recommendations')
    .update(patch)
    .eq('id', c.req.param('id'));

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
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

/**
 * The account map: what each venue's ledger name means everywhere else.
 *
 * Returns the mapping AND the accounts that have no row in it. The second list
 * is the point -- an unmapped account resolves to its own name, which merges
 * nothing and moves no figure, but it also will not match the equivalent
 * account at another venue. That is invisible in an answer, so it has to be
 * visible here.
 */
/**
 * Fee months somebody has explained, and the act of explaining one.
 *
 * OWNER ONLY to write, because this silences a control. Who decided a month was
 * fine, and why, is the entire value of the row -- an anonymous acknowledgement
 * would be indistinguishable from the check having been quietly disabled.
 */
app.get('/admin/api/fee-acknowledgements', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { data, error } = await supabaseAdmin
    .from('fee_acknowledgements')
    .select('id, venue_id, period_start, account_name, reason, created_at, venues(name)')
    .order('period_start', { ascending: false });

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ acknowledgements: data ?? [] });
});

app.post('/admin/api/fee-acknowledgements', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { venue_id, period_start, account_name, reason } = await c.req.json();
  if (!venue_id || !period_start) return c.json({ error: 'venue_id and period_start are required' }, 400);
  // The reason is the point. An acknowledgement with no explanation tells a
  // future reader only that somebody wanted the warning gone.
  if (!reason || !String(reason).trim()) return c.json({ error: 'A reason is required — the briefing states it instead of going silent' }, 400);

  const { data, error } = await supabaseAdmin
    .from('fee_acknowledgements')
    .upsert({
      venue_id,
      period_start,
      account_name: account_name || null,
      reason: String(reason).trim(),
      acknowledged_by: user.id,
    }, { onConflict: 'venue_id,period_start,account_name' })
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ acknowledgement: data });
});

app.delete('/admin/api/fee-acknowledgements/:id', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { error } = await supabaseAdmin
    .from('fee_acknowledgements')
    .delete()
    .eq('id', c.req.param('id'));

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

app.get('/admin/api/account-map', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const [{ data: mappings }, { data: venues }] = await Promise.all([
    supabaseAdmin
      .from('account_map')
      .select('id, venue_id, account_name, canonical_account, business_line, notes, confirmed_at')
      .order('account_name', { ascending: true }),
    supabaseAdmin.from('venues').select('id, name, slug'),
  ]);

  /**
   * Every account the ledger actually holds, so "missing from the map" can be
   * computed rather than assumed.
   *
   * READ FROM A VIEW THAT DOES THE DISTINCT (migration 049), because the
   * obvious version of this was silently wrong. It selected from
   * profit_and_loss directly with no paging, and PostgREST caps a response at
   * 1,000 rows — three venues over two years is several thousand, so any
   * account appearing only outside that first page was reported as MAPPED when
   * nobody had mapped it. A list whose whole job is to say what still needs
   * attention was quietly short, and nothing said so.
   *
   * Same cap as BUILD_LOG 1.x, and as the comment on fetchAccountMap() that
   * says it has cost this project data four times.
   */
  let { data: ledger, error: ledgerError } = await supabaseAdmin
    .from('profit_and_loss_accounts')
    .select('venue_id, account_name');

  /**
   * FALLS BACK IF THE VIEW IS NOT THERE YET, loudly.
   *
   * A deploy reaches Railway the moment the branch is pushed; a migration is
   * run by a person, afterwards. Between the two this view does not exist, and
   * without this the account map would show an empty "unmapped" list — which
   * reads as "everything is mapped" and is the most misleading possible answer.
   * Same rule as warnSchema() and the terms gate: a degraded feature beats a
   * wrong one presented as fine.
   *
   * The fallback is the OLD query, truncation and all, so the page keeps
   * working until migration 049 is run. It says so every time, because an
   * unapplied migration that nothing reports is how this project has been
   * caught before.
   */
  if (ledgerError) {
    console.error(
      `[account-map] profit_and_loss_accounts is unavailable (${ledgerError.message}). ` +
      'Run migration 049. Falling back to a direct read, which PostgREST caps at ' +
      '1,000 rows — the unmapped list below may be INCOMPLETE until then.',
    );
    const fallback = await supabaseAdmin
      .from('profit_and_loss')
      .select('venue_id, account_name')
      .eq('is_summary', false);
    ledger = fallback.data;
  }

  /**
   * Say so if either read came back at the cap.
   *
   * The view removes the truncation we know about; it does not make the cap go
   * away. Both of these answers are small today — about sixty accounts a venue
   * — and both grow with customers, and a truncated read here does not look
   * like an error: it produces a SHORTER list of unmapped accounts, which reads
   * as good news. This is the cheapest possible way to make that visible, and
   * when it fires the fix is a paging loop like fetchAccountMap's.
   */
  for (const [name, rows] of [['account_map', mappings], ['ledger accounts', ledger]] as const) {
    if ((rows?.length ?? 0) >= 1000) {
      console.warn(
        `[account-map] ${name} came back with ${rows!.length} rows — at or over PostgREST's ` +
        '1,000-row cap. The unmapped list below is incomplete. Add a paging loop.',
      );
    }
  }

  const mapped = new Set((mappings ?? []).map(m => `${m.venue_id}|${m.account_name}`));
  const unmapped: Array<{ venue_id: string; account_name: string }> = [];
  const seen = new Set<string>();
  for (const row of ledger ?? []) {
    const key = `${row.venue_id}|${row.account_name}`;
    if (mapped.has(key) || seen.has(key) || !row.account_name) continue;
    seen.add(key);
    unmapped.push({ venue_id: row.venue_id, account_name: row.account_name });
  }

  return c.json({ mappings: mappings ?? [], venues: venues ?? [], unmapped });
});

app.put('/admin/api/account-map', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const body = await c.req.json<{
    venue_id: string;
    account_name: string;
    canonical_account: string;
    business_line?: string;
    notes?: string;
  }>();

  if (!body.venue_id || !body.account_name || !body.canonical_account) {
    return c.json({ error: 'venue_id, account_name and canonical_account are required' }, 400);
  }

  // Stamped with who decided. Every mapping table in this system carries its
  // provenance, because a mapping nobody can trace is one nobody can question.
  const { error } = await supabaseAdmin
    .from('account_map')
    .upsert({
      venue_id: body.venue_id,
      account_name: body.account_name,
      canonical_account: body.canonical_account,
      business_line: body.business_line?.trim() || 'main',
      notes: body.notes ?? null,
      confirmed_by: user.id,
      confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'venue_id,account_name' });

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
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

  /**
   * Whether the Meta ingest has run recently, surfaced where an owner already
   * looks.
   *
   * It also counts toward /watchdog, but nothing polls that endpoint, so on its
   * own the check was a signal with no receiver -- which is the failure it
   * exists to prevent, one level up. The admin page is the only place somebody
   * reliably looks at this system's health.
   */
  const social = await socialFreshness();

  /**
   * Is every table still protected?
   *
   * Surfaced beside the ingest health for the same reason that check is here:
   * this is the only page an owner reliably looks at. It is also the answer to
   * how reconciliation_alerts and ingestion_log went a year without RLS -- the
   * convention was so consistent that nobody thought to verify it, and the
   * thing that eventually noticed belonged to a vendor.
   *
   * One catalogue query, and the audit reads the live database rather than the
   * migrations we believe we ran.
   */
  const rls = await rlsAudit();

  return c.json({ ...report, recent_ingestions: recentLogs ?? [], social, rls });
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
    // Xero rejects the whole consent request with `invalid_scope` and never
    // says which scope it disliked, so the list has to be visible somewhere.
    console.log(`Xero authorize requested with scopes: ${XERO_SCOPES}`);
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
 * What does StaffAny give us today?
 *
 * A button rather than a terminal command, and that is the whole reason it
 * exists here. Everything else in this system ships through GitHub and runs on
 * Railway; this was the one diagnostic that needed a local clone, a CLI login
 * and a key on somebody's laptop. Railway has no clean way to run a one-off --
 * a service with no cron restarts on exit and crash-loops, and repointing a
 * scheduled service's start command is what left Ingest-Meta running the
 * classifier for eleven days while showing green.
 *
 * Not on page load: it is nine calls to a third party. It is run when setting
 * up, and each time StaffAny changes something -- which they have said they
 * will, since the v2 experimental endpoints are untested on their side and they
 * are planning that testing now.
 */
app.get('/admin/api/staffany/probe', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const key = process.env.STAFFANY_API_KEY;
  // Named plainly. A missing variable and a refused token produce the same
  // empty page otherwise, and only one of them is fixed on Railway.
  if (!key) {
    return c.json({ error: 'STAFFANY_API_KEY is not set on this service. Add it as a sealed variable on the web service, not only on the job that first used it.' }, 400);
  }

  try {
    return c.json(await probeStaffAny({
      key,
      start: c.req.query('start'),
      end: c.req.query('end'),
    }));
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

/**
 * The StaffAny section mapping: which venue, and kitchen or floor.
 *
 * The same shape as the Xero tenant mapping and `revel_venue_keys`, and here
 * for the same reason. Two of the three legal entities behind these venues are
 * called "Potus" and "20 Craig Road", so nothing in this system resolves a
 * source key to a venue by matching on a name -- and a section guessed into the
 * wrong venue would put another venue's labour cost onto this venue's margin
 * comparison, which is a wrong number that looks entirely reasonable.
 */
app.get('/admin/api/staffany/sections', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { data, error } = await supabaseAdmin
    .from('staffany_sections')
    .select('staffany_section_id, section_name, section_tag, venue_id, area, confirmed_at')
    .order('section_name');

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ sections: data ?? [] });
});

/**
 * Pull the section list from StaffAny so it can be mapped.
 *
 * A BUTTON rather than a side effect of loading the page, and rather than
 * something only the ingest does. The ingest records sections too, but that
 * created a circle: nothing can be mapped until the sections exist, the ingest
 * is what creates them, and the ingest refuses to run with nothing mapped. The
 * way out should not be "run the job and ignore the error it prints".
 *
 * Not folded into the probe either, which says on its own face that it writes
 * nothing. A diagnostic that quietly wrote would make its own claim false.
 *
 * It updates the NAME and TAG only. venue_id and area are never touched here,
 * so a rename in StaffAny cannot silently unmap a section somebody confirmed.
 */
app.post('/admin/api/staffany/sections/refresh', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const key = process.env.STAFFANY_API_KEY;
  if (!key) return c.json({ error: 'STAFFANY_API_KEY is not set on this service.' }, 400);

  try {
    const sections = await fetchSections(key);
    for (const s of sections) {
      const { error } = await supabaseAdmin
        .from('staffany_sections')
        .upsert(
          { staffany_section_id: s.id, section_name: s.name, section_tag: s.tag },
          { onConflict: 'staffany_section_id' },
        );
      if (error) return c.json({ error: error.message }, 500);
    }
    return c.json({ ok: true, recorded: sections.length });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

app.put('/admin/api/staffany/sections', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const { staffany_section_id, venue_id, area } = await c.req.json();
  if (!staffany_section_id) return c.json({ error: 'staffany_section_id is required' }, 400);

  // GROUP is a real answer, not a fallback. The Dandy Collection section
  // carries group staff, and folding it into either half of a venue would
  // corrupt the very split it exists to measure.
  if (area !== null && !['BOH', 'FOH', 'GROUP'].includes(area)) {
    return c.json({ error: 'area must be BOH, FOH or GROUP' }, 400);
  }

  /**
   * GROUP carries no venue and is still confirmed.
   *
   * A section is decided when somebody has said what it IS, which for the group
   * section means area GROUP and deliberately no venue -- those hours are
   * worked across every venue and are never allocated to one. Requiring a venue
   * to count as confirmed would leave the one section we have decided about
   * looking exactly like the one nobody had touched, and an unmapped section is
   * never ingested.
   */
  const isGroup = area === 'GROUP';
  const confirmed = isGroup || Boolean(venue_id && area);

  const { error } = await supabaseAdmin
    .from('staffany_sections')
    .update({
      venue_id: isGroup ? null : (venue_id || null),
      area: area || null,
      // Who confirmed it and when, because this is a judgement rather than a
      // fact and somebody may need to ask them about it later.
      confirmed_at: confirmed ? new Date().toISOString() : null,
      confirmed_by: confirmed ? user.id : null,
    })
    .eq('staffany_section_id', staffany_section_id);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
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
      const probes = await probeMetrics(a.platform, a.account_id);
      // When nothing we guessed was accepted, stop guessing and ask. Meta's
      // rejection of a nonsense name lists the names it does accept.
      const hint = probes.some(p => p.ok) ? null : await askMetaForValidMetrics(a.account_id);
      results.push({ platform: a.platform, account_name: a.account_name, probes, hint });
    } catch (e: any) {
      results.push({ platform: a.platform, account_name: a.account_name, probes: [], error: redactTokens(String(e?.message ?? e)) });
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
/**
 * The counts behind the admin tabs' badges.
 *
 * WHY THIS EXISTS. The admin console now loads a tab's data only when that tab
 * is opened, which makes the page fast and creates one problem: if nothing
 * loads until you click, nothing can TELL you a tab needs attention. A review
 * queue nobody can see is one that grows, and an alert that has to be hunted
 * for is one nobody hunts for. Lazy tabs without this are faster and worse.
 *
 * COUNTS, NEVER ROWS. This runs on every page load, so it must stay cheap
 * enough to be worth keeping — `head: true` sends no body at all and Postgres
 * answers from a count rather than a scan. The tab the number belongs to
 * fetches the actual rows when somebody opens it.
 *
 * A FAILING COUNT RETURNS ZERO RATHER THAN FAILING THE REQUEST. These are
 * hints on a tab; one unavailable table should cost its own badge, not the
 * page. Each is logged, because a badge silently stuck at zero is the same
 * class of defect as the gaps this codebase keeps finding — it looks exactly
 * like good news.
 */
app.get('/admin/api/summary', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const count = async (
    label: string,
    build: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
  ): Promise<number> => {
    try {
      const { count: n, error } = await build();
      if (error) {
        console.warn(`[summary] could not count ${label}: ${error.message}`);
        return 0;
      }
      return n ?? 0;
    } catch (e: any) {
      console.warn(`[summary] could not count ${label}: ${e?.message ?? e}`);
      return 0;
    }
  };

  // The window the System Health panel itself uses, so the badge and the panel
  // cannot disagree about what counts as recent.
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const [alerts, pendingNotes, ingestionErrors] = await Promise.all([
    // `.eq('resolved', false)` is what /admin/api/alerts uses. Matched exactly,
    // because a badge that counts differently from the panel it points at is
    // worse than no badge.
    count('open alerts', () =>
      supabaseAdmin
        .from('reconciliation_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('resolved', false)),
    count('pending notes', () =>
      supabaseAdmin
        .from('venue_notes')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')),
    /**
     * NOT `status = 'error'`. checkDataGaps() counts anything that is not
     * `success` or `closed`, because 'closed' is a normal outcome for a venue
     * that does not trade that day and the other failure statuses are not all
     * spelled 'error'. Copied rather than re-derived, so the badge and System
     * Health cannot drift apart.
     */
    count('recent ingestion errors', () =>
      supabaseAdmin
        .from('ingestion_log')
        .select('id', { count: 'exact', head: true })
        .not('status', 'in', '(success,closed)')
        .gte('created_at', since)),
  ]);

  return c.json({ alerts, pending_notes: pendingNotes, ingestion_errors: ingestionErrors });
});

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

/**
 * PUBLIC HEALTH SIGNAL. Counts and a boolean, never the figures.
 *
 * THE LEAK THIS CLOSES, found in the pre-alpha audit on 23 Sep 2026. This route
 * has no authentication -- deliberately, so an external uptime monitor can read
 * it -- and it returned the full report, including `open_alerts`, whose detail
 * string is built as:
 *
 *     Monday $12,345 vs Revel $12,300 (out by $45)
 *
 * beside the venue NAME and the date. So anyone who knew the URL could read
 * daily gross revenue per named venue for up to fifty unresolved alerts,
 * without logging in. RLS was never the problem: the handler queries with the
 * service role, which bypasses it, and the route asked for no session at all.
 *
 * That is BUILD_LOG 4.4 arriving through a different door. There the tables had
 * no RLS; here the table is fine and the route in front of it is not. Both are
 * the same lesson -- a barrier is only where you put it.
 *
 * A monitor needs to know WHETHER something is wrong, never what. The counts
 * make the signal actionable ("three gaps") without naming a venue or a figure,
 * and the full report moved to /admin/api/system, which already requires an
 * owner and is what the admin console actually reads.
 */
app.get('/watchdog', async (c) => {
  const days = Number(c.req.query('days') ?? 3);
  const report = await checkDataGaps(days);
  const knowledgeState = await knowledgeHealth();
  const socialState = await socialFreshness();

  const ok =
    report.missing.length === 0 &&
    report.recent_errors.length === 0 &&
    report.open_alerts.length === 0 &&
    knowledgeState.ok &&
    socialState.ok;

  return c.json({
    healthy: ok,
    checked_at: new Date().toISOString(),
    // Counts only. Naming the venue would say which outlet is in trouble, and
    // the detail strings carry revenue.
    missing: report.missing.length,
    recent_errors: report.recent_errors.length,
    open_alerts: report.open_alerts.length,
    knowledge_ok: knowledgeState.ok,
    social_ok: socialState.ok,
    detail: 'Counts only. The full report is at /admin/api/system and requires an owner session.',
  });
});

/** The full report, for an owner. Unchanged in content; moved behind a session. */
app.get('/admin/api/watchdog', async (c) => {
  const user = await requireOwner(c);
  if (!user) return c.json({ error: 'Admin access required' }, 403);

  const days = Number(c.req.query('days') ?? 3);
  const report = await checkDataGaps(days);
  // A knowledge layer that has silently stopped being readable looks exactly
  // like one nobody has written to yet, so it is checked here rather than
  // left to a log line.
  const knowledge = await knowledgeHealth();
  /**
   * Has the Meta ingest been running at all?
   *
   * Checked here rather than inside the job because the failure that made this
   * necessary was the job never starting -- Ingest-Meta crashed on a missing
   * module for hours on 20 Aug 2026 and nothing said so. Stories expire in ~24h
   * and followers_count has no history at Meta, so an outage here destroys data
   * rather than delaying it. This is the only check on this page watching for
   * ABSENCE of work rather than a fault in work that happened.
   */
  const social = await socialFreshness();
  // Open reconciliation alerts count against health -- they are real problems
  // with the numbers. They are resolvable by a human, which is what keeps this
  // from becoming a permanently-red signal nobody reads.
  const healthy =
    report.missing.length === 0 &&
    report.recent_errors.length === 0 &&
    report.open_alerts.length === 0 &&
    knowledge.ok &&
    social.ok;
  return c.json({ healthy, knowledge, social, ...report });
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

  /**
   * The vendored auth client is the one asset worth caching hard.
   *
   * It is 222 KB (60 KB compressed) and it changes only when supabase-js is
   * upgraded, which has happened less than once a quarter.
   *
   * A DAY rather than a year, because the filename carries no content hash: a
   * year would mean a returning user running an auth client we replaced months
   * ago, including if we replaced it for a security fix. A day bounds that, and
   * within the day every repeat visit costs nothing.
   *
   * MEASURED, because the obvious assumption is wrong: @hono/node-server's
   * serveStatic sends Last-Modified but does NOT answer a conditional request
   * with a 304 -- an If-Modified-Since request for this file comes back 200 with
   * all 227 KB of it. So after the day expires the browser re-downloads rather
   * than revalidating cheaply. That is a bounded cost on one request a day and
   * is not worth either a hashed filename or hand-rolled 304 handling here; it
   * is written down so nobody reasons from the 304 that does not arrive.
   */
  if (c.req.path.startsWith('/vendor/')) {
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set('Cache-Control', 'public, max-age=86400');
    return;
  }

  if (!isShell) return;

  // Rebuilt rather than mutated: a Response's headers are immutable once it
  // has been constructed, so setting on c.res directly silently does nothing.
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set('Cache-Control', 'no-cache, must-revalidate');
});

app.use('/*', async (c, next) => {
  await next();

  const type = c.res.headers.get('Content-Type') ?? '';
  if (!type.includes('text/html')) return;

  const html = await c.res.text();
  const injected = injectConfig(html, {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });

  // Rebuilt rather than mutated: headers on a constructed Response are
  // immutable, and the length has changed.
  const headers = new Headers(c.res.headers);
  headers.delete('Content-Length');
  c.res = new Response(injected, { status: c.res.status, headers });
});

app.use('/*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, async () => {
  console.log(`EyeofSauron API listening on :${port}`);

  // Warn, do not exit. A job that cannot write should stop; a web server that
  // refuses to boot over one missing column takes down every feature that does
  // not touch it, and a degraded app beats a dead one. The point is that the
  // deploy log says so at 15:12 rather than a user finding out at 15:59.
  await warnSchema();
});
