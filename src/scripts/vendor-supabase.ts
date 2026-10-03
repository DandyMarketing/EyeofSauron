/**
 * Bundle the Supabase browser client into public/vendor/, so no page has to
 * reach esm.sh to log a user in.
 *
 * WHY THIS EXISTS. Every page in this app opened with the same six-step serial
 * waterfall, and step two was `import('https://esm.sh/@supabase/supabase-js@2')`
 * -- a third-party host, cold, before anything could be drawn. Measured from
 * this container: dns 0.03ms, connect 0.6ms, **tls 302ms**, total 349ms for a
 * 531-byte file. Those 531 bytes are a re-export shim that then imports six
 * more modules -- auth-js, realtime-js, storage-js, postgrest-js, functions-js
 * -- about 181 KB across seven-plus further requests, each of which the browser
 * can only discover once the one before it has arrived. A third-party module
 * graph is the worst possible shape for a critical path: serial by
 * construction, and nothing about it is under our control.
 *
 * Served from our own origin the whole thing is ONE request on a connection
 * that is already open and already warm, because the HTML came down it.
 *
 * THE OUTPUT IS COMMITTED TO GIT, deliberately, rather than built on deploy.
 * esbuild is only here transitively through tsx; making a page's ability to
 * authenticate depend on a package nobody declared is how a dependency bump
 * takes the login screen down. Committed, the file ships with the commit that
 * made it, a reviewer can see exactly what reaches a browser, and Railway's
 * build step does not change.
 *
 * The cost of that choice is that the bundle can go stale against
 * package.json, silently -- which is this codebase's recurring failure mode,
 * so it is not left to memory. The installed version is stamped into the first
 * line and `vendor-supabase.test.ts` asserts it still matches, so a
 * supabase-js upgrade that forgets to re-run this fails the suite instead of
 * shipping a client two versions behind the server's.
 *
 *   npm run vendor
 *
 * WHAT IS NOT DONE HERE, and why. We only ever touch `.auth` -- getSession,
 * signOut, updateUser, onAuthStateChange, signInWithPassword, setSession,
 * resetPasswordForEmail -- so realtime, storage, postgrest and functions are
 * roughly three quarters of this file and pure waste. Bundling `@supabase/auth-js`
 * alone would cut it, and it is NOT a drop-in: `createClient` derives the
 * storage key (`sb-<project-ref>-auth-token`) and sets up token auto-refresh
 * and the URL-hash session detection that the password-reset and
 * set-password pages depend on. Get the storage key wrong and every signed-in
 * user is logged out; get detectSessionInUrl wrong and password reset breaks
 * for the people least able to report it. That is a change to make on its own,
 * with the auth flows tested, not as a footnote to a speed fix.
 */

import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const PKG = '@supabase/supabase-js';
const OUT = 'public/vendor/supabase.js';

/** The marker the staleness test reads. Keep the shape; it is parsed. */
export function versionBanner(version: string): string {
  return `/* vendored ${PKG}@${version} — regenerate with: npm run vendor */`;
}

/** Pull the version out of a vendored bundle. Null if the banner is absent. */
export function bannerVersion(source: string): string | null {
  const m = source.match(/^\/\* vendored @supabase\/supabase-js@([^\s]+) /);
  return m ? m[1] : null;
}

async function main(): Promise<void> {
  const pkgPath = require_.resolve(`${PKG}/package.json`);
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string };

  // The published ESM build, not the TypeScript source: it is already the
  // browser entry point the exports map points `import` at, so we are
  // flattening the module graph rather than re-compiling the library.
  const entry = pkgPath.replace(/package\.json$/, 'dist/index.mjs');

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (result.warnings.length) {
    for (const w of result.warnings) console.warn(`  warning: ${w.text}`);
  }

  const code = result.outputFiles[0].text;
  await writeFile(OUT, `${versionBanner(pkg.version)}\n${code}`, 'utf8');

  const bytes = Buffer.byteLength(code, 'utf8');
  console.log(`${OUT}  ${PKG}@${pkg.version}  ${(bytes / 1024).toFixed(1)} KB`);
  console.log('Served gzipped by hono/compress — see src/server.ts.');
}

// Importable by the test without running the build.
if (process.argv[1] && process.argv[1].endsWith('vendor-supabase.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
