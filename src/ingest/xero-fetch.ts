/**
 * A Xero request that survives Xero's own bad moments (22 Nov 2026).
 *
 * The nightly job asked for Fat Prince's November P&L and Xero answered 500,
 * "An error occurred in Xero. Check the API Status page" -- a failure on
 * Xero's side, gone by the next request. Nothing retried it, so the run
 * failed, Railway showed a crash, and (worse) the venue's bills and sales
 * invoices for the month were never fetched that night either.
 *
 * Retried: 429 (rate limit, honouring Retry-After up to a minute) and
 * 500/502/503/504 (Xero having a moment). Not retried: 400, 401, 403, 404 --
 * those are about OUR request or our connection, and asking again cannot
 * change the answer.
 */

export const XERO_RETRIES = 3;
const BASE_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 60_000;

export function isRetryableXero(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** How long to wait before attempt `attempt` (1-based retry count). */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const secs = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

export async function xeroFetch(
  url: string,
  init: RequestInit,
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; log?: (msg: string) => void } = {},
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const log = deps.log ?? (m => console.warn(m));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (e) {
      // A dropped connection is the network's moment, not an answer.
      if (attempt >= XERO_RETRIES) throw e;
      const wait = retryDelayMs(attempt + 1, null);
      log(`[xero] request failed (${String((e as any)?.message ?? e).slice(0, 80)}) -- retry ${attempt + 1}/${XERO_RETRIES} in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (res.ok || !isRetryableXero(res.status) || attempt >= XERO_RETRIES) return res;
    const wait = retryDelayMs(attempt + 1, res.headers.get('retry-after'));
    log(`[xero] HTTP ${res.status} -- retry ${attempt + 1}/${XERO_RETRIES} in ${wait}ms`);
    await res.text().catch(() => '');   // free the connection before waiting
    await sleep(wait);
  }
}
