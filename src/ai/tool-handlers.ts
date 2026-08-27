import { supabase } from '../lib/supabase.js';
import { getCovers, coversVariance, normaliseShift } from '../lib/covers.js';
import { buildChart, isClosedDay } from './charts.js';
import { renderChartSvg } from './chart-svg.js';
import { enforceVenueScope, scopeVenues } from './venue-scope.js';
import { enforceDomainScope, mayRead, type Role } from './data-domains.js';
import { NON_SPEND_STATUSES } from '../parsers/xero/bills.js';
import { coverageByAccount } from '../lib/bill-coverage.js';
import { isPayrollAccount } from '../lib/payroll-accounts.js';
import { fetchAccountMap, resolveAccount, unmappedAccounts } from '../lib/account-map.js';
import { netSalesOf, serviceChargeOf, foodAndBevSalesOf, grossSalesOf } from '../lib/sales.js';
import { groupPosts, ratioContextFrom, type Dimension } from './post-patterns.js';
import { fetchMediaThumbnails } from '../ingest/meta.js';
import { retentionRates, retentionCaveats, totalCounts, cohortRates, comparableCohorts, type RetentionCounts, type Cohort } from '../lib/retention.js';
import { normaliseChannel, channelAlerts, describeAlert, lastCompleteMonth, BASELINE_MONTHS } from '../lib/channel-health.js';

async function getVenueId(slug: string): Promise<string> {
  const { data, error } = await supabase
    .from('venues')
    .select('id')
    .eq('slug', slug)
    .single();
  if (error || !data) throw new Error(`Unknown venue: "${slug}"`);
  return data.id;
}

function getDateFilter(input: Record<string, any>): { single: string } | { start: string; end: string } {
  if (input.business_date) return { single: input.business_date };
  if (input.start_date && input.end_date) return { start: input.start_date, end: input.end_date };
  throw new Error('Provide either business_date or start_date+end_date');
}

function applyDateFilter(query: any, dateFilter: ReturnType<typeof getDateFilter>) {
  if ('single' in dateFilter) {
    return query.eq('business_date', dateFilter.single);
  }
  return query.gte('business_date', dateFilter.start).lte('business_date', dateFilter.end);
}

function dateLabel(dateFilter: ReturnType<typeof getDateFilter>): string {
  if ('single' in dateFilter) return dateFilter.single;
  return `${dateFilter.start} to ${dateFilter.end}`;
}

export const CALLER_ROLE = '__caller_role';

export async function handleToolCall(
  name: string,
  input: Record<string, any>,
  venueFilter?: string[],
  role?: Role,
): Promise<string> {
  /**
   * The WHAT dimension, beside the WHO one.
   *
   * CLAUDE.md is explicit that withholding a tool from the model's list is a
   * hint and not a control -- the model can name a tool from conversation
   * history, and the deferred read-only SQL tool would ignore the list
   * entirely. So the list stays a hint about what is useful and this is the
   * control over what is allowed.
   */
  const deniedDomain = enforceDomainScope(name, role);
  if (deniedDomain) return JSON.stringify({ error: deniedDomain });

  // Carried on the input so a handler can redact WITHIN a permitted domain --
  // the P&L is allowed for a manager, its payroll lines are not.
  if (role) input[CALLER_ROLE] = role;

  // `undefined` means an owner, who may see everything. An empty array is the
  // opposite -- a caller holding no venues at all -- and must resolve to
  // nothing. Testing `length > 0` here treated the two as the same thing, so a
  // user whose grants had been revoked was scoped to the whole group.
  if (venueFilter) {
    const denied = enforceVenueScope(input, venueFilter);
    if (denied) return JSON.stringify({ error: denied });
  }

  switch (name) {
    case 'query_social_performance':
      return querySocialPerformance(input);
    case 'query_top_posts':
      return queryTopPosts(input);
    case 'query_post_patterns':
      return queryPostPatterns(input);
    case 'query_profit_and_loss':
      return queryProfitAndLoss(input);
    case 'query_supplier_bills':
      return querySupplierBills(input);
    case 'query_product_mix':
      return queryProductMix(input);
    case 'query_daily_operations':
      return queryDailyOperations(input);
    case 'compare_venues':
      return compareVenues(input);
    case 'query_meal_period_sales':
      return queryMealPeriodSales(input);
    case 'query_reservations':
      return queryReservations(input);
    case 'query_guest_retention':
      return queryGuestRetention(input);
    case 'query_guest_cohorts':
      return queryGuestCohorts(input);
    case 'check_booking_channels':
      return checkBookingChannels(input);
    case 'query_hourly_sales':
      return queryHourlySales(input);
    case 'list_available_data':
      return listAvailableData(input);
    case 'create_chart':
      return createChart(input);
    // No 'web_search' case: it is Anthropic's server-side tool now and never
    // reaches this dispatcher. See src/ai/web-search.ts.
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/**
 * Social metrics beside trading figures, day by day.
 *
 * The join is the whole point -- social data on its own is a vanity number,
 * and the question marketing actually has is whether any of it reaches the
 * till. Returning both series aligned by date is what lets that be discussed;
 * it is emphatically NOT evidence of causation, and the tool description says
 * so because the model will otherwise be asked to draw exactly that
 * conclusion.
 */
async function querySocialPerformance(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  if (!input.start_date || !input.end_date) {
    return JSON.stringify({ error: 'start_date and end_date are required' });
  }

  let socialQuery = supabase
    .from('social_daily')
    .select('business_date, platform, metric, value')
    .eq('venue_id', venueId)
    .gte('business_date', input.start_date)
    .lte('business_date', input.end_date)
    .order('business_date', { ascending: true });

  if (input.metric) socialQuery = socialQuery.eq('metric', input.metric);

  const [{ data: social, error: socialError }, { data: trading, error: tradingError }] = await Promise.all([
    socialQuery,
    supabase
      .from('daily_operations')
      .select('business_date, gross_sales, total_guests, total_transactions')
      .eq('venue_id', venueId)
      .gte('business_date', input.start_date)
      .lte('business_date', input.end_date)
      .order('business_date', { ascending: true }),
  ]);

  if (socialError) return JSON.stringify({ error: socialError.message });
  if (tradingError) return JSON.stringify({ error: tradingError.message });

  if (!social || social.length === 0) {
    return JSON.stringify({
      venue: input.venue_slug,
      requested: `${input.start_date} to ${input.end_date}`,
      social: [],
      note: 'No social data has been ingested for this venue and period. This does NOT mean zero reach — say the data is unavailable rather than treating it as a quiet period.',
    });
  }

  // Aligned by date so the model does not have to join two lists itself, and
  // closed days are marked rather than appearing as a collapse in trade.
  const byDate = new Map<string, any>();
  for (const row of social) {
    const day = byDate.get(row.business_date) ?? { date: row.business_date, social: {}, trading: null };
    day.social[row.metric] = row.value;
    byDate.set(row.business_date, day);
  }
  for (const t of trading ?? []) {
    const day = byDate.get(t.business_date) ?? { date: t.business_date, social: {}, trading: null };
    day.trading = isClosedDay(t)
      ? { closed: true }
      : { gross_sales: t.gross_sales, covers: t.total_guests, transactions: t.total_transactions };
    byDate.set(t.business_date, day);
  }

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const socialDays = new Set(social.map(r => r.business_date));
  const gaps = days.filter(d => !socialDays.has(d.date)).map(d => d.date);

  return JSON.stringify({
    venue: input.venue_slug,
    requested: `${input.start_date} to ${input.end_date}`,
    caution: 'These are two series measured over the same days. Co-movement is NOT evidence that social activity caused trade — weather, holidays, events and bookings explain far more variance. Report what is visible; do not attribute revenue to a post.',
    days_without_social_data: gaps,
    days,
  });
}

/**
 * Individual posts, ranked.
 *
 * "Best" is not a property of a post, it is a choice of measure -- a post with
 * 40 reach and 12 interactions beats one with 4,000 reach and 300 on
 * engagement rate, and loses on every other basis. So the basis is returned
 * alongside the ranking and the tool description tells the model to name it.
 *
 * Posts missing the chosen metric are listed SEPARATELY rather than ranked as
 * zero. An image has no `views`; ranking it as zero views would bury every
 * photo beneath every reel and call it a finding about content.
 */
async function queryTopPosts(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  if (!input.start_date || !input.end_date) {
    return JSON.stringify({ error: 'start_date and end_date are required' });
  }

  // Posts and stories are never ranked together. A story reaches only people
  // who already follow you; a post can go further. Mixed, posts win every time
  // and it says nothing about the content.
  const contentType = input.content === 'stories' ? 'story' : 'post';

  const { data, error } = await supabase
    .from('social_posts')
    .select('post_id, published_at, business_date, media_type, permalink, caption, metrics, fetched_at')
    .eq('venue_id', venueId)
    .eq('content_type', contentType)
    .gte('business_date', input.start_date)
    .lte('business_date', input.end_date)
    .order('published_at', { ascending: false })
    .limit(500);

  if (error) return JSON.stringify({ error: error.message });

  if (!data || data.length === 0) {
    return JSON.stringify({
      venue: input.venue_slug,
      requested: `${input.start_date} to ${input.end_date}`,
      posts: [],
      note: 'No posts have been ingested for this venue and period. This does NOT mean nothing was posted — say the data is unavailable rather than describing it as a quiet period.',
    });
  }

  const rankBy = typeof input.rank_by === 'string' ? input.rank_by : 'total_interactions';
  const ratioCtx = ratioContextFrom(data as any[]);
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 50);

  const scoreOf = (metrics: any): number | null => {
    if (rankBy === 'engagement_rate') {
      const reach = Number(metrics?.reach);
      const interactions = Number(metrics?.total_interactions);
      // No reach means no denominator. A rate computed against zero is not a
      // very high rate, it is not a rate.
      if (!Number.isFinite(reach) || reach <= 0 || !Number.isFinite(interactions)) return null;
      return Number(((interactions / reach) * 100).toFixed(2));
    }
    if (rankBy === 'reach_multiple') {
      const reach = Number(metrics?.reach);
      if (!Number.isFinite(reach) || ratioCtx.medianReach <= 0) return null;
      return Number((reach / ratioCtx.medianReach).toFixed(2));
    }
    if (rankBy === 'contention') {
      const comments = Number(metrics?.comments);
      const likes = Number(metrics?.likes);
      // No likes means no denominator, the same as reach for engagement rate.
      if (!Number.isFinite(comments) || !Number.isFinite(likes) || likes <= 0) return null;
      // Shrunk toward the account's own rate. The raw ratio put posts with
      // THREE likes and one comment at the top of the list, above everything
      // that actually happened.
      const shrunk = (comments + ratioCtx.k * ratioCtx.baseline) / (likes + ratioCtx.k);
      return Number(shrunk.toFixed(3));
    }
    const value = metrics?.[rankBy];
    return typeof value === 'number' ? value : null;
  };

  const scored = data.map((p: any) => ({ post: p, score: scoreOf(p.metrics) }));
  const ranked = scored
    .filter(s => s.score !== null)
    .sort((a, b) => (b.score as number) - (a.score as number))
    .slice(0, limit);

  /**
   * Images, only when asked for, and only for what is being shown.
   *
   * One Graph call per post, so it is capped hard -- a top-ten costs ten calls
   * and a second of latency, which is fine on demand and would not be fine on
   * every query. The URLs are fetched fresh and never stored: Instagram signs
   * them and they expire, so a saved thumbnail becomes a broken image, which
   * reads as data we lost rather than a link that aged out.
   */
  let thumbnails: Record<string, string> = {};
  if (input.thumbnails === true && ranked.length > 0) {
    const ids = ranked.slice(0, 12).map(r => r.post.post_id);
    try {
      thumbnails = await fetchMediaThumbnails(ids, 100);
    } catch {
      // Decoration. Losing the answer because the pictures failed would be the
      // wrong trade.
    }
  }

  const shape = (s: { post: any; score: number | null }) => ({
    published_at: s.post.published_at,
    business_date: s.post.business_date,
    media_type: s.post.media_type,
    permalink: s.post.permalink,
    caption: s.post.caption,
    [rankBy]: s.score,
    metrics: s.post.metrics,
    measured_at: s.post.fetched_at,
    ...(thumbnails[s.post.post_id] ? { thumbnail_url: thumbnails[s.post.post_id] } : {}),
  });

  // Posts published in the last few days are still gathering engagement, so
  // they rank low for reasons that have nothing to do with the content.
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const stillGrowing = data.filter((p: any) => p.published_at > threeDaysAgo).length;

  return JSON.stringify({
    venue: input.venue_slug,
    requested: `${input.start_date} to ${input.end_date}`,
    content_type: contentType,
    ranked_by: rankBy,
    posts_in_period: data.length,
    caution: 'Ranking depends entirely on the measure. Say which one was used. Engagement rate favours small responsive audiences; reach favours breadth. Neither is "best" on its own.',
    ...(stillGrowing > 0 ? {
      still_accruing: `${stillGrowing} post(s) were published in the last 3 days and are still gathering engagement — they will under-rank against older posts for reasons unrelated to the content. Say so.`,
    } : {}),
    ...(scored.length - ranked.length > 0 ? {
      not_ranked: `${scored.length - ranked.length} post(s) have no "${rankBy}" value. Meta does not report every metric for every media type — an image has no views. They are excluded from the ranking, NOT scored as zero.`,
    } : {}),
    posts: ranked.map(shape),
  });
}

/**
 * Profit & Loss for one venue over a period.
 *
 * Overlapping periods are not merged. If the warehouse holds both a monthly
 * and a quarterly P&L covering the same weeks, adding them together would
 * double-count, so only rows whose period falls entirely inside the requested
 * window are returned and the periods present are named in the response --
 * the model needs to see which periods it actually got.
 */
/**
 * What KIND of post works, rather than which post won.
 *
 * The features it groups by are derived from the caption and timestamp, so a
 * period ingested before those existed has none. That case is reported as
 * missing data rather than as an empty finding -- "no posts used that hashtag"
 * and "we have not computed hashtags for that period" lead to opposite
 * decisions.
 */
async function queryPostPatterns(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  if (!input.start_date || !input.end_date) {
    return JSON.stringify({ error: 'start_date and end_date are required' });
  }

  const dimension = (input.dimension ?? 'media_type') as Dimension;
  const metric = typeof input.metric === 'string' ? input.metric : 'reach';

  // Stories are excluded and not offered. They reach only existing followers,
  // so grouping them beside posts would compare content against audience.
  const { data, error } = await supabase
    .from('social_posts')
    .select('business_date, media_type, media_product_type, collaborator_count, hashtags, mentions, caption_length, has_question, posted_hour, metrics, category, shows_people, has_call_to_action, is_repost, is_trend, shows_process')
    .eq('venue_id', venueId)
    .eq('content_type', 'post')
    .gte('business_date', input.start_date)
    .lte('business_date', input.end_date)
    .limit(2000);

  if (error) return JSON.stringify({ error: error.message });

  if (!data || data.length === 0) {
    return JSON.stringify({
      venue: input.venue_slug,
      requested: `${input.start_date} to ${input.end_date}`,
      groups: [],
      note: 'No posts have been ingested for this venue and period. This does NOT mean nothing was posted — say the data is unavailable rather than describing it as a quiet period.',
    });
  }

  const result = groupPosts(data as any[], dimension, metric, Math.min(Math.max(Number(input.limit) || 15, 1), 50));

  return JSON.stringify({
    venue: input.venue_slug,
    requested: `${input.start_date} to ${input.end_date}`,
    posts_in_period: data.length,
    ...result,
    how_to_read:
      'Groups are ranked by MEDIAN, because one post going unusually well drags a mean up and would put a group of three at the top on a single fluke. A large gap between median and mean means that group rests on one post — say so rather than recommending it. This is a correlation between a feature and a number, never a cause: posts are not assigned to categories at random, so a category that does well may simply be the one used for the strongest material.',
  });
}

async function queryProfitAndLoss(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  if (!input.start_date || !input.end_date) {
    return JSON.stringify({ error: 'start_date and end_date are required' });
  }

  let query = supabase
    .from('profit_and_loss')
    .select('period_start, period_end, section, account_name, amount, is_summary, sort_order')
    .eq('venue_id', venueId)
    .gte('period_start', input.start_date)
    .lte('period_end', input.end_date)
    .order('sort_order', { ascending: true });

  if (input.section) query = query.eq('section', input.section);
  if (input.summary_only === true) query = query.eq('is_summary', true);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });

  if (!data || data.length === 0) {
    // Distinguished from a zero result on purpose: "no P&L ingested" and
    // "this venue made no money" are wildly different answers.
    return JSON.stringify({
      venue: input.venue_slug,
      requested: `${input.start_date} to ${input.end_date}`,
      rows: [],
      note: 'No P&L data has been ingested for this venue and period. This does NOT mean zero — say the data is not available rather than inferring costs from revenue.',
    });
  }

  const periods = [...new Set(data.map(r => `${r.period_start}..${r.period_end}`))];

  /**
   * Relabel each row onto its shared name and business line.
   *
   * The three ledgers spell the same cost differently -- Fat Prince is the
   * outlier on all nine variants -- so a cross-venue comparison built on raw
   * account_name splits marketing across two buckets that never add up, in an
   * answer that looks complete. The original name is kept beside the canonical
   * one: rolling up must never hide what was rolled.
   */
  const accountMap = await fetchAccountMap(venueId);
  let rows = data.map(row => {
    const { canonical_account, business_line } = resolveAccount(row.account_name, accountMap);
    return { ...row, canonical_account, business_line };
  });

  /**
   * Payroll AMOUNTS are removed for anyone who is not owner or finance.
   *
   * The security model says aggregate payroll cost is finance and owner only,
   * and that managers see labour PERCENTAGE and never individual pay. So the
   * P&L itself stays available -- a manager who cannot see cost of sales cannot
   * run a kitchen -- and only the payroll lines lose their figure, keeping the
   * share of income, which is the number a manager is meant to work with.
   *
   * Redacted HERE rather than by not offering the tool, because withholding a
   * tool is a hint and this is a control. isPayrollAccount() is the same
   * detector the bill ingestion uses to keep personal pay out of the warehouse.
   */
  const callerRole: Role | undefined = input[CALLER_ROLE];
  let payrollRedacted = 0;

  if (callerRole && !mayRead(callerRole, 'payroll')) {
    const income = rows.find(r => r.is_summary && /total income|revenue/i.test(r.account_name ?? ''))?.amount;

    rows = rows.map(row => {
      if (!isPayrollAccount(row.account_name)) return row;
      payrollRedacted++;

      const share = income && Number(income) !== 0
        ? Math.round((Number(row.amount) / Number(income)) * 1000) / 10
        : null;

      return {
        ...row,
        amount: null,
        pct_of_income: share,
        redacted: 'payroll — amount withheld for this role; use the percentage of income',
      };
    });
  }

  // Sub-businesses roll INTO the venue P&L by default -- Neon Pigeon's sushi
  // exists to improve Potus Pte Ltd's profitability, so excluding it silently
  // would answer a different question than the one asked.
  if (typeof input.business_line === 'string' && input.business_line.trim() !== '') {
    rows = rows.filter(r => r.business_line === input.business_line.trim());
  }

  const unmapped = unmappedAccounts(data.map(r => r.account_name), accountMap);

  return JSON.stringify({
    venue: input.venue_slug,
    requested: `${input.start_date} to ${input.end_date}`,
    periods_returned: periods,
    convention: 'Costs are positive under sections named "Less ...". Rows with is_summary=true are section totals — do not add them to the detail lines beneath them.',
    source: 'Xero accounting ledger (not the POS — figures will not tie exactly to Revel sales)',
    naming: 'canonical_account is the SHARED name across venues — always compare on it, never on account_name, which differs per ledger. business_line separates sub-businesses (sushi, merchandise) that still belong in this venue\'s P&L.',
    business_lines_present: [...new Set(rows.map(r => r.business_line))],
    /**
     * A sub-business inside the venue makes these totals NOT comparable to
     * another venue's, and nothing previously said so.
     *
     * Neon Pigeon runs a sushi operation with a B2B wholesale model inside
     * Potus Pte Ltd. Its revenue and cost roll into Sales - Food and COGS -
     * Food, which is correct for the entity's real profitability and wrong for
     * a benchmark: wholesale carries a different margin structure entirely, so
     * "Neon Pigeon's food cost is 24%" is a blend of two businesses and Fat
     * Prince's 24% would not mean the same thing.
     *
     * Raised as a WARNING on the data rather than only as a line in the tool
     * description, because the description is a hint and this is the response
     * the model is actually reading when it computes the ratio.
     */
    comparability_warning: (() => {
      const sub = [...new Set(rows.map(r => r.business_line))].filter(l => l && l !== 'main');
      if (sub.length === 0 || input.business_line) return undefined;
      return (
        `These totals INCLUDE sub-business line(s): ${sub.join(', ')}. That is correct for this entity's real profitability and WRONG for a cross-venue comparison — a sub-business has its own margin structure, so a cost ratio computed here is a blend and does not mean the same thing as another venue's. ` +
        `For ANY cross-venue cost, margin or ratio comparison, call this tool again with business_line:"main" and say which basis you used.`
      );
    })(),
    payroll_redacted: payrollRedacted > 0 ? payrollRedacted : undefined,
    payroll_note: payrollRedacted > 0
      ? `${payrollRedacted} payroll line(s) have had their AMOUNT withheld for this reader's role — pct_of_income is given instead and is the figure they are meant to work with. Quote the percentage, never estimate the amount from it, and never total a section that contains a withheld line as though the total were complete.`
      : undefined,
    business_line_filter: input.business_line ?? 'none — all lines included, which is the venue\'s true P&L',
    unmapped_accounts: unmapped.length > 0 ? unmapped : undefined,
    unmapped_note: unmapped.length > 0
      ? 'These accounts have no entry in the account map, so they resolve to their own names and may not match the equivalent account at another venue. Say so if comparing venues.'
      : undefined,
    rows,
  });
}

/**
 * What a P&L cost line was actually spent on.
 *
 * The general ledger would have answered this and is closed to us -- /Journals
 * is Advanced-tier only. Bills answer it better anyway: a bill carries a
 * supplier, a description and a line coded to an account, where a journal line
 * carries only a code.
 *
 * COVERAGE IS COMPUTED HERE, NOT LEFT TO THE PROMPT, and that is the whole
 * design of this tool. Bills explain rent and food purchases almost completely
 * and marketing about a quarter, so a list of suppliers is a true answer to a
 * question nobody asked -- "who did we pay" instead of "where did the money
 * go". Every response carries the percentage of the ledger account these bills
 * account for, because a breakdown covering 26% presented as a breakdown is the
 * confident wrong answer this codebase keeps finding.
 *
 * The join to profit_and_loss is on account_id, the Xero UUID both tables hold.
 * That was discovered by probing rather than assumed, and it is what removed
 * the need for a chart-of-accounts scope.
 */
async function querySupplierBills(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  if (!input.start_date || !input.end_date) {
    return JSON.stringify({ error: 'start_date and end_date are required' });
  }
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);

  /**
   * Bills first, lines second, and NEVER one joined query summing bill.total:
   * a three-line bill would count its total three times. Migration 022 splits
   * the tables so that mistake is unavailable, and this keeps it that way.
   */
  const { data: bills, error: billError } = await supabase
    .from('supplier_bills')
    .select('id, invoice_number, supplier_name, bill_date, status, total')
    .eq('venue_id', venueId)
    .gte('bill_date', input.start_date)
    .lte('bill_date', input.end_date);

  if (billError) return JSON.stringify({ error: billError.message });

  // VOIDED and DELETED bills are stored so a figure that changed can be
  // explained, but they are not spend.
  const spendBills = (bills ?? []).filter(
    b => !NON_SPEND_STATUSES.has(String(b.status ?? '').toUpperCase()),
  );
  const billById = new Map(spendBills.map(b => [b.id, b]));

  if (billById.size === 0) {
    return JSON.stringify({
      venue: input.venue_slug,
      requested: `${input.start_date} to ${input.end_date}`,
      lines: [],
      note: 'No supplier bills have been ingested for this venue and period. This does NOT mean nothing was spent — say the detail is not available and quote the P&L account total instead.',
    });
  }

  const { data: lines, error: lineError } = await supabase
    .from('supplier_bill_lines')
    .select('bill_id, description, quantity, unit_amount, line_amount, account_code, account_id')
    .eq('venue_id', venueId)
    .in('bill_id', [...billById.keys()]);

  if (lineError) return JSON.stringify({ error: lineError.message });

  // Account NAMES live only in the P&L; a bill line carries a code and a UUID.
  // This is also the denominator for coverage.
  const { data: plRows } = await supabase
    .from('profit_and_loss')
    .select('account_id, account_name, amount, is_summary')
    .eq('venue_id', venueId)
    .gte('period_start', input.start_date)
    .lte('period_end', input.end_date)
    .not('account_id', 'is', null);

  // Canonical names here too, so a marketing breakdown at Fat Prince and one at
  // Neon Pigeon carry the same label and can be compared.
  const accountMap = await fetchAccountMap(venueId);
  const accountName = new Map<string, string>();
  const ledgerTotal = new Map<string, number>();
  for (const row of plRows ?? []) {
    if (row.is_summary) continue;  // section totals would double the denominator
    if (!row.account_id) continue;
    accountName.set(row.account_id, resolveAccount(row.account_name, accountMap).canonical_account || row.account_id);
    ledgerTotal.set(row.account_id, (ledgerTotal.get(row.account_id) ?? 0) + Number(row.amount ?? 0));
  }

  const wantAccount = String(input.account_name ?? '').trim().toLowerCase();
  const wantSupplier = String(input.supplier ?? '').trim().toLowerCase();

  const matched = [];
  for (const line of lines ?? []) {
    const bill = billById.get(line.bill_id);
    if (!bill) continue;

    const name = line.account_id ? accountName.get(line.account_id) ?? null : null;
    if (wantAccount && !(name ?? '').toLowerCase().includes(wantAccount)) continue;
    if (wantSupplier && !String(bill.supplier_name ?? '').toLowerCase().includes(wantSupplier)) continue;

    matched.push({
      account: name,
      account_code: line.account_code,
      account_id: line.account_id,
      supplier: bill.supplier_name,
      bill_date: bill.bill_date,
      invoice_number: bill.invoice_number,
      description: line.description,
      amount: Number(line.line_amount ?? 0),
    });
  }

  // Totals over EVERYTHING matched, before the limit is applied. A total that
  // silently described only the first hundred rows would be worse than no
  // total at all.
  //
  // The arithmetic lives in coverageByAccount so it can be tested without a
  // database. It is the part of this tool that decides whether an answer is
  // honest, so it is not left inline and unexercised.
  const coverage = coverageByAccount(
    matched.map(m => ({ account_id: m.account_id, account: m.account, amount: m.amount })),
    ledgerTotal,
  );

  const returned = matched
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);

  return JSON.stringify({
    venue: input.venue_slug,
    requested: `${input.start_date} to ${input.end_date}`,
    source: 'Xero supplier bills (ACCPAY). The P&L account total is the authority; these explain what sits beneath it.',
    coverage_by_account: coverage,
    reporting_rule: 'State the coverage percentage alongside any supplier breakdown. A list covering a quarter of an account, presented as the breakdown, is a wrong answer.',
    naming: 'Account names here are CANONICAL — the shared name across venues, not the raw ledger spelling. That is what makes a breakdown comparable between venues.',
    inventory_caveat: 'Some venues code food and drink purchases to an inventory account and expense them to COGS by journal later. Where that happens the bills never touch the COGS account, so coverage reads near 0% — which is the accounting working, not data missing. Say that rather than reporting a gap.',
    payroll: 'Payroll bill lines are excluded at ingestion and individual pay is never stored. Aggregate labour cost comes from query_profit_and_loss.',
    lines_returned: returned.length,
    lines_matched: matched.length,
    truncated: matched.length > returned.length
      ? `Showing the ${returned.length} largest of ${matched.length} lines. Totals and coverage above cover ALL of them.`
      : null,
    lines: returned,
  });
}

/**
 * Build a chart from warehouse data.
 *
 * The model passes parameters only; every plotted number is re-queried here.
 * The SVG is returned alongside a compact summary so the model can interpret
 * the shape of the data without the full point list bloating its context.
 */
async function createChart(input: Record<string, any>): Promise<string> {
  const spec = await buildChart({
    metric: input.metric,
    start_date: input.start_date,
    end_date: input.end_date,
    venue_slugs: input.venue_slugs ?? input.__allowed_venues,
    granularity: input.granularity,
    chart_type: input.chart_type,
    title: input.title,
  });

  if ('error' in spec) return JSON.stringify({ error: spec.error });

  const svg = renderChartSvg(spec);

  // Give the model first/last/min/max per series rather than every point, so it
  // can describe the trend accurately without re-listing the data.
  const firstLabel = spec.series[0]?.points[0]?.label;
  const lastLabel = spec.series[0]?.points[spec.series[0].points.length - 1]?.label;

  const byWeekday = spec.granularity === 'day_of_week';

  const summary = spec.series.map(s => {
    const vals = s.points.filter(p => p.value !== null) as Array<{ label: string; value: number; n?: number }>;
    if (vals.length === 0) return { venue: s.name, note: 'no data in range' };

    // Seven weekdays are a comparison, not a trend. First-to-last and a change
    // percentage are meaningless here ("Monday to Sunday, down 30%" describes
    // nothing), so the whole set goes back instead -- it is only seven numbers,
    // and handing them over stops the model estimating them off the picture.
    if (byWeekday) {
      const best = vals.reduce((a, b) => (b.value > a.value ? b : a));
      const worst = vals.reduce((a, b) => (b.value < a.value ? b : a));
      return {
        venue: s.name,
        by_weekday: vals.map(v => ({ day: v.label, value: v.value, trading_days: v.n ?? 0 })),
        busiest: { day: best.label, value: best.value, trading_days: best.n ?? 0 },
        quietest: { day: worst.label, value: worst.value, trading_days: worst.n ?? 0 },
        quietest_vs_busiest_pct: best.value !== 0
          ? Number((((worst.value - best.value) / best.value) * 100).toFixed(1))
          : null,
      };
    }

    // Trend maths ignores partial buckets. A range ending today leaves a stub
    // period, and measuring two days of a month against full months reads as a
    // collapse that never happened.
    const complete = vals.filter(v =>
      !(spec.partial_first && v.label === firstLabel) &&
      !(spec.partial_last && v.label === lastLabel));
    const basis = complete.length >= 2 ? complete : vals;

    const first = basis[0], last = basis[basis.length - 1];
    const peak = basis.reduce((a, b) => (b.value > a.value ? b : a));
    const low = basis.reduce((a, b) => (b.value < a.value ? b : a));
    const partialTail = spec.partial_last && vals[vals.length - 1].label === lastLabel
      ? { period: lastLabel, value: vals[vals.length - 1].value, note: 'PARTIAL period — not comparable to full ones' }
      : undefined;

    return {
      venue: s.name,
      first: { period: first.label, value: first.value },
      last: { period: last.label, value: last.value },
      peak: { period: peak.label, value: peak.value },
      lowest: { period: low.label, value: low.value },
      change_pct: first.value !== 0 ? Number((((last.value - first.value) / first.value) * 100).toFixed(1)) : null,
      partial_final_period: partialTail,
    };
  });

  return JSON.stringify({
    chart_created: true,
    title: spec.title,
    metric: spec.metric,
    granularity: spec.granularity,
    source: spec.source,
    periods: spec.series[0]?.points.length ?? 0,
    closed_days: spec.closed_days || undefined,
    closed_days_note: spec.closed_days > 0
      ? byWeekday
        ? 'Some dates were closures (zero sales, zero transactions) and are excluded from the weekday averages entirely — each average covers only the days that venue actually traded, which is why trading_days varies between weekdays. A low trading_days count usually means the venue is regularly shut that day: say so, do not report it as weak trading.'
        : 'Some days are absent from the plot because the venue was closed (zero sales, zero transactions). At daily granularity they appear as gaps, not zeros; at weekly or monthly they simply contribute nothing to their bucket. Do not read a gap as a sales collapse.'
      : undefined,
    summary,
    note: 'The chart is already displayed to the user. Interpret what it shows — do not list every value.',
    weekday_note: byWeekday
      ? 'Every value is an AVERAGE for that weekday across the range, not a total — describe it as "an average Tuesday", never as a sum. trading_days is how many days each average rests on. This chart says nothing about change over time; do not describe a trend from it.'
      : undefined,
    low_sample_note: spec.low_sample_days
      ? `At least one weekday average rests on fewer than 4 trading days. Quote its trading_days count when you mention it and do not present it as a pattern.`
      : undefined,
    partial_periods_note: (spec.partial_first || spec.partial_last)
      ? 'The first and/or last bucket covers only part of its period. change_pct already excludes them. Do NOT describe the final stub period as a decline — say the period is still in progress if you mention it at all.'
      : undefined,
    __chart_svg: svg,
  });
}

/**
 * Booking-level detail from SevenRooms. This is the only tool that can answer
 * walk-in, no-show, cancellation, booking-channel and table-turn questions --
 * Revel has none of that.
 */
async function queryReservations(input: Record<string, any>): Promise<string> {
  const dateFilter = getDateFilter(input);
  const range = 'single' in dateFilter
    ? { from: dateFilter.single, to: dateFilter.single }
    : { from: dateFilter.start, to: dateFilter.end };

  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return JSON.stringify({ error: 'No venues found' });
  const venues = input.venue_slug
    ? allVenues.filter(v => v.slug === input.venue_slug)
    : scopeVenues(allVenues, input);
  if (venues.length === 0) return JSON.stringify({ error: `Unknown venue: "${input.venue_slug}"` });

  const results = [];
  for (const venue of venues) {
    let rows: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data } = await supabase
        .from('reservations')
        .select('business_date, party_size, status_simple, shift_category, arrival_time, is_walk_in, is_vip, booked_by, duration_min, seated_at, left_at')
        .eq('venue_id', venue.id)
        .gte('business_date', range.from)
        .lte('business_date', range.to)
        .order('business_date', { ascending: true })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }

    if (rows.length === 0) {
      // No reservations is ambiguous on its own: the venue may have been shut,
      // or the feed may have failed. Revel settles it. If the POS took money
      // and served guests, reservations are genuinely missing and someone
      // should look. If it took nothing, the venue was closed and there is
      // nothing to chase -- Firangi Superstar is shut every Sunday, so treating
      // those as failures would cry wolf weekly.
      const { data: posRows } = await supabase
        .from('daily_operations')
        .select('business_date, gross_sales, total_guests')
        .eq('venue_id', venue.id)
        .gte('business_date', range.from)
        .lte('business_date', range.to);

      const posGross = (posRows ?? []).reduce((a: number, o: any) => a + Number(o.gross_sales ?? 0), 0);
      const posGuests = (posRows ?? []).reduce((a: number, o: any) => a + Number(o.total_guests ?? 0), 0);

      // Revel lands nightly (~04:26 SGT), so a missing POS row means different
      // things depending on the date's age: recently, that it has not arrived
      // yet; a week back, that the venue never traded.
      const ageDays = Math.floor((Date.now() - new Date(`${range.to}T00:00:00Z`).getTime()) / 86_400_000);

      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

      let status: string;
      let message: string;
      if (range.from > todayStr) {
        // A future date with no bookings is an empty book, not a failure and
        // not a closure. Revel obviously has nothing for it either.
        status = 'no_bookings_yet';
        message = 'No reservations on the book for this future date yet. That is an empty book, not a data problem.';
      } else if (!posRows || posRows.length === 0) {
        if (ageDays <= 1) {
          status = 'awaiting_revel';
          message = 'No SevenRooms reservations, and Revel has not landed for this date yet — it arrives nightly around 4:26am SGT. Check again tomorrow before treating this as a gap.';
        } else {
          status = 'venue_closed';
          message = 'Venue was closed — no reservations, and Revel recorded no trading day at all. Not a data gap.';
        }
      } else if (posGross <= 0) {
        status = 'venue_closed';
        message = 'Venue was closed — no reservations and no POS sales. Not a data gap.';
      } else if (posGuests <= 0) {
        status = 'minimal_pos_activity';
        message = `No reservations, and the POS recorded $${posGross.toLocaleString()} but zero guests — too small to be a service. Likely a test transaction or a private/staff sale rather than a missing feed.`;
      } else {
        status = 'data_gap';
        message = `Reservations are MISSING: the POS recorded $${posGross.toLocaleString()} across ${posGuests} guests but SevenRooms has no bookings. This is a genuine ingestion gap worth escalating.`;
      }

      results.push({
        venue: venue.name,
        slug: venue.slug,
        status,
        message,
        pos_gross_sales: posGross || null,
        pos_guests: posGuests || null,
      });
      continue;
    }

    const covers = (f: (r: any) => boolean) =>
      rows.filter(f).reduce((a, r) => a + Number(r.party_size ?? 0), 0);

    const complete = rows.filter(r => r.status_simple === 'Complete');
    const byShift: Record<string, number> = {};
    for (const r of complete) {
      const s = normaliseShift(r.shift_category, r.arrival_time);
      byShift[s] = (byShift[s] ?? 0) + Number(r.party_size ?? 0);
    }

    const byChannel: Record<string, { bookings: number; covers: number }> = {};
    for (const r of rows) {
      const k = r.booked_by || 'Unknown';
      byChannel[k] = byChannel[k] ?? { bookings: 0, covers: 0 };
      byChannel[k].bookings++;
      byChannel[k].covers += Number(r.party_size ?? 0);
    }

    const bookedCovers = covers(() => true);
    const noShow = rows.filter(r => r.status_simple === 'No Show');
    const cancelled = rows.filter(r => r.status_simple === 'Canceled');

    // Table turn from actual seated/left stamps, not the booked duration.
    const turns = complete
      .filter(r => r.seated_at && r.left_at)
      .map(r => (new Date(r.left_at).getTime() - new Date(r.seated_at).getTime()) / 60000)
      .filter(m => m > 0 && m < 480);

    const completedCovers = covers(r => r.status_simple === 'Complete');

    // Upcoming bookings are 'Incomplete' in SevenRooms, never 'Complete', so a
    // completion-based count reports zero for every future date. Report the
    // book instead: everything not cancelled and not a no-show.
    const expectedCovers = covers(r => r.status_simple !== 'Canceled' && r.status_simple !== 'No Show');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
    // Today is neither past nor future: service is part-done. Reporting
    // completed covers for tonight answers "how many have finished eating",
    // when the operator asked "how many are we expecting". Treat today like an
    // upcoming date for the headline, and report arrivals separately.
    const isToday = range.from === today && range.to === today;
    const isUpcoming = range.from > today || isToday;
    const spansFuture = range.to > today;

    const activeBookings = rows.filter(r => r.status_simple !== 'Canceled' && r.status_simple !== 'No Show').length;
    const completedBookings = rows.filter(r => r.status_simple === 'Complete').length;

    const expectedByShift: Record<string, number> = {};
    for (const r of rows) {
      if (r.status_simple === 'Canceled' || r.status_simple === 'No Show') continue;
      const sh = normaliseShift(r.shift_category, r.arrival_time);
      expectedByShift[sh] = (expectedByShift[sh] ?? 0) + Number(r.party_size ?? 0);
    }

    // Revel's paid-guest count over the same range, for the SOP variance check.
    const { data: ops } = await supabase
      .from('daily_operations')
      .select('total_guests')
      .eq('venue_id', venue.id)
      .gte('business_date', range.from)
      .lte('business_date', range.to);
    const revelGuests = (ops ?? []).reduce((a: number, o: any) => a + Number(o.total_guests ?? 0), 0);

    results.push({
      venue: venue.name,
      slug: venue.slug,
      period: isToday ? 'today_in_progress' : isUpcoming ? 'upcoming' : spansFuture ? 'includes_future_dates' : 'historical',
      bookings: rows.length,
      // For upcoming dates report the book; for past dates report what actually
      // happened. Both are always present so the model can be explicit.
      covers: isUpcoming ? expectedCovers : completedCovers,
      covers_meaning: isToday
        ? `EXPECTED covers for today — service is still in progress. ${completedCovers} of these have finished dining so far; the rest are still to come or currently seated.`
        : isUpcoming
          ? 'EXPECTED covers — guests booked in and not yet cancelled. These have not happened yet.'
          : 'COMPLETED covers — guests who actually dined.',
      expected_covers: expectedCovers,
      completed_covers: completedCovers,
      booked_covers: bookedCovers,
      covers_by_meal_period: isUpcoming ? expectedByShift : byShift,
      walk_in_covers: covers(r => r.is_walk_in && r.status_simple === 'Complete'),
      reservation_covers: covers(r => !r.is_walk_in && r.status_simple === 'Complete'),
      walk_in_pct: completedCovers > 0
        ? Number((covers(r => r.is_walk_in && r.status_simple === 'Complete') / completedCovers * 100).toFixed(1))
        : null,
      no_show_bookings: noShow.length,
      no_show_covers: covers(r => r.status_simple === 'No Show'),
      no_show_rate_pct: rows.length > 0 ? Number((noShow.length / rows.length * 100).toFixed(1)) : null,
      cancelled_bookings: cancelled.length,
      cancelled_covers: covers(r => r.status_simple === 'Canceled'),
      cancellation_rate_pct: rows.length > 0 ? Number((cancelled.length / rows.length * 100).toFixed(1)) : null,
      // Average party size must sit on the same basis as the headline covers
      // figure. Dividing booked covers (which include cancellations) by total
      // bookings reported an average for guests who are not coming -- a fully
      // cancelled day showed 0 expected covers and an average party of 4.5.
      active_bookings: activeBookings,
      cancelled_or_noshow_bookings: rows.length - activeBookings,
      avg_party_size: isUpcoming
        ? (activeBookings > 0 ? Number((expectedCovers / activeBookings).toFixed(1)) : null)
        : (completedBookings > 0 ? Number((completedCovers / completedBookings).toFixed(1)) : null),
      avg_party_size_basis: isUpcoming
        ? 'expected covers / bookings still live (cancellations and no-shows excluded)'
        : 'completed covers / completed bookings',
      vip_bookings: rows.filter(r => r.is_vip).length,
      avg_table_turn_min: turns.length > 0 ? Math.round(turns.reduce((a, b) => a + b, 0) / turns.length) : null,
      by_booking_channel: Object.fromEntries(
        Object.entries(byChannel).sort((a, b) => b[1].covers - a[1].covers)
      ),
      covers_check: isUpcoming ? undefined : coversVariance(completedCovers, revelGuests || null),
    });
  }

  return JSON.stringify({
    date: dateLabel(dateFilter),
    source: 'sevenrooms',
    note: 'Covers are the booked party size. Revenue questions must use query_daily_operations (Revel).',
    venues: results,
  });
}

async function queryProductMix(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const dateFilter = getDateFilter(input);
  const rowType = input.row_type ?? 'Product';
  const cls = input.class ?? 'all';
  const limit = input.limit ?? 20;

  let query = supabase
    .from('product_mix')
    .select('name, row_type, class, category, subcategory, qty, sales, pct_total, parent_product, business_date')
    .eq('venue_id', venueId)
    .limit(10000);

  query = applyDateFilter(query, dateFilter);
  if (rowType !== 'all') query = query.eq('row_type', rowType);
  if (cls !== 'all') query = query.eq('class', cls);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date: dateLabel(dateFilter), message: 'No product mix data found.' });

  // For date ranges, aggregate by product name
  if ('start' in dateFilter) {
    const agg = new Map<string, { name: string; class: string; category: string; subcategory: string; row_type: string; qty: number; sales: number; days: number }>();
    for (const row of data) {
      const key = `${row.name}|${row.row_type}|${row.class}`;
      const existing = agg.get(key);
      if (existing) {
        existing.qty += Number(row.qty);
        existing.sales += Number(row.sales);
        existing.days += 1;
      } else {
        agg.set(key, {
          name: row.name,
          class: row.class,
          category: row.category,
          subcategory: row.subcategory,
          row_type: row.row_type,
          qty: Number(row.qty),
          sales: Number(row.sales),
          days: 1,
        });
      }
    }

    let rows = [...agg.values()];
    const orderCol = input.order_by?.startsWith('qty') ? 'qty' : 'sales';
    const ascending = input.order_by?.endsWith('asc');
    rows.sort((a, b) => ascending ? a[orderCol] - b[orderCol] : b[orderCol] - a[orderCol]);
    rows = rows.slice(0, limit);

    const totalSales = rows.reduce((s, r) => s + r.sales, 0);
    return JSON.stringify({
      venue: input.venue_slug,
      date_range: dateLabel(dateFilter),
      unique_products: rows.length,
      query_total_sales: totalSales,
      rows,
    });
  }

  // Single date — existing behavior
  const orderCol = input.order_by?.startsWith('qty') ? 'qty' : input.order_by === 'name' ? 'name' : 'sales';
  const ascending = input.order_by?.endsWith('asc') || input.order_by === 'name';
  const sorted = [...data].sort((a, b) => {
    const av = orderCol === 'name' ? a.name : Number(a[orderCol]);
    const bv = orderCol === 'name' ? b.name : Number(b[orderCol]);
    if (typeof av === 'string' && typeof bv === 'string') return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
    return ascending ? (av as number) - (bv as number) : (bv as number) - (av as number);
  }).slice(0, limit);

  const totalSales = sorted.reduce((s, r) => s + Number(r.sales), 0);
  return JSON.stringify({
    venue: input.venue_slug,
    date: dateLabel(dateFilter),
    row_count: sorted.length,
    query_total_sales: totalSales,
    rows: sorted,
  });
}

async function queryDailyOperations(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const dateFilter = getDateFilter(input);

  let query = supabase
    .from('daily_operations')
    .select('*')
    .eq('venue_id', venueId);

  query = applyDateFilter(query, dateFilter);

  if ('single' in dateFilter) {
    const { data, error } = await query.maybeSingle();
    if (error) return JSON.stringify({ error: error.message });
    if (!data) return JSON.stringify({ venue: input.venue_slug, date: dateLabel(dateFilter), message: 'No operations data found for this venue and date.' });

    // Covers come from SevenRooms, revenue from Revel. See src/lib/covers.ts.
    const coversMap = await getCovers(venueId, dateFilter.single, dateFilter.single);
    const c = coversMap.get(dateFilter.single);
    const gross = Number(data.gross_sales ?? 0);

    const closedToday = isClosedDay(data);
    return JSON.stringify({
      venue: input.venue_slug,
      date: dateLabel(dateFilter),
      ...data,
      closed: closedToday,
      closed_note: closedToday
        ? 'The venue was CLOSED on this date — zero sales and zero transactions. Report it as a closure, not as poor trading, and leave it out of averages.'
        : undefined,
      covers_source: 'sevenrooms',
      covers: c?.covers ?? null,
      covers_by_meal_period: c?.by_shift ?? null,
      booked_covers: c?.booked_covers ?? null,
      walk_in_covers: c?.walk_in_covers ?? null,
      cancelled_covers: c?.cancelled_covers ?? null,
      no_show_covers: c?.no_show_covers ?? null,
      avg_spend_per_head: c?.covers ? Number((gross / c.covers).toFixed(2)) : null,
      covers_check: coversVariance(c?.covers ?? null, data.total_guests),
    });
  }

  // Date range — return daily breakdown + totals
  const { data, error } = await query.order('business_date', { ascending: true });
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date_range: dateLabel(dateFilter), message: 'No operations data found for this venue and date range.' });

  // Covers come from SevenRooms, revenue from Revel. See src/lib/covers.ts.
  const coversMap = await getCovers(venueId, dateFilter.start, dateFilter.end);

  const totals = {
    days: data.length,
    gross_sales: 0,
    food_bev_sales: 0,
    net_sales: 0,
    service_charge: 0,
    item_discounts: 0,
    order_discounts: 0,
    tax_total: 0,
    tips_total: 0,
    net_to_account_for: 0,
    total_transactions: 0,
    total_guests: 0,
    covers: 0,
  };
  const coversByShift: Record<string, number> = {};
  const closedDays: string[] = [];
  let tradingDays = 0;
  const sopBreaches: Array<{ date: string; sevenrooms_covers: number | null; revel_guests: number | null; variance: number | null }> = [];

  const daily = data.map(d => {
    totals.gross_sales += grossSalesOf(d) ?? foodAndBevSalesOf(d);
    totals.food_bev_sales += foodAndBevSalesOf(d);
    totals.net_sales += netSalesOf(d);
    totals.service_charge += serviceChargeOf(d) ?? 0;
    totals.item_discounts += Number(d.item_discounts);
    totals.order_discounts += Number(d.order_discounts);
    totals.tax_total += Number(d.tax_total ?? 0);
    totals.tips_total += Number(d.tips_total);
    totals.net_to_account_for += Number(d.net_to_account_for ?? 0);
    totals.total_transactions += Number(d.total_transactions ?? 0);
    totals.total_guests += Number(d.total_guests ?? 0);

    // Spend per head is measured on FOOD + BEVERAGE -- gross without the
    // service charge, before discounts. Confirmed by Khai. Named through the
    // helper rather than reading the column, so the basis is stated and not
    // inferred from which column happened to be to hand.
    //
    // This will NOT match Revel's own "Average Sale Per Guest", which divides
    // net sales by Revel's paid-guest count. Ours is a different numerator and
    // a different denominator (SevenRooms covers) on purpose. Do not reconcile
    // the two -- Firangi 6 Aug 2026 is 4,968.50 here against Revel's 5,286.05.
    const dayGross = foodAndBevSalesOf(d);
    const c = coversMap.get(d.business_date);
    const dayCovers = c?.covers ?? null;
    const dayClosed = isClosedDay(d);
    if (dayClosed) closedDays.push(d.business_date); else tradingDays++;

    if (dayCovers !== null) {
      totals.covers += dayCovers;
      for (const [shift, n] of Object.entries(c!.by_shift)) {
        coversByShift[shift] = (coversByShift[shift] ?? 0) + n;
      }
    }

    const check = coversVariance(dayCovers, d.total_guests);
    if (check.status === 'review') {
      sopBreaches.push({
        date: d.business_date,
        sevenrooms_covers: check.sevenrooms_covers,
        revel_guests: check.revel_guests,
        variance: check.variance,
      });
    }

    return {
      date: d.business_date,
      closed: dayClosed || undefined,
      gross_sales: grossSalesOf(d) ?? foodAndBevSalesOf(d),
      food_bev_sales: foodAndBevSalesOf(d),
      net_sales: netSalesOf(d),
      service_charge: serviceChargeOf(d),
      total_discounts: Number(d.item_discounts) + Number(d.order_discounts),
      covers: dayCovers,
      covers_by_meal_period: c?.by_shift ?? null,
      walk_in_covers: c?.walk_in_covers ?? null,
      no_show_covers: c?.no_show_covers ?? null,
      // Only present when the venue actually wrote something. A key reading
      // "NA" on every day trains the reader to skip the field.
      finance_notes: d.finance_notes || undefined,
      avg_check: d.avg_check,
      avg_spend_per_head: dayCovers ? Number((dayGross / dayCovers).toFixed(2)) : null,
      transactions: d.total_transactions,
    };
  });

  const avgCheck = totals.total_transactions > 0
    ? Number((totals.net_to_account_for / totals.total_transactions).toFixed(2))
    : 0;
  const avgSpendPerHead = totals.covers > 0
    ? Number((totals.gross_sales / totals.covers).toFixed(2))
    : null;
  // Divide by days actually traded. Including a closure drags the average down
  // and makes a venue that shuts one day a week look weaker than it is.
  const avgDailyGross = Number((totals.gross_sales / Math.max(1, tradingDays)).toFixed(2));

  return JSON.stringify({
    venue: input.venue_slug,
    date_range: dateLabel(dateFilter),
    covers_source: 'sevenrooms',
    revenue_source: 'revel',
    trading_days: tradingDays,
    closed_days: closedDays.length > 0 ? closedDays : undefined,
    closed_days_note: closedDays.length > 0
      ? 'These dates had zero sales and zero transactions — the venue was closed. avg_daily_gross already excludes them. Describe them as closures, never as weak trading days.'
      : undefined,
    totals: {
      ...totals,
      covers_by_meal_period: coversByShift,
      avg_check_overall: avgCheck,
      avg_spend_per_head: avgSpendPerHead,
      avg_daily_gross: avgDailyGross,
    },
    // Days where SevenRooms covers and Revel's paid-guest count disagree by
    // more than 2. Covers are the SevenRooms number by design; a gap here
    // means the floor SOP was not followed, not that the figure is wrong.
    covers_sop_review: sopBreaches.length > 0 ? sopBreaches : undefined,
    daily,
  });
}

async function compareVenues(input: Record<string, any>): Promise<string> {
  const dateFilter = getDateFilter(input);
  let venueFilter: string[] | undefined = input.venue_slugs;

  const { data: venues } = await supabase.from('venues').select('id, name, slug');
  if (!venues) return JSON.stringify({ error: 'No venues found' });

  const targetVenues = scopeVenues(
    venueFilter ? venues.filter(v => venueFilter!.includes(v.slug)) : venues,
    input,
  );

  const results = [];
  for (const venue of targetVenues) {
    let query = supabase
      .from('daily_operations')
      .select('gross_sales, net_sales, item_discounts, order_discounts, tax_total, tips_total, net_to_account_for, total_transactions, total_guests, avg_check, avg_sale_per_guest, sales_by_class')
      .eq('venue_id', venue.id);

    query = applyDateFilter(query, dateFilter);
    query = query.limit(1000);
    const { data: rows } = await query;
    if (!rows || rows.length === 0) continue;

    // `grossSales` here is the FOOD + BEVERAGE basis -- it is what the discount
    // rate, food split and spend per head divide by, and none of those may
    // carry service charge. `businessGross` is gross sales as the business
    // defines it, food + beverage + service charge, and is reported but never
    // used as a denominator.
    let grossSales = 0, businessGross = 0, netSales = 0, serviceCharge = 0, itemDisc = 0, orderDisc = 0, taxTotal = 0, tips = 0, netToAccount = 0, transactions = 0, guests = 0;
    let foodSales = 0, bevSales = 0;

    for (const ops of rows) {
      grossSales += foodAndBevSalesOf(ops);
      businessGross += grossSalesOf(ops) ?? foodAndBevSalesOf(ops);
      netSales += netSalesOf(ops);
      serviceCharge += serviceChargeOf(ops) ?? 0;
      itemDisc += Number(ops.item_discounts);
      orderDisc += Number(ops.order_discounts);
      taxTotal += Number(ops.tax_total ?? 0);
      tips += Number(ops.tips_total);
      netToAccount += Number(ops.net_to_account_for ?? 0);
      transactions += Number(ops.total_transactions ?? 0);
      guests += Number(ops.total_guests ?? 0);

      const salesByClass = (ops.sales_by_class as any[]) ?? [];
      foodSales += salesByClass.find(c => c.class === 'Food')?.grossSales ?? 0;
      bevSales += salesByClass.find(c => c.class === 'Beverage')?.grossSales ?? 0;
    }

    const totalDisc = itemDisc + orderDisc;
    const discRate = grossSales > 0 ? (totalDisc / grossSales * 100) : 0;
    const avgCheck = transactions > 0 ? Number((netToAccount / transactions).toFixed(2)) : 0;

    // Covers from SevenRooms, revenue from Revel. See src/lib/covers.ts.
    const range = 'single' in dateFilter
      ? { from: dateFilter.single, to: dateFilter.single }
      : { from: dateFilter.start, to: dateFilter.end };
    const coversMap = await getCovers(venue.id, range.from, range.to);

    let covers = 0;
    const coversByShift: Record<string, number> = {};
  const closedDays: string[] = [];
  let tradingDays = 0;
    for (const c of coversMap.values()) {
      covers += c.covers;
      for (const [shift, n] of Object.entries(c.by_shift)) {
        coversByShift[shift] = (coversByShift[shift] ?? 0) + n;
      }
    }

    const avgSpendPerHead = covers > 0 ? Number((grossSales / covers).toFixed(2)) : null;

    results.push({
      venue: venue.name,
      slug: venue.slug,
      days: rows.length,
      gross_sales: businessGross,
      food_bev_sales: grossSales,
      net_sales: netSales,
      service_charge: serviceCharge,
      total_discounts: totalDisc,
      discount_rate_pct: Number(discRate.toFixed(1)),
      food_sales: foodSales,
      beverage_sales: bevSales,
      food_pct: grossSales > 0 ? Number((foodSales / grossSales * 100).toFixed(1)) : 0,
      tax_total: taxTotal,
      tips,
      net_to_account_for: netToAccount,
      covers,
      covers_by_meal_period: coversByShift,
      revel_guests: guests,
      covers_check: coversVariance(covers, guests),
      avg_check: avgCheck,
      avg_spend_per_head: avgSpendPerHead,
      transactions,
    });
  }

  return JSON.stringify({
    date: dateLabel(dateFilter),
    covers_source: 'sevenrooms',
    revenue_source: 'revel',
    venues: results,
  });
}

async function listAvailableData(input: Record<string, any>): Promise<string> {
  const { data: venues } = await supabase.from('venues').select('id, name, slug');
  if (!venues) return JSON.stringify({ error: 'No venues found' });

  const venueFilter = input.venue_slug
    ? scopeVenues(venues, input).filter(v => v.slug === input.venue_slug)
    : scopeVenues(venues, input);

  const results = [];
  for (const venue of venueFilter) {
    const { data: ops } = await supabase
      .from('daily_operations')
      .select('business_date')
      .eq('venue_id', venue.id)
      .order('business_date', { ascending: false })
      .limit(30);

    const { data: pmDates } = await supabase
      .from('product_mix')
      .select('business_date')
      .eq('venue_id', venue.id)
      .order('business_date', { ascending: false })
      .limit(5000);

    const uniquePmDates = [...new Set((pmDates ?? []).map(r => r.business_date))];

    const { data: hsDates } = await supabase
      .from('hourly_sales')
      .select('business_date')
      .eq('venue_id', venue.id)
      .order('business_date', { ascending: false })
      .limit(1000);

    const uniqueHsDates = [...new Set((hsDates ?? []).map(r => r.business_date))];

    results.push({
      venue: venue.name,
      slug: venue.slug,
      operations_dates: (ops ?? []).map(r => r.business_date),
      product_mix_dates: uniquePmDates,
      hourly_sales_dates: uniqueHsDates,
    });
  }

  return JSON.stringify({ venues: results });
}

async function queryMealPeriodSales(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const dateFilter = getDateFilter(input);

  let query = supabase
    .from('hourly_sales')
    .select('business_date, meal_period, transactions, items, sales')
    .eq('venue_id', venueId)
    .limit(5000);

  query = applyDateFilter(query, dateFilter);

  const { data, error } = await query;
  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date: dateLabel(dateFilter), message: 'No hourly sales data found. This data comes from the Hourly Sales Report.' });

  const periods = new Map<string, { period: string; transactions: number; items: number; sales: number; days: Set<string> }>();

  for (const row of data) {
    const key = row.meal_period;
    const existing = periods.get(key);
    if (existing) {
      existing.transactions += Number(row.transactions);
      existing.items += Number(row.items);
      existing.sales += Number(row.sales);
      existing.days.add(row.business_date);
    } else {
      periods.set(key, {
        period: row.meal_period,
        transactions: Number(row.transactions),
        items: Number(row.items),
        sales: Number(row.sales),
        days: new Set([row.business_date]),
      });
    }
  }

  const totalSales = [...periods.values()].reduce((s, p) => s + p.sales, 0);

  // Covers per meal period come from SevenRooms; Revel's hourly report has
  // transactions (bills) but no head count. Without this, the only per-unit
  // figure available was avg_check, which is revenue per BILL -- a venue
  // seating large parties looks high on avg_check while its spend per person
  // may be unremarkable. Both are needed to read a venue correctly.
  //
  // Covers must be counted over exactly the dates that have hourly sales, not
  // the requested range. Hourly sales only exist for a handful of days so far,
  // while reservations go back years -- summing four days of sales against
  // thirty days of covers produced a spend per cover of $17 and an average
  // party of 17 people.
  const salesDates = new Set<string>(data.map((r: any) => r.business_date));
  const sortedDates = [...salesDates].sort();
  const coversMap = await getCovers(venueId, sortedDates[0], sortedDates[sortedDates.length - 1]);
  const coversByPeriod: Record<string, number> = {};
  let coversDatesMatched = 0;
  for (const [date, c] of coversMap) {
    if (!salesDates.has(date)) continue;
    coversDatesMatched++;
    for (const [shift, n] of Object.entries(c.by_shift)) {
      coversByPeriod[shift] = (coversByPeriod[shift] ?? 0) + n;
    }
  }

  const result = [...periods.values()].map(p => ({
    period: p.period,
    transactions: p.transactions,
    covers: coversByPeriod[p.period] ?? null,
    items: p.items,
    sales: p.sales,
    pct_of_total: totalSales > 0 ? Number((p.sales / totalSales * 100).toFixed(1)) : 0,
    avg_check: p.transactions > 0 ? Number((p.sales / p.transactions).toFixed(2)) : null,
    avg_spend_per_cover: coversByPeriod[p.period]
      ? Number((p.sales / coversByPeriod[p.period]).toFixed(2))
      : null,
    avg_party_size: coversByPeriod[p.period] && p.transactions > 0
      ? Number((coversByPeriod[p.period] / p.transactions).toFixed(1))
      : null,
    days_counted: p.days.size,
  }));

  return JSON.stringify({
    venue: input.venue_slug,
    date: dateLabel(dateFilter),
    // Hourly sales only exist for a few days so far. Say which dates these
    // figures actually cover so the model never presents them as the full range.
    dates_with_sales_data: sortedDates,
    days_covered: sortedDates.length,
    covers_matched_days: coversDatesMatched,
    coverage_note: `These figures cover only the ${sortedDates.length} day(s) that have hourly sales data, not the whole requested range. Covers are counted over the same days, so avg_spend_per_cover is like-for-like. State the actual dates when reporting.`,
    total_sales: totalSales,
    periods: result,
  });
}

async function queryHourlySales(input: Record<string, any>): Promise<string> {
  const venueId = await getVenueId(input.venue_slug);
  const businessDate = input.business_date;
  if (!businessDate) return JSON.stringify({ error: 'business_date is required for hourly sales query' });

  const { data, error } = await supabase
    .from('hourly_sales')
    .select('hour, time_label, transactions, items, avg_check, sales, pct_sales, meal_period')
    .eq('venue_id', venueId)
    .eq('business_date', businessDate)
    .order('hour', { ascending: true });

  if (error) return JSON.stringify({ error: error.message });
  if (!data || data.length === 0) return JSON.stringify({ venue: input.venue_slug, date: businessDate, message: 'No hourly sales data found for this date.' });

  const totalSales = data.reduce((s, r) => s + Number(r.sales), 0);
  const totalTx = data.reduce((s, r) => s + Number(r.transactions), 0);

  return JSON.stringify({
    venue: input.venue_slug,
    date: businessDate,
    total_sales: totalSales,
    total_transactions: totalTx,
    hours: data,
  });
}



/**
 * Do guests come back -- here, and to the group?
 *
 * The arithmetic is a Postgres function, not this file. Answering it means
 * looking at every prior visit by every guest who came in the period, across
 * 116,000 completed reservations, and PostgREST silently caps a result at 1,000
 * rows -- the defect this codebase has hit more than any other. A version that
 * fetched the table to count it in Node would be wrong and would still look
 * right.
 */
async function queryGuestRetention(input: Record<string, any>): Promise<string> {
  if (!input.start_date || !input.end_date) {
    return JSON.stringify({ error: 'start_date and end_date are required (YYYY-MM-DD).' });
  }

  const lookback = Number(input.lookback_days) > 0 ? Math.floor(Number(input.lookback_days)) : 365;

  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return JSON.stringify({ error: 'No venues found' });

  const venues = input.venue_slug
    ? allVenues.filter(v => v.slug === input.venue_slug)
    : scopeVenues(allVenues, input);
  if (venues.length === 0) return JSON.stringify({ error: `Unknown venue: "${input.venue_slug}"` });

  const { data, error } = await supabase.rpc('guest_retention', {
    p_start: input.start_date,
    p_end: input.end_date,
    p_lookback: lookback,
  });

  if (error) {
    // Named rather than swallowed: the likely cause is migration 028 not being
    // applied, which would otherwise look like a venue with no returning guests.
    return JSON.stringify({
      error: `Could not compute retention: ${error.message}. If this says the function does not exist, migration 028_guest_retention.sql has not been applied.`,
    });
  }

  const byVenue = new Map<string, RetentionCounts>();
  for (const row of (data ?? []) as any[]) {
    byVenue.set(row.venue_id, {
      booked_guests: Number(row.booked_guests),
      returning_here: Number(row.returning_here),
      crossed_from_sister: Number(row.crossed_from_sister),
      new_to_group: Number(row.new_to_group),
      walk_in_guests: Number(row.walk_in_guests),
    });
  }

  const empty: RetentionCounts = {
    booked_guests: 0, returning_here: 0, crossed_from_sister: 0, new_to_group: 0, walk_in_guests: 0,
  };

  /**
   * The RPC computes across every venue, because a guest crossing FROM a venue
   * the caller cannot see is still a returning group guest at one they can.
   * Scoping happens here, on what is returned -- the same boundary as every
   * other handler, and the reason cross-venue movement stays correct.
   */
  const scoped = venues.map(v => {
    const counts = byVenue.get(v.id) ?? empty;
    return {
      venue: v.name,
      slug: v.slug,
      period: { start: input.start_date, end: input.end_date, lookback_days: lookback },
      ...counts,
      rates: retentionRates(counts),
    };
  });

  const total = totalCounts(scoped.map(s => ({
    booked_guests: s.booked_guests,
    returning_here: s.returning_here,
    crossed_from_sister: s.crossed_from_sister,
    new_to_group: s.new_to_group,
    walk_in_guests: s.walk_in_guests,
  })));

  return JSON.stringify({
    period: { start: input.start_date, end: input.end_date, lookback_days: lookback },
    venues: scoped,
    // Only meaningful when more than one venue is in view -- a "group" of one
    // is the venue again under a different heading.
    group: venues.length > 1 ? { ...total, rates: retentionRates(total) } : null,
    definitions: {
      returning_here: 'Visited THIS venue within the lookback. The venue owns this one.',
      crossed_from_sister: 'Visited a DIFFERENT group venue within the lookback, but not this one. The multi-venue premium.',
      new_to_group: 'Visited no group venue within the lookback. The only guests being paid for.',
      outlet_pct: 'returning_here / booked_guests',
      group_pct: '(returning_here + crossed_from_sister) / booked_guests',
    },
    caveats: retentionCaveats(total),
  });
}


/**
 * Is retention getting better or worse?
 *
 * The cohort version of the same question, and the only one that can be
 * compared across time: everyone in a cohort gets exactly the same number of
 * days to come back, so two cohorts side by side mean something. A lifetime
 * rate compares people who have had four years with people who have had four
 * weeks, which is not a measurement.
 */
async function queryGuestCohorts(input: Record<string, any>): Promise<string> {
  const grain = ['month', 'quarter', 'year'].includes(input.grain) ? input.grain : 'quarter';
  const windowDays = Number(input.window_days) > 0 ? Math.floor(Number(input.window_days)) : 365;
  const from = typeof input.from_date === 'string' ? input.from_date : '2022-01-01';

  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return JSON.stringify({ error: 'No venues found' });

  const venues = input.venue_slug
    ? allVenues.filter(v => v.slug === input.venue_slug)
    : scopeVenues(allVenues, input);
  if (venues.length === 0) return JSON.stringify({ error: `Unknown venue: "${input.venue_slug}"` });

  const { data, error } = await supabase.rpc('guest_cohorts', {
    p_grain: grain,
    p_window: windowDays,
    p_from: from,
  });

  if (error) {
    return JSON.stringify({
      error: `Could not compute cohorts: ${error.message}. If this says the function does not exist, migration 029_guest_cohorts.sql has not been applied.`,
    });
  }

  const rows = (data ?? []) as any[];
  const toCohort = (r: any): Cohort => ({
    cohort_start: r.cohort_start,
    cohort_size: Number(r.cohort_size),
    returned: Number(r.returned),
    is_mature: r.is_mature === true,
  });

  const byVenue = venues.map(v => ({
    venue: v.name,
    slug: v.slug,
    cohorts: cohortRates(rows.filter(r => r.venue_id === v.id).map(toCohort)),
  }));

  /**
   * The group row is only offered when the caller can see the whole group.
   * A manager scoped to one venue would otherwise be handed a figure covering
   * venues they are not cleared for -- the same boundary as everywhere else,
   * and easy to miss here because the row has no venue_id to filter on.
   */
  const seesEverything = venues.length === allVenues.length && !input.venue_slug;
  const groupCohorts = seesEverything
    ? cohortRates(rows.filter(r => r.venue_id === null).map(toCohort))
    : null;

  const mature = comparableCohorts(
    (groupCohorts ?? byVenue.flatMap(v => v.cohorts)).map(c => c as Cohort),
  );

  return JSON.stringify({
    settings: { grain, window_days: windowDays, from_date: from },
    venues: byVenue,
    group: groupCohorts,
    comparable_cohorts: mature.length,
    caveats: [
      'A cohort is everyone whose FIRST visit fell in that period, each given the same window to return. That is what makes two cohorts comparable.',
      'is_mature false means the window has not fully elapsed. Its rate WILL rise. Never plot it as the latest point in a trend or describe it as a fall — say the cohort is still filling.',
      'Group rows are computed separately and do NOT equal the sum of the venue rows: a guest can be new to two venues in the same quarter.',
      'Booked guests only. Walk-ins carry a fresh SevenRooms client id each visit, so they can never be observed returning.',
      'Baseline: 81% of booked guests across the whole history visited exactly once, and under 1% visited six or more times. There is very little loyal core, so frequency schemes have almost nothing to work on; second-visit conversion is where the population is.',
    ],
  });
}


/**
 * Has a booking channel stopped working?
 *
 * The monitor that would have caught Neon Pigeon's four-month outage in its
 * second week instead of not at all. Reads a month against the median of the
 * trailing six, which is the resolution a slow failure is actually visible at
 * -- week-on-week never sees a decline spread across four months.
 */
async function checkBookingChannels(input: Record<string, any>): Promise<string> {
  const month = typeof input.month === 'string'
    ? input.month
    : lastCompleteMonth(new Date().toISOString().split('T')[0]);

  // Enough trailing history for a baseline, plus the month itself.
  const from = new Date(`${month}T00:00:00Z`);
  from.setUTCMonth(from.getUTCMonth() - (BASELINE_MONTHS + 1));
  const to = new Date(`${month}T00:00:00Z`);
  to.setUTCMonth(to.getUTCMonth() + 1);
  to.setUTCDate(0);   // last day of the month being checked

  const { data: allVenues } = await supabase.from('venues').select('id, name, slug').order('name');
  if (!allVenues) return JSON.stringify({ error: 'No venues found' });

  const venues = input.venue_slug
    ? allVenues.filter(v => v.slug === input.venue_slug)
    : scopeVenues(allVenues, input);
  if (venues.length === 0) return JSON.stringify({ error: `Unknown venue: "${input.venue_slug}"` });

  const { data, error } = await supabase.rpc('booking_channel_months', {
    p_from: from.toISOString().split('T')[0],
    p_to: to.toISOString().split('T')[0],
    p_min_bookings: 10,
  });

  if (error) {
    return JSON.stringify({
      error: `Could not read booking channels: ${error.message}. If this says the function does not exist, migration 030_booking_channel_months.sql has not been applied.`,
    });
  }

  const rows = (data ?? []) as any[];

  const byVenue = venues.map(venue => {
    /**
     * Folded to canonical names BEFORE anything is compared, because
     * SevenRooms renames channels -- "Google" became "Google Reserve
     * Integration" mid-period, which compared raw reads as one channel dying
     * and another being born.
     */
    const totals = new Map<string, number>();
    for (const r of rows) {
      if (r.venue_id !== venue.id) continue;
      const channel = normaliseChannel(r.booked_by, r.is_walk_in === true);
      const key = `${r.month}|${channel}`;
      totals.set(key, (totals.get(key) ?? 0) + Number(r.bookings));
    }

    const months = [...totals.entries()].map(([key, bookings]) => {
      const [m, channel] = key.split('|');
      return { month: m, channel, bookings };
    });

    const alerts = channelAlerts(months, month);

    return {
      venue: venue.name,
      slug: venue.slug,
      month,
      alerts: alerts.map(a => ({ ...a, explanation: describeAlert(a) })),
      channels: months
        .filter(m => m.month === month)
        .sort((a, b) => b.bookings - a.bookings),
    };
  });

  const total = byVenue.reduce((n, v) => n + v.alerts.length, 0);

  return JSON.stringify({
    month_checked: month,
    baseline: `median of the ${BASELINE_MONTHS} months before ${month}`,
    venues: byVenue,
    alert_count: total,
    // An empty list is the normal result and must not read as "no data".
    summary: total === 0
      ? 'No booking channel has fallen materially below its normal level. This is the expected result — report it as nothing wrong, not as missing data.'
      : `${total} channel(s) are materially below normal. A channel at or near zero is usually broken rather than unpopular: check the integration still works, and check it has not simply been renamed.`,
  });
}
