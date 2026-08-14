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
 * all and the connection dies after thirty minutes. The other two are the
 * minimum for a P&L: the report itself, and the chart of accounts to read it
 * against. Deliberately no write scopes: Sauron reports on the books, it does
 * not touch them.
 */
export const XERO_SCOPES = [
  'offline_access',
  'accounting.reports.read',
  'accounting.settings.read',
].join(' ');

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
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: XERO_SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
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
