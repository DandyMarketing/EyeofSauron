/**
 * Telling an ACCOUNT problem apart from a POST problem.
 *
 * The 1,000-post classification run stopped classifying at post 711 because the
 * Anthropic account ran out of credit. The script did not notice. It treated
 * every one of the remaining 289 posts as an individual failure, called the API
 * 289 more times, and printed 289 identical lines:
 *
 *   400 invalid_request_error: Your credit balance is too low to access the
 *   Anthropic API. Please go to Plans & Billing
 *
 * That is the same shape as the missing-ANTHROPIC_API_KEY run before it: one
 * cause, hundreds of identical errors, and you have to read to the bottom of
 * the log to see that it was ever only one thing. The API-key pre-check fixed
 * that for a condition detectable BEFORE the run. This fixes it for the ones
 * that can only appear DURING it.
 *
 * The distinction that matters: a bad image, an unparseable response or a
 * rejected category is about ONE post, and the next post may well be fine. An
 * exhausted balance, a rejected key or a forbidden model is about the ACCOUNT,
 * and no number of further posts will change it. The first is a skip. The
 * second should stop the run and say the work is resumable.
 *
 * DELIBERATELY NOT INCLUDED: 429 rate limits and 529 overloaded. Those really
 * do recover on the next call, and aborting a thousand-post run on one of them
 * would trade a loud failure for a needless one.
 */

/** Account-level failures, matched on the message the API actually returns. */
const FATAL_PATTERNS: Array<{ pattern: RegExp; explain: string }> = [
  {
    pattern: /credit balance is too low/i,
    explain: 'The Anthropic account is out of credit. Top up at Plans & Billing: https://console.anthropic.com/settings/billing',
  },
  {
    pattern: /authentication_error|invalid x-api-key|could not resolve authentication/i,
    explain: 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on this service.',
  },
  {
    pattern: /permission_error|not allowed to (use|access)/i,
    explain: 'The Anthropic API key is not permitted to use this model. Check the key\'s scope, or set SAURON_MODEL_CLASSIFY to a model it can reach.',
  },
];

/** HTTP statuses that are about the caller, never about one request's content. */
const FATAL_STATUSES = new Set([401, 403]);

/**
 * Why this run cannot continue, or null if the failure was about one item.
 *
 * Reads both the status and the message text, because the two sources disagree
 * about which is available: the SDK surfaces `status` on its own error class,
 * while a caught-and-stringified error keeps only the message — which is what
 * the classifier's own logs contained, whole JSON body and all.
 */
export function fatalApiReason(error: unknown): string | null {
  if (!error) return null;

  const err = error as { status?: unknown; message?: unknown };
  const status = typeof err.status === 'number' ? err.status : undefined;
  const message = String(err.message ?? error);

  for (const { pattern, explain } of FATAL_PATTERNS) {
    if (pattern.test(message)) return explain;
  }

  if (status !== undefined && FATAL_STATUSES.has(status)) {
    return `The Anthropic API returned ${status} — an account-level rejection, not a problem with this item.`;
  }

  return null;
}

/**
 * The block printed when a run gives up.
 *
 * Says how much survived and how much is left, because the reflex on seeing a
 * failed job is to wonder whether the completed part has to be redone. Every
 * script using this is resumable, and saying so is the difference between
 * "run it again" and an afternoon of checking.
 */
export function fatalRunSummary(
  reason: string,
  done: number,
  remaining: number,
  resumeCommand: string,
): string {
  return [
    '',
    'STOPPED — this is an account problem, not a problem with the data.',
    `  ${reason}`,
    '',
    `${done} item(s) were completed and written. ${remaining} were not attempted.`,
    'Nothing needs redoing: completed items are skipped on the next run.',
    '',
    `  ${resumeCommand}`,
  ].join('\n');
}
