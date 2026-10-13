import { createClient } from '@supabase/supabase-js';
import { selectAll } from '../lib/paged.js';
import { rowCapFetch } from '../lib/paged.js';
import { hasAcceptedCurrentTerms, termsAcceptanceSummary, TERMS_VERSION } from './terms.js';
import { SessionCache, SingleFlight } from './session-cache.js';
import { describeLastSeen, latestOf } from './last-seen.js';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// rowCapFetch logs any unpaged read that comes back at the 1,000-row cap.
const supabaseAdmin = createClient(url, serviceKey, { global: { fetch: rowCapFetch } });

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  venues: Array<{ venue_id: string; slug: string; role: string }>;
  isOwner: boolean;
  /**
   * Has this person accepted the confidentiality terms CURRENTLY in force?
   *
   * Not "ever accepted anything" -- the version is compared, so a rewrite of
   * the text asks everybody again. See src/auth/terms.ts.
   */
  acceptedTerms: boolean;
}

/**
 * Record an acceptance. Written with the service role, after the session has
 * been validated, so the browser cannot forge one for somebody else or
 * backdate its own.
 */
export async function acceptTerms(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  /**
   * INSERT, never upsert. Each acceptance is an event.
   *
   * This was an upsert keyed on (user_id, terms_version) with
   * ignoreDuplicates, which was correct while an acceptance lasted for ever.
   * Now that it expires annually, that shape silently defeats renewal: the
   * insert collides with the original row, is ignored, and the 2026 timestamp
   * stays put while the person watches the button succeed and the gate keep
   * asking. Migration 043 drops the constraint for the same reason.
   *
   * A double-click writes two rows seconds apart, which is an accurate account
   * of somebody pressing a button twice and is what the read already handles.
   */
  const { error } = await supabaseAdmin
    .from('terms_acceptances')
    .insert({
      user_id: userId,
      terms_version: TERMS_VERSION,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent ?? null,
    });
  if (error) throw new Error(error.message);
  /**
   * Immediately, or the person accepts the terms and the very next request
   * still refuses them — for up to thirty seconds, with no way to tell why.
   * The acceptance IS the thing the cached session was gating on.
   */
  forgetSessions(userId);
}

/**
 * The session cache. See src/auth/session-cache.ts for what is being traded,
 * and session-cache.test.ts for the rules that are asserted.
 */
const sessionCache = new SessionCache<SessionUser>();

/**
 * One validation per token at a time. See SingleFlight for why a cache alone
 * was not enough: twelve simultaneous requests all miss an empty cache.
 */
const inflight = new SingleFlight<SessionUser | null>();

/**
 * Drop cached sessions, so the next request re-reads from the database.
 *
 * Called with a user id after anything that changes what they may see; called
 * with nothing after a change that could affect several people at once.
 */
export function forgetSessions(userId?: string): void {
  sessionCache.forget(userId);
}

/**
 * When somebody last USED Sauron (migration 062), as opposed to when they last
 * signed in -- a session lasts for weeks, so the sign-in time said nothing
 * about daily use (Khai, 13 Oct 2026: "I saw Lukasz logged in today").
 *
 * Called on every signed-in request and written at most once every ten
 * minutes per person per server, so use costs one small write per person per
 * ten minutes. Never awaited and never fails a request: it is a note, not a
 * gate. A failure is logged once, not on every request.
 */
const ACTIVITY_EVERY_MS = 10 * 60 * 1000;
const lastNoted = new Map<string, number>();
let activityWarned = false;
export function noteActivity(userId: string, now: number = Date.now()): void {
  if (now - (lastNoted.get(userId) ?? 0) < ACTIVITY_EVERY_MS) return;
  lastNoted.set(userId, now);
  void Promise.resolve(
    supabaseAdmin.from('profiles').update({ last_active_at: new Date(now).toISOString() }).eq('id', userId),
  ).then(({ error }) => {
    if (error && !activityWarned) {
      activityWarned = true;
      console.warn(`[users] could not record activity (is migration 062 applied?): ${error.message}`);
    }
  }).catch(() => { /* a note, never a failure */ });
}

export async function validateSession(accessToken: string): Promise<SessionUser | null> {
  const cached = sessionCache.get(accessToken);
  if (cached) return cached;

  /**
   * COALESCED, so a burst of simultaneous requests costs one lookup.
   *
   * The cache is checked above and again inside, because between the two a
   * concurrent caller may have finished and populated it.
   */
  return inflight.run(accessToken, () => loadSession(accessToken));
}

async function loadSession(accessToken: string): Promise<SessionUser | null> {
  const cached = sessionCache.get(accessToken);
  if (cached) return cached;

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !user) {
    // A token that no longer validates must not leave an entry behind.
    sessionCache.drop(accessToken);
    return null;
  }

  /**
   * THE THREE READS AT ONCE. They were sequential, and nothing about them is
   * ordered: all three are keyed on the same user id and none feeds another.
   * Three round trips became one, on every request that misses the cache.
   */
  const [{ data: roles }, { data: profile }, termsResult] = await Promise.all([
    // row-cap: one user's roles, a handful of rows.
    supabaseAdmin
      .from('user_venue_roles')
      .select('venue_id, role, venues(slug)')
      .eq('user_id', user.id),
    supabaseAdmin
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .maybeSingle(),
    // row-cap: one user's acceptances, one per terms version.
    supabaseAdmin
      .from('terms_acceptances')
      .select('terms_version, accepted_at')
      .eq('user_id', user.id),
  ]);

  const isOwner = (roles ?? []).some((r: any) => r.role === 'owner');

  /**
   * Resolved on every session, so the answer travels with the caller.
   *
   * Every route that matters already has a SessionUser in hand, which makes
   * this the one place the check cannot be forgotten. Putting it on individual
   * handlers would mean a route added next month silently skips the gate --
   * the same reason enforceDomainScope() sits at the top of handleToolCall
   * rather than inside each tool.
   */
  const { data: acceptances, error: termsError } = termsResult;

  /**
   * "CANNOT CHECK" AND "HAS NOT ACCEPTED" ARE DIFFERENT, and conflating them
   * locks everybody out of a working product.
   *
   * The gate shipped before migration 042 was run, and until it is that table
   * does not exist. The query then ERRORS, data comes back null, nobody looks
   * accepted, /ask returns 403 to every person in the company, and the overlay
   * they are shown cannot be dismissed because the insert behind the button
   * fails against the same missing table. A dead end, on every page, for
   * everyone -- shipped by me and caught by Khai.
   *
   * So a query error means the feature is not ready and costs the FEATURE, not
   * the product: logged loudly, and the person is let through. A query that
   * SUCCEEDS and returns no current row is a real unaccepted user and still
   * gates. Same rule as isWebSearchConfigError() and isModelFeatureError() --
   * a degraded app beats a dead one -- and the same rule the browser half of
   * this gate already follows.
   */
  if (termsError) {
    console.error(
      `[terms] cannot check acceptance (${termsError.message}) — letting ${user.email} through. ` +
      'If migration 042 has not been run, run it: until then nobody is being asked to accept anything.',
    );
  }

  const session: SessionUser = {
    id: user.id,
    email: user.email!,
    fullName: profile?.full_name ?? '',
    acceptedTerms: termsError ? true : hasAcceptedCurrentTerms(acceptances),
    venues: (roles ?? []).map((r: any) => ({
      venue_id: r.venue_id,
      slug: r.venues?.slug ?? '',
      role: r.role,
    })),
    isOwner,
  };

  /**
   * NOT CACHED WHEN THE TERMS READ FAILED. That path deliberately lets the
   * person through so a missing migration cannot lock the company out — a
   * decision about a degraded state, not a fact about the user. Storing it
   * would hold the degraded answer for half a minute after the table came
   * back, and make a fault look intermittent.
   */
  if (!termsError) sessionCache.set(accessToken, session);

  return session;
}

/**
 * Every account's last sign-in, from Supabase Auth.
 *
 * PAGED, because `listUsers` defaults to 50 per page and silently returns the
 * first page only. Fifty is a long way off today and it is exactly the shape of
 * cap that has cost this project data five times — see BUILD_LOG 1.x and the
 * comment on fetchAccountMap().
 *
 * A FAILURE RETURNS AN EMPTY MAP rather than throwing. This is one column on
 * the user list; losing it must not lose the list, which is also how terms
 * acceptances are handled a few lines down.
 */
async function lastSignIns(): Promise<{ seen: Map<string, string | null>; error: string | null }> {
  const seen = new Map<string, string | null>();
  const PER_PAGE = 200;

  for (let page = 1; ; page++) {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (error) {
        console.error(`[users] could not read sign-in times: ${error.message}`);
        return { seen, error: error.message };
      }
      for (const u of data.users) seen.set(u.id, u.last_sign_in_at ?? null);
      if (data.users.length < PER_PAGE) return { seen, error: null };
    } catch (e: any) {
      console.error(`[users] could not read sign-in times: ${e?.message ?? e}`);
      return { seen, error: String(e?.message ?? e) };
    }
  }
}

export async function listUsers() {
  // last_active_at is migration 062; read without it until that is applied.
  let { data: profiles, error: profilesError } = await selectAll(() => supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, created_at, last_active_at'));
  if (profilesError && /last_active_at/.test(profilesError.message)) {
    ({ data: profiles } = await selectAll(() => supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, created_at')));
  }

  const { seen: signedIn, error: signInError } = await lastSignIns();

  const { data: allRoles } = await selectAll(() => supabaseAdmin
    .from('user_venue_roles')
    .select('id, user_id, venue_id, role, venues(name, slug)'));

  /**
   * Acceptances, so the console can answer "has everybody signed?"
   *
   * A record only its subject can read, in a table only Supabase's SQL editor
   * shows, is most of the way to not having a record. The point of keeping it
   * is being able to produce it.
   *
   * A query error is tolerated the same way validateSession tolerates it:
   * before migration 042 is run this table does not exist, and a missing audit
   * column must not take down the user list.
   */
  const { data: acceptances, error: termsError } = await selectAll(() => supabaseAdmin
    .from('terms_acceptances')
    .select('user_id, terms_version, accepted_at'));

  if (termsError) {
    console.error(`[terms] cannot read acceptances for the user list: ${termsError.message}`);
  }

  return (profiles ?? []).map((p: any) => ({
    id: p.id,
    email: p.email,
    full_name: p.full_name,
    created_at: p.created_at,
    /**
     * Both: the timestamp for sorting or hovering, and the sentence for
     * reading. Computed here rather than in the browser because the admin page
     * is plain JS and cannot import this module — the same reason the ingestion
     * error explanations are built server-side.
     */
    last_sign_in_at: signedIn.get(p.id) ?? null,
    /**
     * A FAILED READ IS NOT "NEVER SIGNED IN" (13 Oct 2026: every account,
     * including the owner who uses Sauron daily, showed "Never signed in").
     * The read failing used to leave the map empty, which drew a confident
     * wrong answer on every row. Now the row says it does not know, and why.
     */
    last_active_at: p.last_active_at ?? null,
    /**
     * Each shown on its own line on the admin page (Khai, 13 Oct 2026: "why not
     * just apply it like the last seen" -- it was only in the hover text).
     * Activity starts from the 13 Oct deploy, so "not recorded yet" means not
     * seen since then, not never.
     */
    active_seen: p.last_active_at ? describeLastSeen(p.last_active_at) : { text: 'Not recorded yet', tone: 'never' },
    signin_seen: signInError ? { text: 'Unknown', tone: 'unknown' } : describeLastSeen(signedIn.get(p.id) ?? null),
    /**
     * The LATER of when they last used Sauron and when they last signed in.
     * Use is what "last seen" means; the sign-in still counts for anyone not
     * seen since use began to be recorded.
     */
    last_seen: (() => {
      const seen = latestOf(p.last_active_at ?? null, signedIn.get(p.id) ?? null);
      if (seen) return describeLastSeen(seen);
      if (signInError) return { text: 'Unknown', tone: 'unknown', error: signInError };
      return signedIn.has(p.id) ? describeLastSeen(null) : { text: 'No login account', tone: 'never' };
    })(),
    terms: termsAcceptanceSummary((acceptances ?? []).filter((a: any) => a.user_id === p.id), !!termsError),
    roles: (allRoles ?? [])
      .filter((r: any) => r.user_id === p.id)
      .map((r: any) => ({
        id: r.id,
        venue_id: r.venue_id,
        venue_name: r.venues?.name ?? '',
        venue_slug: r.venues?.slug ?? '',
        role: r.role,
      })),
  }));
}

/**
 * Invite somebody, rather than creating an account with a password we chose.
 *
 * WHY THIS CHANGED. It used to call createUser({ password }) with a password
 * typed into the admin form, which meant the owner knew every user's password.
 * Any action taken under an account was therefore deniable -- "that wasn't me"
 * is unanswerable when somebody else could log in as you -- which undoes the
 * point of recording who agreed to what and who asked what. Now Supabase emails
 * a one-time link, the person sets a password nobody else ever sees, and the
 * admin form has no password field to fill in.
 *
 * `redirectTo` must be an allowed redirect URL in the Supabase dashboard, or
 * the link silently lands on the site root with the token unconsumed. Derived
 * from PUBLIC_APP_URL so a preview deploy invites into itself rather than into
 * production.
 */
/**
 * Correct a person's name (Khai, 13 Oct 2026: "allow to edit the name if put
 * in, to adjust if error"). The name lives on `profiles`, which is where the
 * app reads it -- the greeting, "the person planning" in the event brief, the
 * Monday owner match. The invitation's metadata copy is updated too, so the
 * two never disagree. Their cached session is dropped so it shows at once.
 */
export async function renameUser(userId: string, raw: unknown): Promise<string> {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new Error('A name is required.');
  if (name.length > 120) throw new Error('That name is too long.');
  // row-cap: one profile by id.
  const { data, error } = await supabaseAdmin.from('profiles').update({ full_name: name }).eq('id', userId).select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('That user was not found.');
  // Best effort: the profile is what the app reads.
  await supabaseAdmin.auth.admin.updateUserById(userId, { user_metadata: { full_name: name } }).catch(() => {});
  forgetSessions(userId);
  return name;
}

export async function inviteUser(email: string, fullName: string) {
  const base = (process.env.PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'PUBLIC_APP_URL is not set on this service, so an invitation would carry no link back. ' +
      'Set it to the app\'s address (e.g. https://eyeofsauron-production.up.railway.app) and try again.',
    );
  }

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${base}/set-password.html`,
    data: { full_name: fullName },
  });

  if (error) {
    /**
     * Rate limiting is the failure to expect, and it does not look like one.
     *
     * Supabase's built-in mailer allows only a few messages an hour and is
     * documented as unsuitable for production. Inviting a venue team in one
     * sitting hits it, and the raw message ("email rate limit exceeded") reads
     * like our bug rather than a mailbox that needs configuring.
     */
    if (/rate limit/i.test(error.message)) {
      throw new Error(
        `${error.message} — this is Supabase's built-in mailer, which allows only a few ` +
        'messages an hour. Configure custom SMTP under Project Settings → Authentication ' +
        'before inviting several people at once.',
      );
    }
    throw new Error(error.message);
  }

  return data.user;
}

export async function assignRole(userId: string, venueId: string, role: string) {
  const { data, error } = await supabaseAdmin
    .from('user_venue_roles')
    .upsert({ user_id: userId, venue_id: venueId, role }, { onConflict: 'user_id,venue_id' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  // The grant changes what this person may see, so their cached session is
  // wrong from this moment. Without this the new venue would appear up to
  // thirty seconds late, and a REVOKED one would keep working that long.
  forgetSessions(userId);
  return data;
}

export async function removeRole(roleId: string) {
  const { error } = await supabaseAdmin
    .from('user_venue_roles')
    .delete()
    .eq('id', roleId);
  if (error) throw new Error(error.message);
  /**
   * Everybody, because the row is identified by its OWN id and we never learn
   * whose it was. Clearing the whole cache costs one re-validation per active
   * user and is the only answer that cannot be wrong; holding a revoked role
   * for half a minute is not a trade worth making to save a lookup.
   */
  forgetSessions();
}

export async function deleteUser(userId: string) {
  await supabaseAdmin.from('user_venue_roles').delete().eq('user_id', userId);
  await supabaseAdmin.from('profiles').delete().eq('id', userId);
  // Auth user may not exist for seeded/test profiles — ignore that error
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error && !error.message.includes('not found')) throw new Error(error.message);
  forgetSessions(userId);
}

export async function resetUserPassword(userId: string, newPassword: string) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
  if (error) throw new Error(error.message);
}

export { supabaseAdmin };
