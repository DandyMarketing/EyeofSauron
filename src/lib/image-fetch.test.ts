import { test } from 'node:test';
import assert from 'node:assert';
import { imageMediaType, fetchImageAsBase64, MAX_IMAGE_BYTES } from './image-fetch.js';

/**
 * The classifier's first working run failed on all fifty posts with "This URL
 * is disallowed by the website's robots.txt file" — Anthropic's image fetcher
 * obeys robots.txt and Instagram's CDN disallows crawlers. No Instagram media
 * can reach the API by link, so the bytes are fetched here instead.
 */

const response = (over: Partial<{ status: number; type: string; body: Buffer }> = {}) => ({
  ok: (over.status ?? 200) < 400,
  status: over.status ?? 200,
  headers: { get: (_: string) => over.type ?? 'image/jpeg' },
  // Sliced, because a Node Buffer is a VIEW into a shared pool — `.buffer`
  // alone hands back the whole pool and the test reads someone else's bytes.
  arrayBuffer: async () => {
    const b = over.body ?? Buffer.from('fake-image-bytes');
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
}) as any;

test('a charset parameter does not defeat the type check', () => {
  assert.equal(imageMediaType('image/jpeg; charset=binary'), 'image/jpeg');
});

test('image/jpg is normalised — it is common and not a real type', () => {
  assert.equal(imageMediaType('image/jpg'), 'image/jpeg');
  assert.equal(imageMediaType('IMAGE/JPG'), 'image/jpeg');
});

test('a video is rejected rather than sent as an image', () => {
  // Reels store the video in media_url and the still in thumbnail_url. Picking
  // the wrong one would fail far downstream with a much less obvious error.
  assert.equal(imageMediaType('video/mp4'), null);
  assert.equal(imageMediaType('application/octet-stream'), null);
  assert.equal(imageMediaType(null), null);
});

test('every format the API accepts passes', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
    assert.equal(imageMediaType(type), type);
  }
});

test('a usable image comes back as base64 with its type', async () => {
  const r = await fetchImageAsBase64('https://cdn.example/x.jpg', async () => response());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.image.media_type, 'image/jpeg');
    assert.equal(Buffer.from(r.image.data, 'base64').toString(), 'fake-image-bytes');
  }
});

test('failures return a REASON rather than throwing', async () => {
  // One bad image must degrade one post to caption-only, never end a batch of
  // a thousand.
  const notFound = await fetchImageAsBase64('u', async () => response({ status: 404 }));
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.match(notFound.reason, /404/);

  const thrown = await fetchImageAsBase64('u', async () => { throw new Error('ECONNRESET'); });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.match(thrown.reason, /ECONNRESET/);
});

test('an empty body is rejected', async () => {
  const r = await fetchImageAsBase64('u', async () => response({ body: Buffer.alloc(0) }));
  assert.equal(r.ok, false);
});

test('an oversized image is rejected with its size named', async () => {
  const r = await fetchImageAsBase64('u', async () => response({ body: Buffer.alloc(MAX_IMAGE_BYTES + 1) }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /over the/);
});
