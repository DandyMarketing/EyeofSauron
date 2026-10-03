/**
 * The config is substituted into each page by the server, which means a
 * silent failure is possible in a way a fetch never was: the marker gets
 * renamed, nothing is injected, and the page falls back to fetching — working
 * exactly as before, a round trip slower, with nothing to say so.
 *
 * The fallback is deliberate and is what keeps a failed substitution from
 * breaking authentication. These assertions are what keep it from being the
 * normal path.
 *
 * injectConfig lives in src/lib/ rather than in server.ts so this file can
 * simply IMPORT it. server.ts constructs a Supabase client and an Anthropic
 * client at module scope and starts listening, so a test that imported it would
 * need credentials and would boot a server — which is how a function ends up
 * copied into its own test and quietly drifting from the one that runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { injectConfig } from '../lib/inject-config.js';

const CFG = { supabaseUrl: 'https://abc.supabase.co', supabaseAnonKey: 'anon-key-123' };

test('the marker is replaced with a usable config', () => {
  const out = injectConfig('<head><!--SAURON_CONFIG--></head>', CFG);
  assert.ok(!out.includes('<!--SAURON_CONFIG-->'), 'the marker survived');
  assert.match(out, /window\.__SAURON_CONFIG__=\{/);
  assert.ok(out.includes('https://abc.supabase.co'));
  assert.ok(out.includes('anon-key-123'));
});

test('ONLY the two public values are inlined', () => {
  /**
   * The whole safety argument for putting this in the page is that these are
   * exactly the values /api/config has served unauthenticated since it was
   * written. A third field added here casually — a service key, a token — would
   * be published to every visitor of the login page.
   */
  const out = injectConfig('<!--SAURON_CONFIG-->', {
    ...CFG,
    // Pretend somebody passed the whole environment in.
    ...({ SUPABASE_SERVICE_ROLE_KEY: 'super-secret', ANTHROPIC_API_KEY: 'sk-secret' } as any),
  });
  assert.ok(!out.includes('super-secret'), 'a service key reached the page');
  assert.ok(!out.includes('sk-secret'), 'an API key reached the page');

  const json = JSON.parse(out.match(/__SAURON_CONFIG__=(\{.*?\});/)![1]);
  assert.deepEqual(
    Object.keys(json).sort(),
    ['supabaseAnonKey', 'supabaseUrl'],
    'the inlined object gained a field — every one of these is public to anyone who opens the page',
  );
});

test('a value cannot break out of the script block', () => {
  // These come from the environment rather than a user, but an environment
  // variable is not a literal and the cost of being careful is one replace.
  const out = injectConfig('<!--SAURON_CONFIG-->', {
    supabaseUrl: '</script><script>alert(1)</script>',
    supabaseAnonKey: 'k',
  });
  assert.ok(!out.includes('</script><script>alert(1)'), `escaped out of the block: ${out}`);
  assert.ok(out.includes('\\u003c/script'), 'the < should have been escaped');
});

test('a page without the marker is returned untouched', () => {
  // The fallback path. It must be a no-op, not a throw: upload.html is a
  // redirect stub with no script at all.
  const html = '<html><body>nothing here</body></html>';
  assert.equal(injectConfig(html, CFG), html);
});

test('missing environment values produce empty strings, not "undefined"', () => {
  // The page checks `if (!cfg.supabaseUrl)` and shows "Auth not configured".
  // The string "undefined" is truthy and would sail past that check into a
  // createClient call that fails somewhere far less obvious.
  const out = injectConfig('<!--SAURON_CONFIG-->', {});
  assert.ok(!out.includes('undefined'), `"undefined" reached the page: ${out}`);
  const json = JSON.parse(out.match(/__SAURON_CONFIG__=(\{.*?\});/)![1]);
  assert.equal(json.supabaseUrl, '');
  assert.equal(json.supabaseAnonKey, '');
});

test('every page carries the marker exactly once', () => {
  // Twice would inject twice and the second would win — harmless today and
  // exactly the sort of thing that stops being harmless.
  for (const page of readdirSync('public').filter(f => f.endsWith('.html'))) {
    const html = readFileSync(`public/${page}`, 'utf8');
    const count = html.split('<!--SAURON_CONFIG-->').length - 1;
    // upload.html is a redirect stub with no script; it needs no config.
    if (!html.includes('/vendor/supabase.js')) {
      assert.equal(count, 0, `public/${page} has a config marker but never loads the auth client`);
      continue;
    }
    assert.equal(count, 1, `public/${page} has ${count} config markers, expected exactly 1`);
  }
});
