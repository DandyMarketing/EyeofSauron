/**
 * When somebody was last here, in words.
 *
 * WHY. Khai: "last login details is good for each user to monitor usage."
 * Fifteen accounts with a timestamp each is a column nobody reads; the useful
 * version answers one question at a glance — **is this account being used, and
 * if not, was it ever?**
 *
 * WHAT IT ACTUALLY MEASURES, and the distinction matters before anybody leans
 * on it. This is `last_sign_in_at` from Supabase Auth: the last time somebody
 * AUTHENTICATED, not the last time they used Sauron. A session lasts, so
 * someone who opens the app daily on a phone that stays signed in can show a
 * sign-in from weeks ago. It is a reliable floor — nobody has used it MORE
 * recently than they signed in is false, nobody has used it at all without ever
 * signing in is true — so it answers "has this account ever been used" exactly,
 * and "how often" only roughly.
 *
 * NEVER IS NOT A LONG TIME AGO. An invited account that was never opened and an
 * account that has gone quiet need different conversations: one is an
 * onboarding that did not finish, the other is a person who stopped. Collapsing
 * them into "no recent activity" loses the only one you can act on today.
 */

export type LastSeenTone = 'active' | 'quiet' | 'dormant' | 'never';

export interface LastSeen {
  /** What to show. */
  text: string;
  /** How to colour it. */
  tone: LastSeenTone;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function describeLastSeen(iso: string | null | undefined, now: number = Date.now()): LastSeen {
  if (!iso) return { text: 'Never signed in', tone: 'never' };

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return { text: 'Never signed in', tone: 'never' };

  /**
   * A future timestamp is clock skew, not a visit that has not happened yet.
   * Reported as today rather than as "in 3 days", which would read as a bug and
   * send somebody looking for one.
   */
  const days = Math.floor(Math.max(0, now - then) / DAY_MS);

  if (days === 0) return { text: 'Today', tone: 'active' };
  if (days === 1) return { text: 'Yesterday', tone: 'active' };
  if (days < 14) return { text: `${days} days ago`, tone: 'active' };
  if (days < 31) return { text: `${days} days ago`, tone: 'quiet' };

  const months = Math.floor(days / 30);
  if (months < 12) return { text: `${months} month${months === 1 ? '' : 's'} ago`, tone: 'dormant' };

  const years = Math.floor(days / 365);
  return { text: `${years} year${years === 1 ? '' : 's'} ago`, tone: 'dormant' };
}
