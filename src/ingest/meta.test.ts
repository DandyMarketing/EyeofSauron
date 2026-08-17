import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapDiscovered, redactTokens } from './meta.js';

/**
 * These cover the shapes Graph returns, which is the part that surprises you.
 * They do NOT prove the token works or that any account is readable -- that
 * needs a live call, and the only honest test of it is the probe in
 * discoverAccounts.
 */

const noMappings = new Map<string, string | null>();

describe('mapDiscovered — reading what Graph hands back', () => {
  test('a Page with a linked Instagram account yields both', () => {
    const { accounts, errors } = mapDiscovered(
      [{ id: '111', name: 'Fat Prince', instagram_business_account: { id: '222', username: 'fatprincesg' } }],
      noMappings,
    );
    assert.deepEqual(accounts.map(a => [a.platform, a.account_id, a.account_name]), [
      ['facebook', '111', 'Fat Prince'],
      ['instagram', '222', 'fatprincesg'],
    ]);
    assert.equal(accounts[1].page_id, '111');
    assert.deepEqual(errors, []);
  });

  test('a Page with no Instagram account is called out by name', () => {
    // This is the case that looks like a permissions problem and is not. The
    // message has to name the Page, or it sends someone to the wrong screen.
    const { accounts, errors } = mapDiscovered([{ id: '111', name: 'Fat Prince' }], noMappings);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].platform, 'facebook');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Fat Prince/);
    assert.match(errors[0], /no linked Instagram/);
  });

  test('an Instagram entry without an id is treated as absent', () => {
    // Graph has returned the key with nothing useful in it. Pushing an account
    // with `account_id: undefined` would produce a row nobody can map.
    const { accounts, errors } = mapDiscovered(
      [{ id: '111', name: 'Neon Pigeon', instagram_business_account: {} }],
      noMappings,
    );
    assert.equal(accounts.length, 1);
    assert.equal(errors.length, 1);
  });

  test('falls back to name when the handle is missing, then to null', () => {
    const { accounts } = mapDiscovered(
      [
        { id: '1', instagram_business_account: { id: '2', name: 'Firangi Superstar' } },
        { id: '3', instagram_business_account: { id: '4' } },
      ],
      noMappings,
    );
    assert.equal(accounts[1].account_name, 'Firangi Superstar');
    assert.equal(accounts[3].account_name, null);
    // A Page with no name still appears -- it has an id, which is what mapping
    // needs. Dropping it would hide an account from the person setting this up.
    assert.equal(accounts[0].account_id, '1');
  });

  test('says which accounts are already mapped, and to what', () => {
    const mapped = new Map<string, string | null>([
      ['instagram|222', 'Fat Prince'],
      ['facebook|111', null],
    ]);
    const { accounts } = mapDiscovered(
      [{ id: '111', name: 'FP', instagram_business_account: { id: '222', username: 'fatprincesg' } }],
      mapped,
    );
    // Present in social_accounts but with no venue attached is still unmapped
    // as far as anyone reading this list is concerned.
    assert.equal(accounts[0].mapped_venue, null);
    assert.equal(accounts[1].mapped_venue, 'Fat Prince');
  });

  test('nothing readable comes back as nothing, not a crash', () => {
    assert.deepEqual(mapDiscovered([], noMappings), { accounts: [], errors: [] });
    assert.deepEqual(mapDiscovered(undefined as any, noMappings), { accounts: [], errors: [] });
    assert.deepEqual(mapDiscovered([null, {}] as any, noMappings), { accounts: [], errors: [] });
  });

  test('insights_readable starts unknown, never optimistic', () => {
    // Until the probe runs we do not know. `false` would read as "we checked
    // and it failed"; `true` would be a claim we have not earned.
    const { accounts } = mapDiscovered(
      [{ id: '1', instagram_business_account: { id: '2', username: 'x' } }],
      noMappings,
    );
    assert.equal(accounts[0].insights_readable, null);
    assert.equal(accounts[1].insights_readable, null);
  });
});

/**
 * Graph echoes the access token back inside paging.next and paging.previous on
 * every successful insights call. A diagnostic endpoint returned that verbatim,
 * which put a permanent System User token on screen and then into a chat
 * window. The token does not expire, so exposure means rotation.
 */
describe('redactTokens', () => {
  test('strips the token Graph hides in paging URLs', () => {
    const raw = {
      data: [{ name: 'views', total_value: { value: 4519 } }],
      paging: {
        next: 'https://graph.facebook.com/v26.0/178414/insights?access_token=EAAVu5fGyOY8BSOfRT&since=1786924801&metric=views',
        previous: 'https://graph.facebook.com/v26.0/178414/insights?access_token=EAAVu5fGyOY8BSOfRT&since=1786406399',
      },
    };
    const out: any = redactTokens(raw);
    const json = JSON.stringify(out);
    assert.ok(!json.includes('EAAVu5fGyOY8BSOfRT'), 'token still present');
    assert.match(out.paging.next, /access_token=REDACTED/);
    // Everything else must survive -- the whole point is to read the response.
    assert.equal(out.data[0].total_value.value, 4519);
    assert.match(out.paging.next, /metric=views/);
  });

  test('strips it from a JSON field as well as a query string', () => {
    const out: any = redactTokens({ error: { message: 'bad', access_token: 'EAAsecret' } });
    assert.equal(out.error.access_token, 'REDACTED');
  });

  test('handles a bare string, which is what error messages are', () => {
    const out = redactTokens('failed: https://x/y?access_token=EAAsecret&metric=reach');
    assert.equal(out, 'failed: https://x/y?access_token=REDACTED&metric=reach');
  });

  test('leaves a response with no token untouched', () => {
    const raw = { data: [{ name: 'reach', values: [{ value: 12, end_time: '2026-08-15T07:00:00+0000' }] }] };
    assert.deepEqual(redactTokens(raw), raw);
  });
});
