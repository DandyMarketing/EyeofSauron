import { supabase } from '../lib/supabase.js';

/**
 * The knowledge layer — accumulated operator judgment, retrieved into context.
 *
 * This is what makes Sauron improve as the business teaches it, and it is a
 * different kind of thing from everything else the system handles. A figure
 * comes from the warehouse and is a fact. A note comes from a person: it has
 * an author, a date, and it can be wrong. Both belong in an answer; they must
 * never be indistinguishable inside one.
 *
 * That distinction is also what makes an answer teach. A junior does not learn
 * from a confident sentence — they learn from seeing the number, then the
 * reasoning, then whose reasoning it is and when they last confirmed it.
 */

/** Notes are read into every prompt, so the read is bounded. */
const NOTE_FETCH_LIMIT = 500;

/** Ceiling on the characters of note text injected into one system prompt. */
const NOTE_CHAR_BUDGET = 6000;

export interface KnowledgeNote {
  note: string;
  category: string;
  confidence: 'rule' | 'observed' | 'hypothesis';
  /** Slug of the venue this applies to, or null when it applies to every venue. */
  venue_slug: string | null;
  venue_name: string | null;
  author_name: string | null;
  created_at: string;
  /** Date the note should be re-confirmed, or null if it does not expire. */
  review_by: string | null;
}

/**
 * Clamp notes to the venues the caller may see.
 *
 * The reason this exists: notes were previously selected unfiltered and
 * appended to every system prompt, immediately after the line telling the user
 * which venues they are limited to. A venue manager was handed every other
 * venue's operational notes — free text written by owners, so the contents
 * could be anything. That is BUILD_LOG 4.1 in a second location: the control
 * was applied at the tool layer and not to this path.
 *
 * `allowed === null` means an owner, who may see everything. An empty array
 * means a caller who holds no venues, and must resolve to group-wide notes
 * only — never to everything.
 */
export function scopeNotes(notes: KnowledgeNote[], allowed: string[] | null): KnowledgeNote[] {
  if (allowed === null) return notes;
  // A null venue_slug is a group-wide note and carries no venue's specifics,
  // so it stays regardless of scope.
  return notes.filter(n => n.venue_slug === null || allowed.includes(n.venue_slug));
}

/**
 * May this user propose a note against this venue?
 *
 * Proposing is open to everyone, but not against a venue they cannot see: a
 * note names a venue in its provenance, so an unchecked venue_id would let
 * someone write into another venue's knowledge base. A null venue is
 * group-wide and carries no venue's specifics, so it is always allowed.
 */
export function noteVenueAllowed(
  user: { isOwner: boolean; venues: Array<{ venue_id: string }> },
  venueId: string | null,
): boolean {
  if (venueId === null) return true;
  if (user.isOwner) return true;
  return user.venues.some(v => v.venue_id === venueId);
}

/**
 * Venue-specific notes first, then group-wide; most recent first within each.
 *
 * A note about the venue the person is asking about is more actionable than a
 * general one, and only the tail is dropped when the budget runs out.
 */
export function orderNotes(notes: KnowledgeNote[]): KnowledgeNote[] {
  return [...notes].sort((a, b) => {
    const aSpecific = a.venue_slug !== null ? 0 : 1;
    const bSpecific = b.venue_slug !== null ? 0 : 1;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
    return b.created_at.localeCompare(a.created_at);
  });
}

/** Has this note passed the date it was meant to be re-confirmed? */
export function isStale(note: KnowledgeNote, today: string): boolean {
  return note.review_by !== null && note.review_by < today;
}

function provenance(note: KnowledgeNote, today: string): string {
  const parts = [
    note.venue_name ?? 'All venues',
    note.category,
    note.confidence,
  ];
  if (note.author_name) parts.push(note.author_name);
  parts.push(note.created_at.slice(0, 10));
  // A stale note is not removed. Dropping it silently would lose a fact that
  // is probably still true; showing it as stale lets the model and the reader
  // weigh it, and it appears in the admin review queue either way.
  if (isStale(note, today)) parts.push('NEEDS REVIEW');
  return parts.join(' · ');
}

/**
 * Render notes for the system prompt, each carrying its own provenance.
 *
 * Truncation is reported rather than silent: an answer built on a knowledge
 * base that quietly dropped half its notes looks identical to one built on all
 * of them.
 */
export function formatNotes(notes: KnowledgeNote[], today: string): string {
  if (notes.length === 0) return '';

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const note of orderNotes(notes)) {
    const line = `- [${provenance(note, today)}] ${note.note}`;
    if (used + line.length > NOTE_CHAR_BUDGET) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length;
  }

  if (dropped > 0) {
    lines.push(`- (${dropped} further note${dropped === 1 ? '' : 's'} not shown — knowledge base exceeds the context budget)`);
  }

  return lines.join('\n');
}

/**
 * The framing that keeps judgment from inheriting the authority of data.
 *
 * Without this the model reads the notes as facts of the same standing as a
 * queried figure, which is the single most damaging thing this feature could
 * do: it would make a stale opinion indistinguishable from a reconciled
 * number, at scale, to exactly the junior staff who cannot yet tell them
 * apart.
 */
export const KNOWLEDGE_FRAMING = `
Team knowledge — judgment recorded by the operators of this business. Each entry carries [venue · category · how firmly held · who recorded it · when].

How to use it:
- This is human judgment, NOT queried data. Never present a note as a figure, and never let a note substitute for a query.
- When a note shapes your answer, say so and attribute it — e.g. "spend per cover is $63 (from the data); Khai's note from March is that anything under $70 at dinner here means the upsell script has slipped." Someone learning the business should be able to see which half is the number and which half is the reasoning, and whose reasoning it is.
- If a note contradicts what you just queried, the DATA WINS. Say plainly that the note appears out of date and name it, so it can be corrected.
- A note marked NEEDS REVIEW is past its re-confirmation date. Use it, but flag that it is unconfirmed.
- A note marked "hypothesis" is someone's working theory, not an established rule. Treat it as a lead to test against the data, never as a finding.`;

/**
 * Fetch approved notes visible to this caller.
 *
 * `allowedVenueSlugs === null` means an owner. Scoping is applied in code
 * rather than trusted to the query, for the same reason enforceVenueScope()
 * exists: the service-role key bypasses RLS, so this function is the boundary.
 */
export async function fetchNotes(allowedVenueSlugs: string[] | null): Promise<KnowledgeNote[]> {
  // Fetch one past the limit so hitting the ceiling is detectable rather than
  // a silent truncation (BUILD_LOG section 1).
  const { data, error } = await supabase
    .from('venue_notes')
    .select('note, category, confidence, created_at, review_by, author_id, venues(slug, name)')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(NOTE_FETCH_LIMIT + 1);

  if (error || !data) return [];

  if (data.length > NOTE_FETCH_LIMIT) {
    console.warn(
      `[knowledge] more than ${NOTE_FETCH_LIMIT} approved notes; the oldest are not being read. ` +
      `Retire stale notes or add paging here.`,
    );
  }

  const rows = data.slice(0, NOTE_FETCH_LIMIT) as any[];

  // Author names in one lookup. Resolved separately because author_id
  // references auth.users while the display name lives on profiles, so there
  // is no single foreign key for PostgREST to follow.
  const authorIds = [...new Set(rows.map(r => r.author_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', authorIds);
    for (const p of profiles ?? []) {
      if (p.full_name) names.set(p.id, p.full_name);
    }
  }

  const notes: KnowledgeNote[] = rows.map(r => ({
    note: r.note,
    category: r.category,
    confidence: r.confidence,
    venue_slug: r.venues?.slug ?? null,
    venue_name: r.venues?.name ?? null,
    author_name: r.author_id ? names.get(r.author_id) ?? null : null,
    created_at: r.created_at,
    review_by: r.review_by,
  }));

  return scopeNotes(notes, allowedVenueSlugs);
}
