import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { newState, signState, verifyState, buildAuthorizeUrl, isExpired, XERO_SCOPES } from './xero.js';

const KEY = randomBytes(32);
const NOW = Date.parse('2026-08-14T12:00:00Z');

describe('OAuth state — CSRF protection', () => {
  test('a freshly minted state verifies', () => {
    assert.equal(verifyState(KEY, newState(KEY, NOW), NOW), true);
  });

  test('a state signed with another key is rejected', () => {
    // The attack this blocks: someone hands the operator a crafted callback
    // URL and attaches their own Xero organisation to this installation.
    const forged = newState(randomBytes(32), NOW);
    assert.equal(verifyState(KEY, forged, NOW), false);
  });

  test('a tampered nonce is rejected', () => {
    const state = signState(KEY, 'abc', NOW);
    assert.equal(verifyState(KEY, state.replace('abc', 'xyz'), NOW), false);
  });

  test('a tampered timestamp is rejected', () => {
    // Otherwise an expired state could be revived by editing it.
    const state = signState(KEY, 'abc', NOW - 60 * 60_000);
    const revived = state.replace(String(NOW - 60 * 60_000), String(NOW));
    assert.equal(verifyState(KEY, revived, NOW), false);
  });

  test('expires after ten minutes', () => {
    const state = newState(KEY, NOW);
    assert.equal(verifyState(KEY, state, NOW + 9 * 60_000), true);
    assert.equal(verifyState(KEY, state, NOW + 11 * 60_000), false);
  });

  test('a state issued in the future is rejected', () => {
    // It cannot have been minted here, so something else produced it.
    assert.equal(verifyState(KEY, newState(KEY, NOW + 60_000), NOW), false);
  });

  test('malformed states are rejected rather than throwing', () => {
    // These arrive straight off a query string, so they are attacker-supplied.
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '...', 'a.b.']) {
      assert.equal(verifyState(KEY, bad, NOW), false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('two states are never the same', () => {
    assert.notEqual(newState(KEY, NOW), newState(KEY, NOW));
  });
});

describe('buildAuthorizeUrl', () => {
  const url = buildAuthorizeUrl('client-123', 'https://app.example/xero/callback', 'state-abc');
  const parsed = new URL(url);

  test('points at Xero identity', () => {
    assert.equal(parsed.origin + parsed.pathname, 'https://login.xero.com/identity/connect/authorize');
  });

  test('carries the authorization-code parameters', () => {
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('client_id'), 'client-123');
    assert.equal(parsed.searchParams.get('state'), 'state-abc');
  });

  test('the redirect URI survives encoding intact', () => {
    // Xero string-matches this against the app's registered value, and a
    // mismatch fails at the last step with an unhelpful error.
    assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.example/xero/callback');
  });

  test('requests offline_access, without which there is no refresh token', () => {
    const scopes = (parsed.searchParams.get('scope') ?? '').split(' ');
    assert.ok(scopes.includes('offline_access'), 'missing offline_access — the connection would die in 30 minutes');
  });

  test('does NOT ask for the journals scope', () => {
    // The general-ledger Journals endpoint has no granular equivalent, so an
    // app created under granular scopes cannot have it and asking fails consent
    // outright with `invalid_scope`. Tried on 19 Aug 2026; it cost two rounds of
    // reconnecting before the cause was found.
    assert.ok(
      !/accounting\.journals/.test(XERO_SCOPES),
      'journals has no granular scope — requesting it fails the whole consent',
    );
  });

  test('does not request payroll', () => {
    // The security model's strongest protection is not ingesting personal pay
    // at all, and lacking the permission is surer than remembering to filter.
    assert.ok(!/payroll/i.test(XERO_SCOPES), 'payroll scope requested');
  });

  test('uses the GRANULAR profit-and-loss report scope', () => {
    // The broad `accounting.reports.read` is unavailable to any app created on
    // or after 2 March 2026, and Xero rejects the whole authorization with
    // `invalid_scope`. This test exists because older tutorials, and this
    // repo's own history, both show the broad scope.
    assert.ok(XERO_SCOPES.includes('accounting.reports.profitandloss.read'));
    assert.ok(
      !/accounting\.reports\.read/.test(XERO_SCOPES),
      'broad reports scope is rejected outright for apps created after 2 Mar 2026',
    );
  });

  test('spaces between scopes are encoded as %20, not +', () => {
    // A scope list joined by '+' can be read as one long invalid scope name.
    assert.ok(url.includes('%20'), 'scope separator should be %20');
    assert.ok(!/scope=[^&]*\+/.test(url), "scope contains '+' as a separator");
  });

  test('requests no write scope', () => {
    // Sauron reports on the books; it must never be able to change them.
    assert.ok(!XERO_SCOPES.includes('.write'));
    assert.ok(!XERO_SCOPES.includes('payroll'));
    // Granular read scopes all end in .read; offline_access is the exception.
    for (const s of XERO_SCOPES.split(' ')) {
      assert.ok(s === 'offline_access' || s.endsWith('.read'), `${s} is not a read-only scope`);
    }
  });
});

describe('isExpired', () => {
  const future = new Date(NOW + 30 * 60_000).toISOString();

  test('a token with half an hour left is usable', () => {
    assert.equal(isExpired(future, NOW), false);
  });

  test('a past expiry is expired', () => {
    assert.equal(isExpired(new Date(NOW - 1000).toISOString(), NOW), true);
  });

  test('a token expiring within the minute counts as expired', () => {
    // It would otherwise be accepted and then expire mid-request.
    assert.equal(isExpired(new Date(NOW + 30_000).toISOString(), NOW), true);
  });

  test('a missing expiry is treated as expired, forcing a refresh', () => {
    assert.equal(isExpired(null, NOW), true);
    assert.equal(isExpired(undefined, NOW), true);
  });
});
