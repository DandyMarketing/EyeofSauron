/**
 * Validated sessions, held briefly, because authentication runs on EVERY
 * request.
 *
 * WHY THIS EXISTS. Loading the admin page issues twelve authenticated requests,
 * and each one called validateSession, and validateSession made FOUR round
 * trips to Supabase one after another — getUser, then roles, then profile, then
 * terms. Forty-eight serial network calls to answer "who is this" twelve times
 * about the same person, before a single admin query had run. That was the
 * reason the page felt slow, and no amount of front-end work would have touched
 * it.
 *
 * ITS OWN FILE, because it is the security-sensitive half and it must be
 * testable. session.ts constructs a Supabase client at import time, so a test
 * of that module needs credentials and a network; this has no dependencies at
 * all and the rules below are asserted directly.
 *
 * WHAT IS BEING TRADED. A cached authorisation is a stale authorisation, and
 * this one carries venue access, owner status and terms acceptance. Three
 * things keep that honest:
 *
 *   1. THIRTY SECONDS. Short enough that a revoked role cannot be used
 *      meaningfully, long enough to cover a page load and the clicking after
 *      it.
 *   2. THE WINDOW IS ZERO FOR ANYTHING THE APP ITSELF DOES. Every path that
 *      grants or revokes a role, deletes a user, or records a terms acceptance
 *      runs in this process and calls `forget()`. The only way to see a stale
 *      answer is to change the data directly in the Supabase dashboard, and
 *      then it lasts half a minute.
 *   3. IT CACHES AN ANSWER, NEVER A REFUSAL. A token that failed validation is
 *      evicted rather than remembered, so nothing here can turn a transient
 *      Supabase error into a locked-out user.
 *
 * TWO LIMITS WORTH KNOWING. The cache is per process, so a second Railway
 * instance keeps its own and an invalidation does not cross between them —
 * fine at one instance, and it needs revisiting before scaling out. And the
 * entry is keyed on the access token, so it lives at most as long as that token
 * would have anyway.
 */

/** Anything with a user id. Kept generic so this file imports nothing. */
export interface CacheableSession {
  id: string;
}

export const SESSION_TTL_MS = 30_000;

/**
 * A fixed ceiling, so a long-running process cannot grow this without bound.
 *
 * Every refreshed access token is a new key, so the entries for one person
 * accumulate across a day even though only the newest is ever read. Small here
 * — a handful of users — and not necessarily small at the fiftieth customer,
 * which is the same argument the account map makes about paging.
 */
export const MAX_ENTRIES = 500;

export class SessionCache<T extends CacheableSession> {
  private entries = new Map<string, { user: T; at: number }>();

  constructor(
    private ttlMs: number = SESSION_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  /** The cached session for this token, or null if absent or expired. */
  get(token: string): T | null {
    const hit = this.entries.get(token);
    if (!hit) return null;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(token);
      return null;
    }
    return hit.user;
  }

  set(token: string, user: T): void {
    /**
     * Evict the oldest INSERTION when full. A Map iterates in insertion order,
     * so the first key is the oldest entry — and since every entry expires on
     * the same TTL, oldest-inserted is also nearest to expiry. Good enough, and
     * it avoids keeping a second structure in step with this one.
     */
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(token)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(token, { user, at: this.now() });
  }

  /** Remove one token's entry. Used when a token fails to validate. */
  drop(token: string): void {
    this.entries.delete(token);
  }

  /**
   * Forget cached sessions so the next request re-reads from the database.
   *
   * With a user id, forget that person's. With nothing, forget everybody's —
   * which is the right answer whenever the caller cannot tell whose access
   * changed. Clearing costs one re-validation per active user; holding a
   * revoked role for half a minute is not a trade worth making to save that.
   */
  forget(userId?: string): void {
    if (!userId) {
      this.entries.clear();
      return;
    }
    for (const [token, entry] of this.entries) {
      if (entry.user.id === userId) this.entries.delete(token);
    }
  }

  /** For tests and for a diagnostic line; never for a decision. */
  get size(): number {
    return this.entries.size;
  }
}
