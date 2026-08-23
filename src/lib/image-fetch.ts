/**
 * Fetch an image and hand it over as bytes rather than as a link.
 *
 * WHY NOT JUST SEND THE URL. The classifier's first working run failed on all
 * fifty posts with:
 *
 *   400 invalid_request_error: This URL is disallowed by the website's
 *   robots.txt file.
 *
 * Anthropic's server-side image fetcher obeys robots.txt, and Instagram's CDN
 * disallows crawlers. That is not something a different URL or a retry fixes:
 * no Instagram media can ever be passed to the API by link.
 *
 * Fetching it ourselves is not a workaround around that rule, it is outside it.
 * robots.txt governs automated crawling of a site; this is one owner's own
 * media, fetched once, for a signed URL we were given by Meta's API for that
 * purpose. The bytes then go up as base64 like any uploaded file.
 */

/** What the Messages API accepts. Anything else is not worth sending. */
const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Ceiling per image. The API's limit is around 5MB and an Instagram thumbnail
 * is normally a few hundred KB, so anything near this is a sign we grabbed the
 * wrong thing -- a video, most likely.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Normalise a content-type header into something the API accepts, or null.
 *
 * Pure, because the interesting cases are all header shapes: a charset
 * parameter, a mixed-case type, a CDN returning octet-stream, or a video that
 * would be silently sent as an image and rejected downstream with a far less
 * obvious error.
 */
export function imageMediaType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'image/jpg') return 'image/jpeg';  // common, and not a real type
  return SUPPORTED.includes(type) ? type : null;
}

export interface FetchedImage {
  media_type: string;
  /** base64, ready for an image content block. */
  data: string;
  bytes: number;
}

/**
 * Returns null rather than throwing when the image cannot be used.
 *
 * A post with no usable image is still classifiable from its caption -- less
 * well, and `classified_from` records that -- so one bad image must degrade a
 * single post rather than end a batch of a thousand.
 */
export async function fetchImageAsBase64(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; image: FetchedImage } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e: any) {
    return { ok: false, reason: `fetch failed: ${String(e?.message ?? e).slice(0, 120)}` };
  }

  if (!res.ok) return { ok: false, reason: `image fetch returned ${res.status}` };

  const mediaType = imageMediaType(res.headers.get('content-type'));
  if (!mediaType) {
    return { ok: false, reason: `unsupported content-type "${res.headers.get('content-type') ?? 'none'}"` };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0) return { ok: false, reason: 'image was empty' };
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `image is ${Math.round(buffer.byteLength / 1024)}KB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB ceiling` };
  }

  return {
    ok: true,
    image: { media_type: mediaType, data: buffer.toString('base64'), bytes: buffer.byteLength },
  };
}
