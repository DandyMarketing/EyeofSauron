/**
 * Put the Supabase config INTO the page, instead of making the page ask for it.
 *
 * WHY. Every page opened with `fetch('/api/config')` — a whole round trip, at
 * the very front of the chain, for two values that are public by design and
 * change only when the project does. Nothing could start until it came back:
 * not the auth client, not the session, not a single query. It was the first
 * wave of three, and it existed to deliver 150 bytes.
 *
 * Inlined, the page has the config before its first line of script runs, and
 * the wave disappears.
 *
 * NOTHING SECRET IS INLINED, and that is checked rather than assumed: these are
 * exactly the two values /api/config has served unauthenticated since it was
 * written. The anon key is meant to be in a browser — it is the key RLS exists
 * to make safe. A test asserts the shape so a third field cannot be added here
 * casually.
 *
 * /api/config STAYS, as the fallback. If this substitution ever fails — a
 * renamed marker, a page added without it — the page fetches as it always did
 * rather than failing to authenticate, which is the difference between losing
 * an optimisation and losing the app.
 */
export function injectConfig(html: string, cfg: { supabaseUrl?: string; supabaseAnonKey?: string }): string {
  const marker = '<!--SAURON_CONFIG-->';
  if (!html.includes(marker)) return html;

  /**
   * `</script` is the one sequence that can break out of a script block, and
   * these values come from the environment rather than from a user — but an
   * environment variable is still not a literal, and the cost of being careful
   * here is one replace.
   */
  const json = JSON.stringify({
    supabaseUrl: cfg.supabaseUrl ?? '',
    supabaseAnonKey: cfg.supabaseAnonKey ?? '',
  }).replace(/</g, '\\u003c');

  return html.replace(marker, `<script>window.__SAURON_CONFIG__=${json};</script>`);
}

