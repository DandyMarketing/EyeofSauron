import '../tests/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapDiscovered, redactTokens, isMetaAuthError, isMetaBlockedError, PLATFORM_METRICS, TOTAL_VALUE_METRICS, TOTAL_VALUE_SINCE_OFFSET_DAYS, ACCOUNT_FIELDS } from './meta.js';

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

/**
 * The day a total_value figure belongs to.
 *
 * Calibrated 17 Aug 2026 against reach, the one metric Meta serves in both
 * forms. A window opened at `since` returns the day BEFORE it: asking for
 * 2026-08-11 gave 2,467, which the dated series puts on 2026-08-10. Seven days
 * compared, seven agreements one day back, zero same-day.
 *
 * These are the observed pairs. If Meta changes this, the arithmetic below
 * fails here rather than silently filing every day against its neighbour --
 * which reconciles perfectly and is wrong everywhere.
 */
describe('total_value day offset', () => {
  const OBSERVED: Array<[string, string]> = [
    ['2026-08-11', '2026-08-10'],
    ['2026-08-12', '2026-08-11'],
    ['2026-08-13', '2026-08-12'],
    ['2026-08-14', '2026-08-13'],
    ['2026-08-15', '2026-08-14'],
    ['2026-08-16', '2026-08-15'],
  ];

  const windowOpensAt = (businessDate: string) =>
    new Date(new Date(`${businessDate}T00:00:00Z`).getTime() + TOTAL_VALUE_SINCE_OFFSET_DAYS * 86_400_000)
      .toISOString().slice(0, 10);

  test('to read a day, the window opens the day after it', () => {
    for (const [askedFor, belongsTo] of OBSERVED) {
      assert.equal(windowOpensAt(belongsTo), askedFor, `${belongsTo} should be read by asking ${askedFor}`);
    }
  });

  test('the offset survives a month boundary', () => {
    assert.equal(windowOpensAt('2026-08-31'), '2026-09-01');
  });

  test('and a year boundary', () => {
    assert.equal(windowOpensAt('2026-12-31'), '2027-01-01');
  });
});

/**
 * Which metrics go down which path. Sending an aggregate-only metric through
 * the daily-series call is what produced a month's total filed as one day.
 */
describe('metric routing', () => {
  test('the two Instagram daily series are the ones proven dated', () => {
    assert.deepEqual(PLATFORM_METRICS.instagram, ['reach', 'follower_count']);
  });

  test('no metric is in both lists', () => {
    // A metric pulled twice would be stored twice, by two different rules,
    // and the second write would silently win.
    for (const platform of Object.keys(PLATFORM_METRICS)) {
      const both = (PLATFORM_METRICS[platform] ?? []).filter(m => (TOTAL_VALUE_METRICS[platform] ?? []).includes(m));
      assert.deepEqual(both, [], `${platform}: ${both.join(', ')}`);
    }
  });

  test('online_followers is in neither -- Meta serves it in no form we can use', () => {
    assert.ok(!PLATFORM_METRICS.instagram.includes('online_followers'));
    assert.ok(!TOTAL_VALUE_METRICS.instagram.includes('online_followers'));
  });

  test('facebook pulls nothing until a working metric name is found', () => {
    assert.deepEqual(PLATFORM_METRICS.facebook, []);
    assert.deepEqual(TOTAL_VALUE_METRICS.facebook, []);
  });
});

/**
 * followers_count (plural, the audience size) versus follower_count (singular,
 * the daily change). One letter apart, one a level and one a change. They must
 * never be pulled by the same path or reported as each other.
 */
describe('account fields versus insights metrics', () => {
  test('the audience size is an account field, not an insights metric', () => {
    assert.deepEqual(ACCOUNT_FIELDS.instagram, ['followers_count']);
    assert.ok(!PLATFORM_METRICS.instagram.includes('followers_count'));
    assert.ok(!TOTAL_VALUE_METRICS.instagram.includes('followers_count'));
  });

  test('the daily change stays an insights metric', () => {
    assert.ok(PLATFORM_METRICS.instagram.includes('follower_count'));
    assert.ok(!ACCOUNT_FIELDS.instagram.includes('follower_count'));
  });

  test('no name appears in two lists on any platform', () => {
    // A metric fetched by two paths would be written twice under two different
    // meanings, and whichever ran last would win silently.
    for (const platform of Object.keys(PLATFORM_METRICS)) {
      const all = [
        ...(PLATFORM_METRICS[platform] ?? []),
        ...(TOTAL_VALUE_METRICS[platform] ?? []),
        ...(ACCOUNT_FIELDS[platform] ?? []),
      ];
      assert.equal(new Set(all).size, all.length, `${platform} has a duplicate metric name`);
    }
  });
});

/**
 * These two decide what a long-running pull does when Meta says no, and they
 * want opposite responses. A block is waited out. A rejected token is not --
 * it needs a human to change a secret, and every hour spent waiting is an hour
 * of stories expiring and follower counts never recorded.
 *
 * Confusing them is not theoretical. Before this existed, an expired token fell
 * through a backfill's catch into "a window Meta has no data for is normal this
 * far back", so the run walked every remaining window, stored nothing, and
 * exited 0 — a dead token reported as a completed backfill.
 */
describe('telling a dead token apart from a throttle', () => {
  test('recognises the ways Meta says the token is no good', () => {
    for (const message of [
      'Meta request failed: 400 {"error":{"message":"Error validating access token: Session has expired"}}',
      'Invalid OAuth access token',
      'The access token could not be decrypted',
      'Meta request failed: 400 (#190) Access token has expired',
      'META_SYSTEM_USER_TOKEN is not set. Create a System User...',
    ]) {
      assert.equal(isMetaAuthError(message), true, message);
    }
  });

  test('a mistyped metric name is NOT an auth failure', () => {
    // Meta stamps type OAuthException on this too. Matching that bare string
    // would turn every bad metric name into a full stop, which is the opposite
    // of the graceful per-metric fallback the ingestion depends on.
    const badMetric =
      'Meta request failed: 400 {"error":{"message":"(#100) The value must be a valid insights metric","type":"OAuthException","code":100}}';
    assert.equal(isMetaAuthError(badMetric), false);
  });

  test('#100 does not trip the #10 permission check', () => {
    // A word boundary, not a prefix match. Without it every (#100) response
    // would read as a permission failure.
    assert.equal(isMetaAuthError('(#100) something'), false);
    assert.equal(isMetaAuthError('(#10) Application does not have permission'), true);
  });

  test('a throttle is a block, not an auth failure', () => {
    // Waiting fixes this one. Reporting it as a dead token would send someone
    // to rotate a perfectly good secret.
    const throttled = 'Meta request failed: 403 API access blocked — too many calls';
    assert.equal(isMetaBlockedError(throttled), true);
    assert.equal(isMetaAuthError(throttled), false);
  });

  test('an ordinary empty window is neither', () => {
    // This one really does mean "keep going".
    const nothing = 'Meta request failed: 400 no data available for this period';
    assert.equal(isMetaAuthError(nothing), false);
    assert.equal(isMetaBlockedError(nothing), false);
  });
});
