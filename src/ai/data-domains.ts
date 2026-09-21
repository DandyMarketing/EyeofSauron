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
  /**
   * Listed explicitly although `operations` is also the default, because here
   * the default is a DECISION rather than an omission and the two must be
   * distinguishable by reading this table.
   *
   * Hours, headcount and the scheduled-versus-actual variance are what running
   * a shift needs and carry no pay, so a manager gets them. The COST columns
   * are aggregate payroll, which the security model puts behind finance and
   * owner -- so they are withheld inside queryLabour() by the same
   * mayRead(role, 'payroll') check the P&L uses, and the percentage is kept.
   * Gating the whole tool as `payroll` would have taken rostering away from the
   * people who do the rostering.
   */
  query_labour: 'operations',
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
 * What a role actually grants, COMPUTED from the rules that enforce it.
 *
 * WHY THIS IS DERIVED AND NOT WRITTEN. The admin console offered four bare
 * options -- Manager, Staff, Finance, Owner -- with nothing saying what any of
 * them could see, so an access decision was being made from a word. The obvious
 * fix is to write a sentence under each. It is also the dangerous one: a
 * hand-written "managers see cost but not payroll" sits in an HTML file that
 * nobody edits when ROLE_DOMAINS changes, and then the console states the
 * opposite of the truth with total confidence. A wrong label on a security
 * control is worse than no label, because somebody acts on it.
 *
 * So everything below is read from ROLE_DOMAINS, from mayRead(), and from the
 * caller's own tool list. Add a domain to a role and this changes by itself;
 * add a tool and it appears against every role allowed to call it.
 *
 * WHAT IS STILL PROSE, stated plainly because a guarantee nobody knows the
 * edges of is worse than none: the redaction lines. Whether a role gets them is
 * derived -- it is the same mayRead(role, 'payroll') call the handlers make --
 * but WHAT each redaction does is described in words, so a change to how
 * queryLabour hides cost would not update this text. That is a far smaller
 * surface than the whole matrix, and the tests pin the derived half.
 *
 * TOOL NAMES ARE PASSED IN rather than imported. This module imports nothing,
 * which is how it stays unit-testable without credentials and how a reader can
 * see the whole access model in one file. Importing the tool list to describe
 * it would trade that for a convenience.
 */
export interface RoleAccess {
  role: Role;
  /** Sentence case, for a heading. Derived so a fifth role needs no lookup. */
  label: string;
  /**
   * The whole role in one line, for the moment somebody picks it.
   *
   * The full can/cannot lists are for the reference table at the top of the
   * page, stated ONCE. Repeating them under every user in a list of a hundred
   * is how a security note becomes wallpaper -- the same failure the
   * recommendation engine's repeat-suppression exists to avoid, on a page
   * instead of in a briefing.
   */
  summary: string;
  /**
   * The comparison grid, so four roles can be read against each other at a
   * glance rather than as four paragraphs to hold in your head.
   */
  matrix: {
    venues: 'Every venue' | 'Assigned only';
    operations: boolean;
    marketing: boolean;
    financial: boolean;
    payroll: boolean;
    admin: boolean;
  };
  /** One line on the WHO dimension. */
  venues: string;
  domains: Domain[];
  /** Domains this role may not read at all. */
  withheld_domains: Domain[];
  /** Tools it may call, from the list supplied. */
  tools: string[];
  /** Tools it may not, and why they are refused. */
  blocked_tools: string[];
  /** Plain sentences for the console. Derived except where noted in the file. */
  can: string[];
  cannot: string[];
}

export function describeRole(role: Role, toolNames: readonly string[] = []): RoleAccess {
  const domains = ROLE_DOMAINS[role] ?? [];
  const all: Domain[] = ['operations', 'marketing', 'financial', 'payroll'];
  const withheld = all.filter(d => !domains.includes(d));

  const sorted = [...toolNames].sort();
  const tools = sorted.filter(t => mayRead(role, domainOf(t)));
  const blocked = sorted.filter(t => !mayRead(role, domainOf(t)));

  const isOwner = role === 'owner';
  const seesPayroll = mayRead(role, 'payroll');

  const can: string[] = [];
  const cannot: string[] = [];

  can.push(
    isOwner
      ? 'Every venue, including any added later — an owner is an owner everywhere.'
      : 'Only the venues assigned to them below. A question about any other venue is refused by the tool layer, not just discouraged.',
  );

  /**
   * Payroll is skipped in this loop and spelled out below instead.
   *
   * Both lines are true and saying both made a manager's panel read "Read wage
   * and salary amounts" and "See any wage or labour AMOUNT" one under the
   * other. A panel that repeats itself gets skimmed, and this one is read
   * precisely once, immediately before somebody grants access on the strength
   * of it.
   */
  for (const d of domains) if (d !== 'payroll') can.push(`Read ${DOMAIN_WORDS[d]}.`);
  for (const d of withheld) if (d !== 'payroll') cannot.push(`Read ${DOMAIN_WORDS[d]}.`);

  /**
   * The payroll wall, which is the line this whole model exists to draw, and
   * the one most likely to be got wrong when picking a role.
   */
  if (seesPayroll) {
    can.push('See labour and wage AMOUNTS — the P&L payroll lines in full, and rostered labour cost per venue and day.');
  } else {
    cannot.push('See any wage or labour AMOUNT.');
    can.push('See labour as a PERCENTAGE: P&L payroll lines keep their share of income with the amount removed, and labour hours, headcount and labour % are shown without the cost.');
  }

  if (!isOwner) {
    cannot.push('Open this admin console, or add and remove anyone\'s access.');
    cannot.push('See group staff hours, which belong to no single venue.');
  }

  /**
   * The one-liner, assembled from the same facts rather than written out.
   *
   * Four hand-written summaries would be a fifth copy of the access model to
   * keep in step with the other four, and the one that drifts is always the one
   * a person actually reads.
   */
  const parts: string[] = [isOwner ? 'Every venue' : 'Assigned venues only'];

  const kinds = [
    domains.includes('operations') ? 'trading' : null,
    domains.includes('marketing') ? 'social' : null,
    domains.includes('financial') ? 'the P&L' : null,
  ].filter(Boolean) as string[];
  if (kinds.length) parts.push(kinds.join(', '));

  parts.push(seesPayroll ? 'wage amounts included' : 'labour % but never wage amounts');
  if (isOwner) parts.push('admin console');

  return {
    role,
    label: role.charAt(0).toUpperCase() + role.slice(1),
    summary: parts.join(' · '),
    matrix: {
      venues: isOwner ? 'Every venue' : 'Assigned only',
      operations: domains.includes('operations'),
      marketing: domains.includes('marketing'),
      financial: domains.includes('financial'),
      payroll: seesPayroll,
      admin: isOwner,
    },
    venues: isOwner ? 'every venue' : 'only the venues assigned',
    domains,
    withheld_domains: withheld,
    tools,
    blocked_tools: blocked,
    can,
    cannot,
  };
}

/** How each domain reads to somebody who has never seen the code. */
const DOMAIN_WORDS: Record<Domain, string> = {
  operations: 'trading data — sales, covers, bookings, product mix, labour hours',
  marketing: 'social and content performance',
  financial: 'the P&L and supplier bills — cost of sales, margin, overheads',
  payroll: 'wage and salary amounts',
};

/** Every role, for the admin console's selector. */
export function describeAllRoles(toolNames: readonly string[] = []): RoleAccess[] {
  return (['staff', 'manager', 'finance', 'owner'] as Role[]).map(r => describeRole(r, toolNames));
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
