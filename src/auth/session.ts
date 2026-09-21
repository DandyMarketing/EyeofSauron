import { createClient } from '@supabase/supabase-js';
import { hasAcceptedCurrentTerms, TERMS_VERSION } from './terms.js';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(url, serviceKey);

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
  const { error } = await supabaseAdmin
    .from('terms_acceptances')
    .upsert(
      {
        user_id: userId,
        terms_version: TERMS_VERSION,
        ip: meta.ip ?? null,
        user_agent: meta.userAgent ?? null,
      },
      // Pressing the button twice is not two agreements. ignoreDuplicates keeps
      // the FIRST timestamp, which is the one that happened.
      { onConflict: 'user_id,terms_version', ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
}

export async function validateSession(accessToken: string): Promise<SessionUser | null> {
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !user) return null;

  const { data: roles } = await supabaseAdmin
    .from('user_venue_roles')
    .select('venue_id, role, venues(slug)')
    .eq('user_id', user.id);

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .maybeSingle();

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
  const { data: acceptances } = await supabaseAdmin
    .from('terms_acceptances')
    .select('terms_version')
    .eq('user_id', user.id);

  return {
    id: user.id,
    email: user.email!,
    fullName: profile?.full_name ?? '',
    acceptedTerms: hasAcceptedCurrentTerms(acceptances),
    venues: (roles ?? []).map((r: any) => ({
      venue_id: r.venue_id,
      slug: r.venues?.slug ?? '',
      role: r.role,
    })),
    isOwner,
  };
}

export async function listUsers() {
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, created_at');

  const { data: allRoles } = await supabaseAdmin
    .from('user_venue_roles')
    .select('id, user_id, venue_id, role, venues(name, slug)');

  return (profiles ?? []).map((p: any) => ({
    id: p.id,
    email: p.email,
    full_name: p.full_name,
    created_at: p.created_at,
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
  return data;
}

export async function removeRole(roleId: string) {
  const { error } = await supabaseAdmin
    .from('user_venue_roles')
    .delete()
    .eq('id', roleId);
  if (error) throw new Error(error.message);
}

export async function deleteUser(userId: string) {
  await supabaseAdmin.from('user_venue_roles').delete().eq('user_id', userId);
  await supabaseAdmin.from('profiles').delete().eq('id', userId);
  // Auth user may not exist for seeded/test profiles — ignore that error
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error && !error.message.includes('not found')) throw new Error(error.message);
}

export async function resetUserPassword(userId: string, newPassword: string) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
  if (error) throw new Error(error.message);
}

export { supabaseAdmin };
