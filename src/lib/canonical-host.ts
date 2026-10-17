/**
 * Sauron's own address is sauron.staydandy.com (Khai, 13 Oct 2026). The old
 * Railway address keeps working -- bookmarks, links in earlier emails, phones
 * that saved it -- by sending each request on to the same path at the new one.
 *
 * OFF until switched on (REDIRECT_TO_PUBLIC_URL=true), because PUBLIC_APP_URL
 * is set as part of the move and the redirect must not start before the new
 * address answers: switched on early, it would send everybody to a page that
 * does not load yet.
 *
 * Pure, so it is tested: returns the URL to send the browser to, or null.
 */
export function canonicalRedirect(requestUrl: string, env: Record<string, string | undefined>, method = 'GET'): string | null {
  if (env.REDIRECT_TO_PUBLIC_URL !== 'true') return null;
  // Only a page being OPENED moves. A POST, PUT or DELETE is a machine sending
  // data -- n8n delivering Revel's files to /ingest/revel -- and a redirect
  // loses it: clients re-send a 301'd POST as a GET with no body. From 14 Oct
  // 2026 every nightly Revel delivery failed this way, silently, for four
  // nights. Anything that is not GET or HEAD is answered where it lands.
  if (method !== 'GET' && method !== 'HEAD') return null;
  const target = (env.PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(target)) return null;
  const req = new URL(requestUrl);
  const want = new URL(target);
  if (req.host === want.host) return null;
  // /version answers on both, so a deploy can be checked on either address.
  if (req.pathname === '/version') return null;
  // Only the old Railway address moves. Anything else reaching this server --
  // a health check, localhost -- is left alone rather than bounced.
  if (!req.host.endsWith('.up.railway.app')) return null;
  return want.origin + req.pathname + req.search;
}
