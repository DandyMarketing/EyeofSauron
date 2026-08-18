/**
 * What a post IS, derived from what we already stored.
 *
 * The warehouse can say which post won. It cannot say what KIND of post wins,
 * because nothing describes the post beyond its media type. This is the half of
 * that answer which needs no judgement and no API call: hashtags, mentions, how
 * long the caption is, whether it asks the reader anything.
 *
 * Everything here is a pure function of the caption, so it can be recomputed
 * for every post ever stored without touching Meta. That matters more than it
 * sounds -- derived data that can only be produced at ingest time is derived
 * data you can never change your mind about.
 *
 * What this deliberately does NOT do is say what the post is ABOUT -- a plate
 * of food, the room, a promotion. That needs judgement rather than a regular
 * expression, and a taxonomy invented here would be subtly wrong for three
 * different brands.
 */

export interface PostFeatures {
  hashtags: string[];
  mentions: string[];
  caption_length: number;
  has_question: boolean;
}

/**
 * Hashtags, lower-cased and de-duplicated.
 *
 * Lower-cased because Instagram treats #SundayRoast and #sundayroast as the
 * same tag, and grouping them separately would split one tag's performance in
 * half and make both look weaker than they are.
 *
 * The character class is unicode-aware on purpose. Singapore captions carry
 * Chinese and Japanese tags, and an ASCII-only pattern would silently return
 * an empty list for them -- reading as "this venue does not use hashtags"
 * rather than "the parser could not see them".
 */
export function hashtagsOf(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const found = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return unique(found.map(t => t.slice(1).toLowerCase()));
}

/**
 * @-mentions, lower-cased and de-duplicated.
 *
 * Instagram usernames allow letters, digits, dots and underscores, but a
 * trailing dot is almost always punctuation rather than part of the handle --
 * "thanks @fatprince." is one account, not another one. Trailing dots are
 * trimmed, and an email address is skipped: the @ in one is not a mention, and
 * counting it would credit a collaboration that never happened.
 */
export function mentionsOf(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const out: string[] = [];
  const pattern = /(^|[^\w.@])@([A-Za-z0-9._]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(caption)) !== null) {
    const handle = match[2].replace(/\.+$/, '');
    if (handle) out.push(handle.toLowerCase());
  }
  return unique(out);
}

/**
 * Caption length in characters.
 *
 * Measured on the WHOLE caption including hashtags, because that is what a
 * reader scrolls past. A separate question -- whether a long tail of tags
 * hurts -- is answerable from the hashtag count instead.
 */
export function captionLengthOf(caption: string | null | undefined): number {
  return caption ? caption.length : 0;
}

/**
 * Whether the caption asks the reader something.
 *
 * A question mark is a crude proxy and a deliberate one: it is unambiguous,
 * language-independent, and cannot be wrong in a way that is hard to notice.
 * Full-width "？" counts, because a Chinese or Japanese caption asks a question
 * with that character and missing it would understate exactly the posts most
 * likely to differ.
 */
export function hasQuestion(caption: string | null | undefined): boolean {
  return !!caption && /[?？]/.test(caption);
}

/** Every derived feature of one caption, in the shape the row stores. */
export function featuresOf(caption: string | null | undefined): PostFeatures {
  return {
    hashtags: hashtagsOf(caption),
    mentions: mentionsOf(caption),
    caption_length: captionLengthOf(caption),
    has_question: hasQuestion(caption),
  };
}

/**
 * The Singapore hour a post went out, 0-23.
 *
 * Not the same as the trading day's basis and not meant to be: business_date
 * answers which night a post belongs to, this answers what time of day it was
 * published. A post at 1am Sunday is filed against Saturday's trade AND is
 * genuinely a 1am post -- both are true, and collapsing them would lose the one
 * question worth asking here, which is when to post.
 */
export function postedHourOf(publishedAt: string): number | null {
  const t = new Date(publishedAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + 8 * 3_600_000).getUTCHours();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
