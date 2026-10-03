/**
 * Turning a byte stream into progress events.
 *
 * WHY THIS IS ITS OWN FILE. It is ten lines of logic with one classic bug in
 * it, and inside index.html nothing could test it: `tsc` does not read an HTML
 * file and the page test only proves the script parses. The bug is that a read
 * from the network boundary splits WHEREVER THE PACKET ENDED — mid-JSON,
 * between the two newlines of a frame separator, anywhere — so code that
 * assumes each read is a whole frame works perfectly on a fast local connection
 * and drops events on a phone. That is the shape of defect this codebase keeps
 * finding, and it is the reason this is a module with tests beside it.
 *
 * It is deliberately NOT an EventSource. EventSource cannot issue a POST and
 * cannot set an Authorization header, so the question and the bearer token
 * would both have to go in the URL — a venue's question in a query string, in
 * every access log between here and Railway.
 */

/**
 * Feed bytes in, get complete events out.
 *
 * Returns a reader object with one method: `push(text)` returns the array of
 * events that are now complete. Anything incomplete is retained until the rest
 * of it arrives.
 */
export function createEventParser() {
  let buffer = '';

  return {
    push(text) {
      buffer += text;

      /**
       * Split on the blank line that ends a frame, and KEEP THE LAST PIECE.
       *
       * Whatever follows the final separator has not been terminated yet, so it
       * is a partial frame and goes back into the buffer. Parsing it would
       * throw on a perfectly healthy stream — and a stream with no separator at
       * all yet yields a single piece, which is correctly retained in full.
       */
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      const events = [];
      for (const part of parts) {
        // ": ping" keep-alive comments have no data line and are skipped. They
        // exist so an idle minute does not look to a proxy like a dead socket.
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;

        try {
          events.push(JSON.parse(line.slice(5).trim()));
        } catch (e) {
          /**
           * One unreadable frame must never cost the answer.
           *
           * The `done` event carrying the reply may be the very next one, and
           * throwing here would take down a question that had already been paid
           * for and answered.
           */
          console.warn('[sse] skipped an unreadable frame');
        }
      }
      return events;
    },
  };
}

/**
 * One progress event, as a line a person would recognise.
 *
 * Presentation lives on this side on purpose: the server says what happened,
 * this decides how it reads. An UNKNOWN KIND RETURNS NOTHING rather than its
 * raw contents — a future server event must never put a JSON blob on a venue
 * manager's screen.
 */
export function progressLines(event) {
  if (!event || typeof event !== 'object') return [];
  if (event.kind === 'thinking') return ['Thinking'];
  if (event.kind === 'writing') return ['Writing the answer'];
  if (event.kind === 'note') return event.text ? [String(event.text)] : [];
  if (event.kind === 'working') {
    return Array.isArray(event.labels) ? event.labels.filter((l) => typeof l === 'string' && l) : [];
  }
  return [];
}
