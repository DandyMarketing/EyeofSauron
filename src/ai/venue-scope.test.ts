import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { enforceVenueScope, scopeVenues, ALLOWED_VENUES } from './venue-scope.js';

/**
 * Tenant isolation. BUILD_LOG 4.1 records that venue isolation was, for a
 * time, enforced nowhere: RLS looked like the boundary while the service-role
 * key bypassed it. These tests exist so that boundary is proven on every run
 * rather than asserted in a review — and so the coming access-level / function
 * split has something to break against.
 */

const ALL = ['neon-pigeon', 'fat-prince', 'super-firangi'];
const ONE = ['neon-pigeon'];

describe('enforceVenueScope — a named venue', () => {
  test('permits a venue the caller holds', () => {
    const input: Record<string, any> = { venue_slug: 'neon-pigeon' };
    assert.equal(enforceVenueScope(input, ONE), null);
    assert.equal(input.venue_slug, 'neon-pigeon');
  });

  test('refuses a venue the caller does not hold', () => {
    const input: Record<string, any> = { venue_slug: 'fat-prince' };
    const denied = enforceVenueScope(input, ONE);
    assert.ok(denied, 'expected a refusal, got null (call would have proceeded)');
    assert.match(denied, /do not have access to venue "fat-prince"/);
  });

  test('refusal names only the venues the caller may see', () => {
    const input: Record<string, any> = { venue_slug: 'fat-prince' };
    const denied = enforceVenueScope(input, ONE)!;
    assert.ok(denied.includes('neon-pigeon'));
    assert.ok(!denied.includes('super-firangi'), 'leaked a venue the caller cannot see');
  });
});

describe('enforceVenueScope — a list of venues', () => {
  test('drops the venues the caller does not hold', () => {
    const input: Record<string, any> = { venue_slugs: ['neon-pigeon', 'fat-prince'] };
    assert.equal(enforceVenueScope(input, ONE), null);
    assert.deepEqual(input.venue_slugs, ['neon-pigeon']);
  });

  test('refuses when nothing in the list is permitted', () => {
    const input: Record<string, any> = { venue_slugs: ['fat-prince', 'super-firangi'] };
    const denied = enforceVenueScope(input, ONE);
    assert.ok(denied, 'expected a refusal, got null');
    assert.match(denied, /do not have access to those venues/);
  });
});

describe('enforceVenueScope — no venue named', () => {
  /**
   * The dangerous case. Several handlers read a missing venue as "every
   * venue", so an unscoped call from a restricted caller would return the
   * whole group. The allow-list must be stamped onto the input instead.
   */
  test('stamps the allow-list so "all venues" handlers stay in scope', () => {
    const input: Record<string, any> = {};
    assert.equal(enforceVenueScope(input, ONE), null);
    assert.deepEqual(input[ALLOWED_VENUES], ONE);
  });

  test('copies the allow-list rather than aliasing the caller’s array', () => {
    const allowed = [...ONE];
    const input: Record<string, any> = {};
    enforceVenueScope(input, allowed);
    input[ALLOWED_VENUES].push('fat-prince');
    assert.deepEqual(allowed, ONE, 'mutating the input widened the caller’s own grant');
  });
});

describe('enforceVenueScope — hostile input', () => {
  /**
   * The tool input is produced by the model, so every field on it is
   * attacker-influenced in the limit. A scope grant arriving on the input
   * must never be believed.
   */
  test('overwrites an allow-list supplied on the tool input', () => {
    const input: Record<string, any> = { [ALLOWED_VENUES]: ALL };
    enforceVenueScope(input, ONE);
    assert.deepEqual(input[ALLOWED_VENUES], ONE, 'model-supplied scope survived');
  });

  test('overwrites a supplied allow-list even when a permitted venue is named', () => {
    const input: Record<string, any> = { venue_slug: 'neon-pigeon', [ALLOWED_VENUES]: ALL };
    assert.equal(enforceVenueScope(input, ONE), null);
    assert.deepEqual(input[ALLOWED_VENUES], ONE, 'model-supplied scope survived the happy path');
  });
});

describe('enforceVenueScope — a caller with no venues at all', () => {
  /**
   * A user can be authenticated and hold zero venue grants: newly invited, or
   * revoked via removeAllRoles(). An empty grant must mean "nothing", never
   * "everything" — the classic fail-open.
   */
  test('refuses a named venue', () => {
    const input: Record<string, any> = { venue_slug: 'neon-pigeon' };
    assert.ok(enforceVenueScope(input, []), 'a caller with no grants was allowed a venue');
  });

  test('yields an empty allow-list when no venue is named', () => {
    const input: Record<string, any> = {};
    enforceVenueScope(input, []);
    assert.deepEqual(input[ALLOWED_VENUES], []);
    assert.deepEqual(scopeVenues([{ slug: 'neon-pigeon' }], input), []);
  });
});

describe('scopeVenues', () => {
  test('filters a venue list to the caller’s allow-list', () => {
    const input: Record<string, any> = {};
    enforceVenueScope(input, ONE);
    const rows = ALL.map(slug => ({ slug, gross: 1 }));
    assert.deepEqual(scopeVenues(rows, input).map(r => r.slug), ['neon-pigeon']);
  });

  test('returns everything when no allow-list was stamped (the owner path)', () => {
    const rows = ALL.map(slug => ({ slug }));
    assert.equal(scopeVenues(rows, {}).length, 3);
  });
});
