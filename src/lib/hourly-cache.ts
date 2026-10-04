/**
 * Keep the dashboard's slow, slow-changing panels off the critical path.
 *
 * Khai, 4 Oct 2026: "The load of the dashboard is slower a lot."
 *
 * WHAT IS CACHED, AND WHAT IS NEVER CACHED. Sales and covers are what people
 * open the page to see and they stay live on every load. What goes through
 * here is the heavy material that only changes when an INGEST does -- retention
 * for a closed month, cost of sales from the P&L and supplier bills, the
 * forecast's history -- which SevenRooms refreshes hourly at most and Xero and
 * Revel overnight. Recomputing those on every load was paying hundreds of
 * milliseconds to get an answer identical to the one from a minute before.
 *
 * STALE-WHILE-REVALIDATE. An entry has an identity (`key`: which venues, which
 * month) and a freshness token (`token`: the Singapore day and hour). A load
 * with the same key and an older token is served the old value at once and a
 * refresh starts behind it, so the hour turning over costs nobody a wait. Only
 * a key never seen before -- the first load after a deploy, a new month --
 * actually waits for the database.
 *
 * ONE LOAD AT A TIME PER KEY. At five o'clock four managers opening the page
 * would otherwise start four identical queries on a database that was already
 * the slow part. Concurrent callers share the one in flight.
 *
 * IN-PROCESS ON PURPOSE. A restart or a second instance recomputes; nothing
 * here needs to survive one, and a shared cache would be a new piece of
 * infrastructure to fix a problem a Map already solves.
 */

interface Entry<T> { token: string; value: T }

export type CacheState = 'hit' | 'stale' | 'miss';

export class HourlyCache<T> {
  private entries = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(private readonly max = 64) {}

  /**
   * The value for `key`, and how it was obtained.
   *
   * `value` is the promise to await: already settled for a hit or a stale
   * hit, pending for a miss. `state` is known at once, so a caller can decide
   * how long to wait before it has waited at all.
   */
  get(key: string, token: string, load: () => Promise<T>): { state: CacheState; value: Promise<T> } {
    const have = this.entries.get(key);
    if (have && have.token === token) return { state: 'hit', value: Promise.resolve(have.value) };

    const running = this.inflight.get(key) ?? this.start(key, token, load);

    if (have) {
      // Serve what we have; the refresh above runs behind it. A failed refresh
      // keeps the old value rather than replacing it with nothing.
      running.catch(() => {});
      return { state: 'stale', value: Promise.resolve(have.value) };
    }
    return { state: 'miss', value: running };
  }

  private start(key: string, token: string, load: () => Promise<T>): Promise<T> {
    const p = load()
      .then(value => {
        this.set(key, token, value);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private set(key: string, token: string, value: T): void {
    this.entries.delete(key);                       // re-insert as most recent
    this.entries.set(key, { token, value });
    while (this.entries.size > this.max) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  /** For tests. */
  size(): number { return this.entries.size; }
}

/**
 * The value if it settles within `ms`, or `{ timedOut: true }` -- WITHOUT
 * cancelling it. The work carries on and lands in the cache for the next load,
 * which is the point: a slow panel costs the panel on one cold load, never the
 * page.
 *
 * A rejection counts as settled and is passed through, so a failure is reported
 * as a failure and not as slowness.
 */
export async function settleWithin<T>(
  p: Promise<T>, ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  // Swallow a late rejection: nobody is waiting for it any more, and an
  // unhandled rejection can take the process down.
  p.catch(() => {});
  try {
    return await Promise.race([p.then(value => ({ timedOut: false as const, value })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
