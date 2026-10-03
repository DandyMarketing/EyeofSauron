/**
 * The vendored Supabase client is a committed build artefact, and the one way
 * it can hurt anybody is by going stale: package.json gets bumped, nobody
 * re-runs `npm run vendor`, and the browser keeps loading a client older than
 * the one the server talks to. Nothing would say so. This says so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { bannerVersion, versionBanner } from './vendor-supabase.js';

const require_ = createRequire(import.meta.url);

const BUNDLE = 'public/vendor/supabase.js';

function bundle(): string {
  return readFileSync(BUNDLE, 'utf8');
}

function installedVersion(): string {
  const p = require_.resolve('@supabase/supabase-js/package.json');
  return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
}

test('the vendored bundle exists and carries its version', () => {
  const v = bannerVersion(bundle());
  assert.ok(v, `${BUNDLE} has no version banner — regenerate it with: npm run vendor`);
});

test('the vendored bundle matches the installed supabase-js', () => {
  const vendored = bannerVersion(bundle());
  const installed = installedVersion();
  assert.equal(
    vendored,
    installed,
    `${BUNDLE} was built from supabase-js@${vendored} but package.json installs ` +
      `${installed}. Run: npm run vendor`,
  );
});

test('the bundle is self-contained — one request is the whole point', () => {
  const src = bundle();
  // A bare import or an http one would mean the browser still has to fetch
  // something else, which is the failure this replaced. Relative imports are
  // equally wrong: nothing else was emitted into public/vendor/.
  const imports = [...src.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports, [], `bundle still imports: ${imports.join(', ')}`);
  assert.ok(!src.includes('esm.sh'), 'bundle references esm.sh');
});

test('no page loads supabase-js from a third-party host', () => {
  // The point of vendoring is defeated the moment one page is missed, and a
  // page that still works is exactly how a missed one hides.
  const { readdirSync } = require_('node:fs') as typeof import('node:fs');
  const pages = readdirSync('public').filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 5, 'expected the app pages in public/');

  const offenders = pages.filter((f) =>
    readFileSync(`public/${f}`, 'utf8').includes('esm.sh'),
  );
  assert.deepEqual(
    offenders,
    [],
    `these pages still import from esm.sh: ${offenders.join(', ')}`,
  );
});

test('the banner shape the test parses is the shape the script writes', () => {
  // Otherwise the two halves of this check drift apart and every assertion
  // above passes by reading nothing.
  assert.equal(bannerVersion(`${versionBanner('9.9.9')}\nconst a=1;`), '9.9.9');
});
