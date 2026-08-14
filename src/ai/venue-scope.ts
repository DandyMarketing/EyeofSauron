/**
 * Venue scoping — the isolation boundary for every AI tool call.
 *
 * This lives in its own module, with no database import, for two reasons.
 * It is the control that stops one venue reading another's numbers, so it
 * should be obvious where it is; and it must be unit-testable without
 * Supabase credentials, because a boundary that is only asserted in a review
 * is exactly the defect recorded in docs/BUILD_LOG.md section 4.1.
 *
 * The handlers query with the service-role key, which bypasses Row-Level
 * Security entirely. RLS is therefore NOT the boundary here — this is.
 */

/** Key used to carry the caller's allow-list to handlers that read "no venue" as "all venues". */
export const ALLOWED_VENUES = '__allowed_venues';

/**
 * Clamp a tool call to the venues the caller may see.
 *
 * Omitting the venue is the dangerous case: several tools read "no venue" as
 * "all venues", so an unscoped call would return the whole group. A restricted
 * caller therefore has the filter applied rather than left blank.
 *
 * Returns an error string if the call must be refused, otherwise mutates the
 * input to stay in scope and returns null.
 */
export function enforceVenueScope(input: Record<string, any>, allowed: string[]): string | null {
  // Set first, and unconditionally, so a value supplied by the model on the
  // tool input can never survive into the handlers as a scope grant.
  input[ALLOWED_VENUES] = [...allowed];

  if (typeof input.venue_slug === 'string') {
    if (!allowed.includes(input.venue_slug)) {
      return `You do not have access to venue "${input.venue_slug}". You can see: ${allowed.join(', ')}.`;
    }
    return null;
  }

  if (Array.isArray(input.venue_slugs)) {
    const permitted = input.venue_slugs.filter((s: string) => allowed.includes(s));
    if (permitted.length === 0) {
      return `You do not have access to those venues. You can see: ${allowed.join(', ')}.`;
    }
    input.venue_slugs = permitted;
    return null;
  }

  // No venue given — the allow-list recorded above is what keeps the
  // "all venues" handlers in scope.
  return null;
}

/** Venue list a handler may return, honouring any caller restriction. */
export function scopeVenues<T extends { slug: string }>(venues: T[], input: Record<string, any>): T[] {
  const allowed: string[] | undefined = input[ALLOWED_VENUES];
  return allowed ? venues.filter(v => allowed.includes(v.slug)) : venues;
}
