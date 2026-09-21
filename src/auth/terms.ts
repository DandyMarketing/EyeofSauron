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

export interface TermsAcceptance {
  user_id: string;
  terms_version: string;
  accepted_at: string;
}

/**
 * Has this person accepted the text currently in force?
 *
 * Compares the VERSION, not merely the existence of a row. Somebody who
 * accepted an earlier wording has not accepted this one, and treating them as
 * though they had is the whole failure this file's version constant exists to
 * prevent.
 */
export function hasAcceptedCurrentTerms(
  acceptances: Array<{ terms_version: string }> | null | undefined,
): boolean {
  return (acceptances ?? []).some(a => a.terms_version === TERMS_VERSION);
}
