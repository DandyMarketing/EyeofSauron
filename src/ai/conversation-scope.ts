/**
 * What a saved answer READ, and whether you may still see it.
 *
 * WHY THIS EXISTS. Storing conversations freezes a moment when somebody had a
 * particular access, and access changes. A finance user asks about labour cost;
 * the chat is saved; their role becomes manager. Without this, that stored chat
 * goes on serving payroll figures that `enforceDomainScope()` would refuse if
 * they asked the same question today. Same for venues: a manager who moves from
 * Fat Prince to Neon Pigeon would keep a readable chat full of Fat Prince's
 * P&L.
 *
 * RE-CHECK ON READ, which was Khai's decision on 3 Oct 2026 and is the only one
 * consistent with the rest of this codebase: the server decides at the moment of
 * access, never the client, never at write time. The alternatives were to
 * freeze what you could see when you asked — which means access can never truly
 * be revoked — or to purge history on a role change, which destroys work.
 *
 * THE CHECK IS COARSE ON PURPOSE. A message that touched anything out of scope
 * is withheld WHOLE, not redacted. `mentionsPayrollAmounts()` one file over
 * shows how hard it is to reliably strip a figure out of prose, and a redaction
 * that half works is worse than a message that is plainly missing. Withholding
 * is certain; redacting is a guess.
 *
 * IT COSTS NOTHING TO RECORD. The engine already collects every tool call and
 * its inputs, so which venues and which data domains a turn read is derived
 * rather than tracked.
 */

import { domainOf, mayRead } from './data-domains.js';
import type { Domain, Role } from './data-domains.js';

export interface ToolCallRecord {
  name: string;
  input?: Record<string, any> | null;
}

/** What one assistant turn read, stored beside it. */
export interface TurnScope {
  venue_slugs: string[];
  domains: Domain[];
}

/**
 * Pull the venue slugs out of a tool call's arguments.
 *
 * The field names are the ones the tools actually accept — `venue_slug` and
 * `venue_slugs` are what enforceVenueScope() reads, and `venue` appears in a
 * few older shapes. Anything unrecognised contributes nothing, which is the
 * safe direction: an unrecorded venue cannot cause a message to be withheld,
 * and the DOMAIN check still applies.
 */
function venuesIn(input: Record<string, any> | null | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const key of ['venue', 'venue_slug', 'venue_name']) {
    if (typeof input[key] === 'string' && input[key]) out.push(input[key]);
  }
  for (const key of ['venue_slugs', 'venues']) {
    if (Array.isArray(input[key])) {
      for (const v of input[key]) if (typeof v === 'string' && v) out.push(v);
    }
  }
  return out;
}

/** Everything one turn touched, de-duplicated and stable for storage. */
export function scopeOfTurn(calls: ToolCallRecord[]): TurnScope {
  const venues = new Set<string>();
  const domains = new Set<Domain>();

  for (const call of calls ?? []) {
    if (!call?.name) continue;
    domains.add(domainOf(call.name));
    for (const v of venuesIn(call.input)) venues.add(v);
  }

  return {
    venue_slugs: [...venues].sort(),
    domains: [...domains].sort(),
  };
}

export interface ReaderScope {
  role: Role;
  /** The venue slugs this reader may see, or null for an owner (all venues). */
  venues: string[] | null;
}

export interface ScopeVerdict {
  visible: boolean;
  /** Shown in place of the message. Null when it is visible. */
  reason: string | null;
}

/**
 * May this reader still see a stored turn?
 *
 * Returns the REASON as well, because a gap in an old conversation with no
 * explanation reads as data loss. "Hidden — this answer used Fat Prince data,
 * which you no longer have access to" is a different message from a message
 * that simply is not there.
 */
export function mayStillRead(turn: TurnScope, reader: ReaderScope): ScopeVerdict {
  const lostDomains = (turn.domains ?? []).filter(d => !mayRead(reader.role, d));
  if (lostDomains.length > 0) {
    return {
      visible: false,
      reason:
        `Hidden — this answer used ${lostDomains.join(' and ')} data, which your ` +
        `current role does not have access to.`,
    };
  }

  // null means unrestricted: an owner, or a turn recorded before scopes existed.
  if (reader.venues === null) return { visible: true, reason: null };

  const allowed = new Set(reader.venues);
  const lostVenues = (turn.venue_slugs ?? []).filter(v => !allowed.has(v));
  if (lostVenues.length > 0) {
    /**
     * The venue is NAMED here, unlike in the progress labels, and the reason is
     * that the situation is the opposite one. A progress label would announce a
     * venue before the tool layer refused it — telling somebody about a venue
     * they have no business knowing we hold. Here the person demonstrably had
     * access when they asked: the venue is in their own conversation, in their
     * own words, further up the page. Naming it explains the gap; hiding it
     * makes their own history mysterious.
     */
    return {
      visible: false,
      reason:
        `Hidden — this answer used data for ${lostVenues.join(', ')}, which you ` +
        `no longer have access to.`,
    };
  }

  return { visible: true, reason: null };
}

/**
 * Apply the check to a whole conversation.
 *
 * Returns the messages with withheld ones replaced, and a COUNT. A filter whose
 * effect nobody can see is indistinguishable from one that stopped working, so
 * the count travels with the response and the UI can say "2 messages hidden".
 */
export interface StoredMessage {
  role: string;
  content: string;
  charts?: unknown;
  venue_slugs?: string[] | null;
  domains?: string[] | null;
  [k: string]: unknown;
}

export function filterConversation(
  messages: StoredMessage[],
  reader: ReaderScope,
): { messages: StoredMessage[]; withheld: number } {
  let withheld = 0;

  const out = (messages ?? []).map((m) => {
    /**
     * A user's OWN question is never withheld. They wrote it, they have read it
     * before, and it holds no figures — the answer is where the data is. Hiding
     * somebody's own words would make the conversation unreadable without
     * protecting anything.
     */
    if (m.role !== 'assistant') return m;

    const verdict = mayStillRead(
      { venue_slugs: m.venue_slugs ?? [], domains: (m.domains ?? []) as Domain[] },
      reader,
    );
    if (verdict.visible) return m;

    withheld++;
    return { ...m, content: verdict.reason!, charts: null, withheld: true };
  });

  return { messages: out, withheld };
}
