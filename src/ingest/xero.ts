import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { encrypt, decrypt, loadKey } from '../lib/crypto.js';

/**
 * Xero OAuth2 and token management.
 *
 * The one thing to understand before changing anything here: Xero ROTATES
 * refresh tokens. Every refresh returns a new refresh token and invalidates
 * the one you used. If a refresh succeeds and the new token is not persisted,
 * the connection is permanently dead and a human has to re-authorise it. So
 * the store is always written before the new access token is used, and a
 * failure to store is treated as a failure of the whole refresh.
 */

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

/**
 * offline_access is mandatory -- without it Xero issues no refresh token at
 * all and the connection dies after thirty minutes.
 *
 * The report scope MUST be the granular one. Xero replaced the broad
 * `accounting.reports.read` with per-report scopes, and an app created on or
 * after 2 March 2026 has no access to the broad scopes at all -- the
 * authorization request fails outright with `invalid_scope`. This app was
 * created after that date. Do not "simplify" this back to the broad scope:
 * older tutorials and older Sauron history both show it, and it will not work.
 *
 * Deliberately no write scopes: Sauron reports on the books, it never touches
 * them. Deliberately no settings scope either -- the P&L report carries its
 * own account names, so the chart of accounts is not needed to read it. If a
 * later feature needs it, add the scope and re-authorise rather than asking
 * for access now on the chance it becomes useful.
 */
/**
 * What we ask Xero for, and nothing more.
 *
 * Scopes are fixed at CONSENT time, not at call time -- so adding one means
 * every organisation reconnects through the OAuth flow again. That friction is
 * the reason these are chosen together rather than one at a time, and it is
 * also the reason not to reach for the wildcard `accounting.transactions` write
 * scopes: this system reads a ledger and will never post to one.
 *
 * `accounting.journals.read` is the general ledger -- every posting, its
 * account, and the document behind it. It is what turns "marketing cost 26,034"
 * into "on what".
 *
 * `accounting.transactions.read` is the source documents those postings point
 * at: the supplier bills, with their line items and the contact they came from.
 * A journal alone gives an account and a reference; this is what makes the
 * reference a name.
 *
 * NOT requested: payroll scopes. The security model's strongest protection is
 * not ingesting personal pay at all, and the surest way to honour that is to
 * lack the permission rather than to remember to filter.
 */
/**
 * PROVEN scopes only. Anything unproven goes through XERO_SCOPES first.
 *
 * Two lessons are baked in here, both paid for.
 *
 * GRANULAR, not `accounting.reports.read`. The broad reports scope is
 * unavailable to any app created on or after 2 March 2026, and Xero rejects the
 * entire authorization with `invalid_scope`. A test already guarded this and it
 * caught the mistake being made a second time.
 *
 * NO `accounting.journals.read`. The general-ledger Journals endpoint is not
 * available under the granular scope model at all -- there is no granular
 * equivalent, and asking for it fails consent outright. Connections made before
 * the cutover keep it; ours cannot have it. That closes the ledger drill-down,
 * and supplier BILLS are the way to the same answer: a bill carries a supplier,
 * a description and line items coded to an account, where a journal line
 * carries only a code.
 *
 * Xero names no offending scope when it refuses, so anything new is added ALONE
 * and via the environment variable, never straight into this list.
 */
const DEFAULT_XERO_SCOPES = [
  'offline_access',
  'accounting.reports.profitandloss.read',
  // Supplier bills, which are invoices of type ACCPAY. Accepted by Xero's
  // consent screen on 19 Aug 2026 -- though the screen listed only the P&L
  // report, so whether it truly granted is proven by calling the endpoint
  // rather than by reading the consent text.
  'accounting.invoices.read',
].join(' ');

/**
 * Overridable by XERO_SCOPES, because getting this list wrong is expensive.
 *
 * Xero validates scopes at its CONSENT screen and rejects the whole request
 * with `invalid_scope` -- it does not say which one it disliked. And every
 * attempt costs a trip through the OAuth flow for each organisation, so
 * narrowing it down by editing code and redeploying turns a five-minute
 * question into an afternoon.
 *
 * As an environment variable it is one Railway edit and a restart per attempt.
 * Set it back to unset once a working list is known, so the default in code
 * stays the documented truth rather than drifting behind a variable nobody
 * remembers is set.
 */
export const XERO_SCOPES = process.env.XERO_SCOPES?.trim() || DEFAULT_XERO_SCOPES;

/** How close to expiry an access token is treated as already expired. */
const EXPIRY_SKEW_MS = 60_000;

/** How long an authorization attempt stays valid. */
const STATE_TTL_MS = 10 * 60_000;

export interface XeroTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface XeroTenant {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

// ---------------------------------------------------------------------------
// CSRF state — pure, and therefore testable without a browser or a database
// ---------------------------------------------------------------------------

/**
 * Sign a state value for the OAuth round trip.
 *
 * Stateless by design: the signature and timestamp travel in the value, so
 * there is no pending-authorization table to write, expire, or leak. Without
 * this an attacker could hand someone a crafted callback URL and attach their
 * own Xero organisation to this installation.
 */
export function signState(key: Buffer, nonce: string, issuedAtMs: number): string {
  const payload = `${nonce}.${issuedAtMs}`;
  const mac = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function newState(key: Buffer, nowMs: number): string {
  return signState(key, randomBytes(16).toString('base64url'), nowMs);
}

/** Verify a returned state: correct signature, and not stale. */
export function verifyState(key: Buffer, state: string, nowMs: number): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, mac] = parts;

  const expected = createHmac('sha256', key).update(`${nonce}.${issuedAt}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Constant-time: a length check first, because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return false;
  // Reject a future timestamp too -- it means the value was not minted here.
  return issued <= nowMs && nowMs - issued <= STATE_TTL_MS;
}

/** Build the URL the operator is sent to in order to approve access. */
export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  // Built with encodeURIComponent rather than URLSearchParams, which encodes a
  // space as '+'. That is correct for a form body and ambiguous in a query
  // string -- a scope list joined by '+' can be read as one long invalid scope
  // name. %20 is unambiguous, and this is not a place to leave a second
  // possible cause of `invalid_scope` lying around.
  const params = [
    ['response_type', 'code'],
    ['client_id', clientId],
    ['redirect_uri', redirectUri],
    ['scope', XERO_SCOPES],
    ['state', state],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${AUTHORIZE_URL}?${params}`;
}

/** Is this access token expired, or close enough that it will be mid-request? */
export function isExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - EXPIRY_SKEW_MS <= nowMs;
}

// ---------------------------------------------------------------------------
// Xero HTTP
// ---------------------------------------------------------------------------

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function postToken(body: URLSearchParams): Promise<XeroTokens> {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('XERO_CLIENT_ID and XERO_CLIENT_SECRET must be set in the environment');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': basicAuth(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    // Xero's token errors are terse; include the body or this is undebuggable.
    throw new Error(`Xero token request failed: ${res.status} ${text}`);
  }
  return JSON.parse(text) as XeroTokens;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<XeroTokens> {
  return postToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }));
}

/** Which organisations did the operator just grant access to? */
export async function fetchTenants(accessToken: string): Promise<XeroTenant[]> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Xero connections request failed: ${res.status} ${await res.text()}`);
  }
  return await res.json() as XeroTenant[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function tokenKey(): Buffer {
  return loadKey(process.env.XERO_TOKEN_KEY);
}

/**
 * Record the organisations from a successful authorization.
 *
 * Every tenant gets the same token pair -- one Xero authorization covers all
 * the organisations the user approved. venue_id is left alone: a new tenant
 * starts unmapped, and an existing one keeps whatever mapping a human already
 * confirmed.
 */
export async function storeConnection(tenants: XeroTenant[], tokens: XeroTokens): Promise<number> {
  const key = tokenKey();
  const accessEncrypted = encrypt(tokens.access_token, key);
  const refreshEncrypted = encrypt(tokens.refresh_token, key);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  for (const tenant of tenants) {
    const { error } = await supabase
      .from('xero_connections')
      .upsert({
        tenant_id: tenant.tenantId,
        tenant_name: tenant.tenantName,
        access_token_encrypted: accessEncrypted,
        refresh_token_encrypted: refreshEncrypted,
        access_expires_at: expiresAt,
        last_refreshed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      }, { onConflict: 'tenant_id' });

    if (error) throw new Error(`Failed to store Xero connection: ${error.message}`);
  }
  return tenants.length;
}

/**
 * A usable access token for this tenant, refreshing if needed.
 *
 * The ordering below is the whole point. Xero invalidates the old refresh
 * token the instant the new pair is issued, so the new pair is written to the
 * database BEFORE the access token is returned to a caller. If the write
 * fails, the refresh is reported as failed even though Xero considers it
 * successful -- because the alternative is a connection that looks healthy and
 * is permanently unauthorised, discoverable only when the next refresh fails.
 */
export async function getAccessToken(tenantId: string): Promise<string> {
  const key = tokenKey();

  const { data: conn, error } = await supabase
    .from('xero_connections')
    .select('tenant_id, access_token_encrypted, refresh_token_encrypted, access_expires_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error || !conn) throw new Error(`No Xero connection for tenant ${tenantId}`);
  if (!conn.refresh_token_encrypted) throw new Error(`Xero connection for ${tenantId} has no refresh token — reconnect required`);

  if (!isExpired(conn.access_expires_at, Date.now()) && conn.access_token_encrypted) {
    return decrypt(conn.access_token_encrypted, key);
  }

  const refreshToken = decrypt(conn.refresh_token_encrypted, key);
  let tokens: XeroTokens;
  try {
    tokens = await postToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }));
  } catch (e: any) {
    await supabase
      .from('xero_connections')
      .update({ status: 'error', last_error: e.message, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId);
    throw e;
  }

  const { error: writeError } = await supabase
    .from('xero_connections')
    .update({
      access_token_encrypted: encrypt(tokens.access_token, key),
      refresh_token_encrypted: encrypt(tokens.refresh_token, key),
      access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('tenant_id', tenantId);

  if (writeError) {
    // Xero has already rotated. The token in hand works, but the one we can
    // reach is dead -- so fail now, loudly, rather than let the connection
    // appear healthy until the next refresh discovers it is unauthorised.
    throw new Error(
      `Xero token refreshed but the new refresh token could not be stored (${writeError.message}). ` +
      `The old refresh token is now invalid — this connection must be re-authorised.`,
    );
  }

  return tokens.access_token;
}
