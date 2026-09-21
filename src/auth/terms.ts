/**
 * The terms a person accepts before Sauron will answer them.
 *
 * IN CODE, AND VERSIONED, for the reason every mapping in this project is: the
 * alternative is a paragraph in a Supabase email template and a second copy in
 * an HTML file, drifting apart with nobody able to say which one somebody
 * actually agreed to. Here the text, the version and the record of acceptance
 * all move together, and git says when each word changed.
 *
 * THE VERSION IS THE POINT. When this text changes, TERMS_VERSION must change
 * with it, and everyone is asked again. Without that you hold a record of
 * people accepting something you no longer show, which is worse than holding no
 * record at all -- it looks like evidence and is not.
 *
 * NOT LEGAL ADVICE. This was drafted by an engineer to be reviewed by somebody
 * who does this for a living, particularly against Singapore's PDPA: the system
 * holds guest records and trading data, and these terms are what staff are
 * agreeing to about handling them. It reads sensibly and it has not been
 * checked.
 */

/**
 * Bump on ANY change to the text below, however small.
 *
 * Date-based rather than a counter, so a reader can tell at a glance whether a
 * recorded acceptance is recent without opening the history.
 */
export const TERMS_VERSION = '2026-09-22';

export const TERMS_TITLE = 'Confidentiality and acceptable use';

/**
 * Written to be read once, on a phone, by somebody who wants to get to the
 * numbers. Short sentences, no defined terms, and the consequence stated rather
 * than implied -- a wall of clauses is skimmed and then nobody can honestly say
 * it was read.
 */
export const TERMS_BODY = `
Sauron holds the commercial and operational records of The Dandy Collection and
its venues: sales, costs, profit and loss, supplier invoices, guest records and
staffing. All of it is private and confidential.

**Your account is yours alone.**
Do not share your password. Do not let anyone else use your login, including
colleagues, contractors, suppliers or family. Anything done through your account
is treated as done by you. If you think somebody else has used it, say so
immediately — nobody is in trouble for reporting it, and the damage of staying
quiet is much larger.

**What you see here stays here.**
Do not forward, copy, screenshot, export or repeat this information to anyone
outside the company, and inside the company only to people who are entitled to
it. That includes figures quoted in conversation. If you are unsure whether
somebody is entitled to something, ask before sending it, not after.

**Guest data is personal data.**
Reservation records contain real people's names and contact details. Use them to
do your job and for nothing else. Never extract, copy or pass on a guest list.

**The consequences are real.**
Unauthorised disclosure of this information breaches your obligations to the
company and may breach Singapore's Personal Data Protection Act. It can lead to
disciplinary action up to dismissal, and to civil or criminal liability. The
company will pursue it.

**Your access is scoped, and that is deliberate.**
You can see the venues and the kinds of data your role allows. Do not attempt to
reach anything else, and do not ask a colleague to look something up that you
cannot see yourself.

**These figures are a tool, not a decision.**
Sauron answers from recorded data and can be wrong, out of date, or
misunderstood. Check anything that matters before acting on it.

By continuing you confirm you have read this, you agree to it, and you
understand that your use of Sauron is recorded.
`.trim();

/**
 * How long an acceptance stands before it is asked for again.
 *
 * A year, which is ordinary practice for a confidentiality undertaking and is
 * here for two reasons rather than form. A three-month-old acceptance is much
 * stronger evidence than a three-year-old one on the day you need to rely on
 * it. And people genuinely forget what they agreed to -- somebody who signed in
 * September 2026 and is asked in 2029 whether they knew they could not forward
 * a P&L will answer honestly that they do not remember, and they will be right.
 *
 * The cost is one interruption a year per person, which is the cheapest thing
 * in this file.
 */
export const TERMS_VALIDITY_DAYS = 365;

export interface TermsAcceptance {
  user_id: string;
  terms_version: string;
  accepted_at: string;
}

/**
 * Has this person accepted the text currently in force, recently enough?
 *
 * TWO CONDITIONS, AND BOTH MATTER FOR DIFFERENT REASONS. The VERSION catches a
 * rewrite: somebody who accepted an earlier wording has not accepted this one,
 * and treating them as though they had is the failure the version constant
 * exists to prevent. The AGE catches the passage of time, which no rewrite
 * would ever surface on its own.
 *
 * The most recent matching row wins. Re-acceptance writes a new row rather than
 * overwriting, so the history of who agreed to what and when survives -- which
 * is the entire point of keeping a record instead of a flag.
 */
export function hasAcceptedCurrentTerms(
  acceptances: Array<{ terms_version: string; accepted_at?: string | null }> | null | undefined,
  now: Date = new Date(),
): boolean {
  return latestAcceptance(acceptances) !== null && !isExpired(acceptances, now);
}

/** The most recent acceptance of the CURRENT wording, or null. */
export function latestAcceptance(
  acceptances: Array<{ terms_version: string; accepted_at?: string | null }> | null | undefined,
): { terms_version: string; accepted_at?: string | null } | null {
  const current = (acceptances ?? []).filter(a => a.terms_version === TERMS_VERSION);
  if (current.length === 0) return null;

  return current.reduce((newest, a) => {
    const at = Date.parse(a.accepted_at ?? '');
    const best = Date.parse(newest.accepted_at ?? '');
    // A row with no timestamp is treated as the OLDEST rather than the newest,
    // so a missing value can never make a stale acceptance look fresh.
    if (!Number.isFinite(at)) return newest;
    if (!Number.isFinite(best)) return a;
    return at > best ? a : newest;
  });
}

function isExpired(
  acceptances: Array<{ terms_version: string; accepted_at?: string | null }> | null | undefined,
  now: Date,
): boolean {
  const latest = latestAcceptance(acceptances);
  if (!latest) return true;

  const at = Date.parse(latest.accepted_at ?? '');
  /**
   * An unparseable timestamp counts as EXPIRED, not as valid.
   *
   * The choice only matters in a corrupt-data case, and the two ways of being
   * wrong are not symmetrical: asking somebody to accept again costs a click,
   * while treating an unreadable record as a live agreement is the one claim
   * this table exists to be able to make and the one it could not support.
   */
  if (!Number.isFinite(at)) return true;

  return now.getTime() - at > TERMS_VALIDITY_DAYS * 86_400_000;
}

/**
 * One person's standing, for the admin console.
 *
 * `unknown` is a third state and not a dressed-up "no". Before migration 042 is
 * run the table does not exist, and showing a hundred people as "never
 * accepted" when nobody has been ASKED yet would send somebody chasing them.
 */
export interface AcceptanceSummary {
  status: 'accepted' | 'expired' | 'never' | 'unknown';
  accepted_at: string | null;
  expires_at: string | null;
}

export function termsAcceptanceSummary(
  acceptances: Array<{ terms_version: string; accepted_at?: string | null }> | null | undefined,
  unavailable = false,
  now: Date = new Date(),
): AcceptanceSummary {
  if (unavailable) return { status: 'unknown', accepted_at: null, expires_at: null };

  const latest = latestAcceptance(acceptances);
  if (!latest) {
    /**
     * Never accepted the CURRENT wording. Somebody who agreed to an older one
     * is reported the same way, deliberately: for the purpose of the question
     * the console is answering -- may this person use Sauron -- the two are the
     * same, and inventing a fourth state for it would be detail nobody acts on.
     */
    return { status: 'never', accepted_at: null, expires_at: null };
  }

  const accepted_at = latest.accepted_at ?? null;
  const expires_at = acceptanceExpiresAt(acceptances);

  return {
    status: hasAcceptedCurrentTerms(acceptances, now) ? 'accepted' : 'expired',
    accepted_at,
    expires_at,
  };
}

/** When the current acceptance runs out, or null if there is not one. */
export function acceptanceExpiresAt(
  acceptances: Array<{ terms_version: string; accepted_at?: string | null }> | null | undefined,
): string | null {
  const latest = latestAcceptance(acceptances);
  const at = Date.parse(latest?.accepted_at ?? '');
  if (!Number.isFinite(at)) return null;
  return new Date(at + TERMS_VALIDITY_DAYS * 86_400_000).toISOString();
}
