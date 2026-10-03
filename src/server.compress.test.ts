/**
 * Compression must never reach the event stream.
 *
 * /ask/stream exists so a person watching a slow answer sees it working. A gzip
 * stream buffers small writes until it has enough to emit, and a progress frame
 * is about eighty bytes — so compressed, every frame would arrive in one lump
 * at the END, which is the single moment they are worth nothing. There would be
 * no error and nothing in any log: the feature would simply appear not to work.
 *
 * We do not guard against this ourselves. Hono excludes `text/event-stream`
 * from its own compressible set, measured and recorded in src/server.ts, and a
 * path exclusion we wrote was REMOVED once that was confirmed rather than left
 * in place looking load-bearing. That makes this test the only thing standing
 * between a dependency bump — or a `contentTypeFilter` option added for some
 * unrelated reason — and a silently broken feature.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/utils/compress';

test('an event stream is not compressible', () => {
  assert.equal(COMPRESSIBLE_CONTENT_TYPE_REGEX.test('text/event-stream'), false);
  // With the parameters a real response carries, not just the bare type.
  assert.equal(COMPRESSIBLE_CONTENT_TYPE_REGEX.test('text/event-stream; charset=utf-8'), false);
});

test('the pages and API responses still are', () => {
  // The other half of the same fact: if this regex ever stopped matching HTML,
  // compression would quietly stop applying to the thing it was added for —
  // 73% of admin.html — and look exactly as installed as it does today.
  assert.equal(COMPRESSIBLE_CONTENT_TYPE_REGEX.test('text/html; charset=utf-8'), true);
  assert.equal(COMPRESSIBLE_CONTENT_TYPE_REGEX.test('application/json'), true);
  assert.equal(COMPRESSIBLE_CONTENT_TYPE_REGEX.test('text/javascript; charset=utf-8'), true);
});

test('the server does not re-add a path exclusion for the stream', async () => {
  /**
   * If somebody reinstates the exclusion we removed, this fails and points them
   * at the comment explaining why it is unnecessary — otherwise the next reader
   * finds a guard, assumes it is load-bearing, and the real reason the stream
   * works is lost.
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/server.ts', 'utf8');
  assert.ok(
    src.includes("app.use('*', compress());"),
    'compress() should be registered plainly — see the comment above it in src/server.ts',
  );
});
