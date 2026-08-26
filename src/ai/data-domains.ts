/**
 * The WHAT dimension — what a reader may see, as distinct from whose venue it
 * is.
 *
 * `venue-scope.ts` answers WHO: which venues. This answers WHAT: which kinds of
 * data. They are independent, and until now only the first existed — a
 * restaurant manager and an owner got an identical experience of their own
 * venue, payroll included.
 *
 * THE TRAP CLAUDE.md NAMES, AND THE REASON THIS FILE IS NOT A TOOL LIST.
 * Implementing this as "which tools we offer the model" is right for relevance
 * and useless for permission: the model can name a tool from conversation
 * history, and the deferred read-only SQL tool would ignore the list entirely.
 * So the tool list stays a hint about what is USEFUL, and enforceDomainScope()
 * is the control over what is ALLOWED — sitting beside enforceVenueScope(), for
 * the same reason and with the same shape.
 *
 * THE WALL IS AROUND PAYROLL, NOT AROUND FINANCE. The security model says
 * payroll is walled off, that aggregate payroll cost is finance and owner only,
 * and that managers see labour PERCENTAGE and never individual pay. It does not
 * say a manager may not see food cost — a restaurant manager who cannot see
 * cost of sales cannot run a kitchen. Drawing the line wider than stated would
 * be a different decision than the one that was made.
 */

/** Access level, from user_venue_roles.role. Not the same as job function. */
export type Role = 'owner' | 'finance' | 'manager' | 'staff';

/**
 * What a piece of data is about.
 *
 * `payroll` is the only guarded one today. The others exist so that adding a
 * second wall later is a change to one table rather than a new mechanism.
 */
export type Domain = 'operations' | 'marketing' | 'financial' | 'payroll';

/**
 * Which domain each tool reads from.
 *
 * A tool absent from here is `operations` — the safe default, because
 * operations is the least guarded domain and a new tool that quietly gained
 * payroll access by being forgotten would be the worst possible failure. A new
 * tool that is over-restricted merely does not work, and somebody says so.
 */
export const TOOL_DOMAINS: Record<string, Domain> = {
  query_profit_and_loss: 'financial',
  query_supplier_bills: 'financial',
  query_social_performance: 'marketing',
  query_top_posts: 'marketing',
  query_post_patterns: 'marketing',
};

/** Domains each role may read. */
const ROLE_DOMAINS: Record<Role, Domain[]> = {
  owner: ['operations', 'marketing', 'financial', 'payroll'],
  finance: ['operations', 'marketing', 'financial', 'payroll'],
  // A manager runs a venue: covers, product mix, cost of sales, marketing.
  // Payroll is the wall, and they see labour as a percentage instead.
  manager: ['operations', 'marketing', 'financial'],
  staff: ['operations'],
};

export function domainOf(toolName: string): Domain {
  return TOOL_DOMAINS[toolName] ?? 'operations';
}

export function mayRead(role: Role, domain: Domain): boolean {
  return ROLE_DOMAINS[role]?.includes(domain) ?? false;
}

/**
 * The caller's effective access level.
 *
 * An owner is an owner everywhere. Otherwise the STRONGEST role held at any
 * venue, because a user who is finance at one venue and a manager at another
 * is trusted with finance data — the venue filter is what stops them reading
 * the wrong venue's, and conflating the two dimensions is how a control ends up
 * enforcing neither.
 */
export function effectiveRole(user: { isOwner: boolean; venues: Array<{ role: string }> }): Role {
  if (user.isOwner) return 'owner';

  const held = new Set(user.venues.map(v => v.role));
  if (held.has('owner')) return 'owner';
  if (held.has('finance')) return 'finance';
  if (held.has('manager')) return 'manager';
  return 'staff';
}

/**
 * Refuse a tool the caller's role may not read from, or return null.
 *
 * Mirrors enforceVenueScope(): a string means refuse and say why, null means
 * carry on. `undefined` role means an internal caller with no user attached --
 * the recommendation engine, which runs as the system and is filtered on its
 * OUTPUT instead.
 */
export function enforceDomainScope(toolName: string, role: Role | undefined): string | null {
  if (role === undefined) return null;

  const domain = domainOf(toolName);
  if (mayRead(role, domain)) return null;

  return `You do not have access to ${domain} data. Your role is "${role}".`;
}

/**
 * Payroll figures in prose, which is where the recommendation engine leaks.
 *
 * THE ENGINE RUNS AS THE SYSTEM, so the tool-layer check above does not apply
 * to it -- it has to see the P&L to say anything useful about margin. The
 * briefing it writes is then read by whoever can see that venue, and the first
 * real run produced "Staff costs $68,840 / 44.8% of income". Under the stated
 * rule the percentage is fine for a manager and the dollar figure is not.
 *
 * So this is an OUTPUT guard, the same shape and the same limits as
 * namesOtherVenues(): it matches patterns, it fails closed, and every catch is
 * counted so a brief being ignored is visible. It looks for a payroll word
 * within a short distance of a currency amount, which is what the leak actually
 * looks like -- "labour is 44.8% of income" has no amount and passes, as it
 * should.
 */
const PAYROLL_WORDS = /\b(payroll|salar\w*|wage\w*|staff cost\w*|labour cost\w*|labor cost\w*|manpower|cpf|bonus\w*)\b/i;
const CURRENCY = /(?:S?\$|SGD)\s?\d[\d,]*(?:\.\d+)?(?:\s?[km])?\b/i;

export function mentionsPayrollAmounts(text: string): boolean {
  if (!text) return false;

  // Sentence by sentence: a briefing that discusses labour % in one paragraph
  // and food cost in dollars in another is not a leak, and treating the whole
  // document as one window would withhold most of what it writes.
  for (const sentence of text.split(/(?<=[.!?:;])\s+|\n/)) {
    if (PAYROLL_WORDS.test(sentence) && CURRENCY.test(sentence)) return true;
  }

  // A markdown table puts the label and the figure on the same ROW, which the
  // sentence split above already handles -- rows are newline separated. This
  // catches the header-plus-row case where the word is in a heading nearby.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!PAYROLL_WORDS.test(lines[i])) continue;
    if (CURRENCY.test(lines[i])) return true;
  }

  return false;
}

/**
 * How sensitive a recommendation is, so it can be filtered on read.
 *
 * Two independent signals, deliberately -- the domain the model assigned, and
 * what the text actually contains. The domain alone would miss a "sales"
 * recommendation that happens to quote staff costs; the text scan alone would
 * miss a labour recommendation phrased entirely in percentages, which is
 * arguably fine to show but is not what the rule says.
 */
export function sensitivityOf(rec: { domain: string; body: string; headline: string }): Domain {
  if (mentionsPayrollAmounts(`${rec.headline}\n${rec.body}`)) return 'payroll';
  if (rec.domain === 'labour') return 'payroll';
  if (rec.domain === 'cost') return 'financial';
  return 'operations';
}
