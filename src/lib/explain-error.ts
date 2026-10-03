/**
 * What an ingestion error MEANS, in words anybody can act on.
 *
 * WHY THIS EXISTS. The admin console's Recent Errors panel showed the raw
 * message and nothing else:
 *
 *     ingestion_error   sevenrooms:auth-error   SevenRooms auth failed: HTTP 503
 *     parse_error       Operations_Report_…csv  Quote Not Closed: the parsing is
 *                                               finished with an opening quote at line 4
 *
 * Both are precise and both are useless to the person most likely to be looking
 * at them. "HTTP 503" does not say whether our password is wrong or their
 * server is down, and those need completely different responses — one is a
 * thing to fix, the other is a thing to wait out. Somebody who cannot tell them
 * apart either escalates every blip or ignores a real outage.
 *
 * BOTH ARE SHOWN, never one instead of the other. The plain sentence is for
 * deciding what to do; the raw message is what you quote to a vendor's support
 * desk or search for. Replacing the technical text would move the problem
 * rather than solve it.
 *
 * AN UNRECOGNISED ERROR RETURNS NULL and the panel shows the raw message alone,
 * exactly as before. A wrong explanation is worse than none — it would send
 * somebody to check credentials that are fine — so this only speaks when it is
 * sure, and the list grows as real errors turn up rather than by anticipating
 * them.
 */

export interface ErrorExplanation {
  /** One or two sentences, in plain language. */
  plain: string;
  /** Whether anybody needs to do anything. */
  action: 'wait' | 'fix' | 'watch';
}

/** Does this message carry an HTTP status, and which? */
function httpStatus(message: string): number | null {
  const m = message.match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/** The vendor a message is about, where it names one. */
function vendor(message: string): string | null {
  for (const [needle, name] of [
    ['sevenrooms', 'SevenRooms'],
    ['staffany', 'StaffAny'],
    ['xero', 'Xero'],
    ['zeemart', 'Zeemart'],
    ['metricool', 'Metricool'],
    ['monday', 'Monday'],
  ] as const) {
    if (message.toLowerCase().includes(needle)) return name;
  }
  return null;
}

export function explainIngestError(message: string): ErrorExplanation | null {
  if (!message) return null;
  const who = vendor(message) ?? 'The source system';
  const status = httpStatus(message);

  /**
   * 5xx and 429 are THEIR problem, not ours, and that distinction is the single
   * most useful thing this function says. A 503 at 17:04 on a Tuesday is a
   * maintenance window; it needs nobody to do anything except confirm the next
   * run succeeded.
   */
  if (status !== null && (status === 429 || status >= 500)) {
    const why = status === 429
      ? `${who} asked us to slow down`
      : `${who} was unavailable at their end`;
    return {
      plain:
        `${why} — this is their server, not our login or our data. ` +
        `The run stopped and will pick the missed days back up on its next pass, ` +
        `because each run re-reads a window rather than only the newest day. ` +
        `Nothing to do unless it keeps happening.`,
      action: 'wait',
    };
  }

  /**
   * 401/403 is the opposite case and must never be confused with the above: a
   * credential has been rejected, and no amount of waiting fixes it.
   */
  if (status === 401 || status === 403) {
    return {
      plain:
        `${who} rejected our credentials. This does not fix itself — the key or ` +
        `password needs checking, and the usual cause is one that was pasted ` +
        `with a line break in the middle of it, so it is the right length to ` +
        `look correct and one character too long to work.`,
      action: 'fix',
    };
  }

  if (status === 404) {
    return {
      plain:
        `${who} says the thing we asked for does not exist. Usually an id that ` +
        `has been renamed or removed on their side, so the mapping in this ` +
        `console needs a look.`,
      action: 'fix',
    };
  }

  // --- file problems, which are about what arrived rather than who sent it ---

  if (/quote not closed/i.test(message)) {
    const line = message.match(/line (\d+)/i)?.[1];
    return {
      plain:
        `The report file is damaged: a quotation mark was opened${line ? ` around line ${line}` : ''} ` +
        `and never closed, so everything after it reads as one run-on value. ` +
        `Nothing in it could be trusted, so none of it was loaded. The file ` +
        `needs sending again from the source system.`,
      action: 'fix',
    };
  }

  if (/no .*(venue|report).*(key|match)|unknown venue key/i.test(message)) {
    return {
      plain:
        `The file arrived but we do not know which venue it belongs to. The ` +
        `code in its filename is not in the lookup table, so it was flagged ` +
        `rather than guessed at. Add the mapping and it can be re-loaded.`,
      action: 'fix',
    };
  }

  if (/empty|no rows|0 rows/i.test(message)) {
    return {
      plain:
        `The file arrived with nothing in it. For a day the venue was closed ` +
        `that is normal; on a trading day it means the report was generated ` +
        `before service was keyed in.`,
      action: 'watch',
    };
  }

  // --- the network, as opposed to an answer from the other end ---

  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i.test(message)) {
    return {
      plain:
        `We could not reach ${who === 'The source system' ? 'the source system' : who} at all — ` +
        `the connection failed rather than being refused. Almost always ` +
        `temporary, and the next run will cover the gap.`,
      action: 'wait',
    };
  }

  if (/timeout|timed out/i.test(message)) {
    return {
      plain:
        `${who} accepted the request and then took too long to answer. Usually ` +
        `a sign they are busy; the next run re-reads the same window.`,
      action: 'wait',
    };
  }

  /**
   * Nothing recognised. The panel shows the raw message on its own, which is
   * exactly what it did before this existed — no worse, and never misleading.
   */
  return null;
}

/**
 * The `status` column, as something a person would say.
 *
 * `ingestion_error` and `parse_error` are our own vocabulary, printed at the
 * front of every row in the admin console where they are the first thing read.
 * They describe WHERE the failure happened, which is genuinely useful — a file
 * we could not read is a different problem from a system we could not reach —
 * but only to somebody who already knows the pipeline.
 *
 * The raw value is kept, in the technical line underneath, so nothing is lost
 * for searching or for quoting. An unknown status is returned unchanged rather
 * than guessed at.
 */
const STATUS_WORDS: Record<string, string> = {
  ingestion_error: 'Could not fetch',
  parse_error: 'Could not read the file',
  validation_error: 'Figures did not add up',
  error: 'Failed',
  partial: 'Loaded only part of it',
  skipped: 'Skipped',
};

export function describeStatus(status: string): string {
  return STATUS_WORDS[status] ?? status;
}
