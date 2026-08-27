import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export const queryTools: Tool[] = [
  {
    name: 'query_social_performance',
    description:
      'Query social media metrics (Instagram/Facebook reach, profile views, website clicks) for a venue over a date range, returned ALONGSIDE that venue\'s daily revenue and covers for the same days. This is the tool for marketing questions: whether a campaign or a posting push moved the business, which days had both high reach and high trade, and how social activity tracks against covers. ' +
      'CRITICAL: this returns two series side by side, it does NOT establish causation. A good social day and a good trading day co-occurring is not evidence one caused the other — weather, a public holiday, a walk-in surge or a private booking explain far more variance than a post does. Say what the numbers show and say plainly that attribution is not proven. Never tell someone a post drove revenue on this evidence. ' +
      'A day missing from the social series means it was never ingested (Meta Stories data expires after ~24 hours and cannot be backfilled) — it does not mean zero reach. ' +
      'WHAT THE METRIC NAMES MEAN, because several are not what they sound like. follower_count is NEW followers gained that day, a daily change — it is NOT the size of the audience, and must never be reported as "followers" without the word "new". reach is unique accounts that saw content that day, so it CANNOT be summed across days: the same person on Monday and Tuesday is one person, and adding them double-counts. views counts plays and displays, so it can exceed reach and can be summed. profile_views, website_clicks, profile_links_taps, likes, comments, shares, saves, replies and total_interactions are per-day counts and may be summed. accounts_engaged is unique accounts, so like reach it must not be summed. ' +
      'followers_count, PLURAL, is the audience size — a snapshot taken the day it was recorded, not a figure for the close of that day. It only exists from the day we started capturing it, because Meta serves no history for it: a gap before that date means we were not looking yet, NOT that the account had no followers. Never sum it, and never chart it as if the earliest value were a starting point. follower_count singular is the daily change and they differ by one letter, so state which one you are quoting. ' +
      'TWO HARD LIMITS ON FOLLOWER DATA, both measured on 18 Aug 2026 and neither obvious. First, Meta serves follower_count for the LAST 30 DAYS ONLY — a question about follower movement further back than that has no data and cannot be answered, however much other history exists for the same venue. Second, follower_count appears to count NEW FOLLOWS and may not subtract unfollows: across 30 days it never once went negative, which a truly net figure on an eleven-thousand-follower account almost certainly would. It is unresolved. So for any question about GROWTH — "how many followers did we gain" — prefer the change in followers_count between two dates, and if you must quote follower_count say "new follows" rather than "growth", and say that unfollows may not be deducted. Reporting the sum of follower_count as net growth would overstate it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        start_date: {
          type: 'string',
          description: 'Start of the range (inclusive) in YYYY-MM-DD format.',
        },
        end_date: {
          type: 'string',
          description: 'End of the range (inclusive) in YYYY-MM-DD format.',
        },
        metric: {
          type: 'string',
          description: 'Optional single metric to return, e.g. "reach" or "profile_views". Omit for all metrics held.',
        },
      },
      required: ['venue_slug', 'start_date', 'end_date'],
    },
  },
  {
    name: 'query_top_posts',
    description:
      'Individual Instagram posts and how each performed, for one venue over a date range. This is the tool for "which posts worked", "best performing content", "what should we post more of", and anything about a specific post. Returns caption, media type, permalink, publish time and every metric held, ranked by whatever basis is asked for. ' +
      'RANKING BASIS MATTERS AND MUST BE STATED. reach is unique accounts that saw it; total_interactions is likes + comments + shares + saves; engagement_rate is interactions divided by reach, which favours posts with a small but responsive audience and can rank a post with 40 reach above one with 4,000. A post is not "best" in the abstract — say which measure you ranked by and why it suits the question. ' +
      'A metric ABSENT from a post means Meta does not report it for that media type (an image has no views), NOT that it scored zero. Never treat a missing metric as a zero, and never average across posts where some are missing it. ' +
      'Posts are dated by TRADING day on the same 3am-to-3am basis as sales, so a 2am post belongs to the night before — that is deliberate, so posts line up with the service they came out of. ' +
      'Engagement keeps accruing for days after publishing, so a post from yesterday is still growing and will under-rank against older ones. Say so when the range includes the last few days. ' +
      'Set content:"stories" for Stories. Stories are captured while they are live and vanish after ~24 hours, so a gap in them means nobody was looking at that moment, NOT that none were posted — and unlike everything else, a gap can never be filled. Their metrics differ from posts (replies, navigation) and a Story reaches only existing followers, so never rank or average them against posts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        start_date: { type: 'string', description: 'Start of range (inclusive), YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'End of range (inclusive), YYYY-MM-DD.' },
        rank_by: {
          type: 'string',
          enum: ['reach', 'total_interactions', 'likes', 'comments', 'shares', 'saved', 'views', 'engagement_rate', 'contention', 'reach_multiple'],
          description: 'What to rank on. Default total_interactions. reach_multiple ranks by how far a post travelled beyond the venue\'s own normal and is the right basis for "which posts went viral". contention is comments per like, shrunk toward the account average, and surfaces posts people DISCUSSED — which includes giveaways and caption questions, not only disagreement. Posts missing the chosen metric are listed separately rather than ranked as zero.',
        },
        content: {
          type: 'string',
          enum: ['posts', 'stories'],
          description: 'Feed posts (default) or Stories. They are NEVER returned together and must never be compared: a Story reaches only existing followers, a post can go further, so mixing them just shows posts winning on audience rather than on content.',
        },
        limit: { type: 'number', description: 'How many to return. Default 10.' },
        thumbnails: {
          type: 'boolean',
          description: 'Fetch a picture for each post returned. Use it when someone wants to SEE the posts rather than read numbers about them — "show me", "what did they look like", any question about the creative. Costs one API call per post and a second of latency, so leave it off for pure number questions. When a post comes back with thumbnail_url, render it in the answer as ![](url) so it is actually visible; the URLs expire within days, which is why they are fetched fresh and must never be quoted back later from memory.',
        },
      },
      required: ['venue_slug', 'start_date', 'end_date'],
    },
  },
  {
    name: 'query_post_patterns',
    description:
      'CATEGORY IS THE DIMENSION MARKETING PLANS ON. Every other dimension describes what a post IS — a reel, a carousel, posted at 7pm. Only "category" says what it is ABOUT: dish, drink, room, lifestyle, team, promotion, activation, news, brand. "Reels beat images" cannot be acted on; "dish posts out-reach lifestyle posts two to one at Fat Prince" can. Reach for it first on any question about what to post. ' +
      'Posts that have not been classified are EXCLUDED from a category breakdown rather than grouped as unknown — an unclassified post has not been judged, and counting it as a subject would drag every average toward the classifier backlog. If the counts look small for the period, say that classification may be incomplete rather than treating what came back as the whole picture. ' +
      'shows_process separates a MAKING video from a finished shot. A chef building a plate is category "dish" AND shows_process true, so "does a dish shown being made beat a dish shown finished" is answerable with the subject held constant — which is the whole reason it is a flag rather than a tenth category. Do not confuse it with shows_people: a guest eating a finished plate shows people and no process. ' +
      'shows_people, has_call_to_action, is_repost, is_trend and shows_process are FLAGS that cut across category — a trend-format reel of a cocktail is category "drink" with is_trend true. That is what makes "do trend formats work" answerable with the subject held constant. ' +
      'is_trend IS LOW CONFIDENCE and must be reported as an indication, never as a fact. Trends live largely in audio the classifier cannot hear, and a trend that ran after its training cutoff cannot be recognised at all — so a false negative is likely and the true number of trend posts is probably higher than the count. ' +
      'Classification came from reading the caption and looking at the image. It is a judgement, not a measurement: say "classified as" rather than asserting what a post was. ' +
      'What KIND of Instagram post performs, rather than which individual post won. Groups a venue\'s posts by a feature — hashtag, media type, weekday, time of day, caption length, whether it asks a question, who it mentions — and reports how each group performed. This is the tool for "what should we post more of", "does posting at 6pm work better", "which hashtags actually help", "do reels beat photos", and any attempt to repeat a success. ' +
      'SAMPLE SIZE IS THE WHOLE STORY HERE. Each group carries a post count and a "thin" flag. A venue posts roughly thirty times a month, so splitting a single month ten ways leaves three posts a group — and three posts will show a 40% difference from pure noise. Never recommend an action off a thin group; say it is a hint worth watching and ask for a longer period. Widen the date range before drawing a conclusion. ' +
      'Groups are ranked by MEDIAN, not mean, so one viral post cannot carry a group to the top. Both are returned: a large gap between them means that group rests on a single post, and saying so is more useful than the ranking. ' +
      'THIS IS CORRELATION AND NEVER CAUSE. Posts are not assigned to categories at random — the venue chooses which content gets a reel and which gets a photo, so a category that performs well may simply be the one used for the strongest material. Say "posts tagged X have done better" and never "tagging X makes posts do better". ' +
      'A post missing the chosen metric is EXCLUDED, not counted as zero, and the count of exclusions is returned — Meta does not report every metric for every media type. ' +
      'For hashtags and mentions one post lands in several groups at once, so the counts add to more than the number of posts and no group is a share of the whole. ' +
      'If posts_excluded_no_feature is large, the derived features have not been computed for that period yet — report that as missing data, NOT as a venue that used no hashtags. ' +
      'INSTAGRAM REACH IS EXTREMELY SKEWED, and this is the single most important thing to hold in mind. A handful of posts do the overwhelming majority of a venue\'s reach: Neon Pigeon\'s median post reaches about 800, and one reel reached 141,241. So NEVER quote a mean reach, and be careful reading any group average — one breakout inside a group will carry it. reach_multiple exists for this: it measures a post against the venue\'s own median. Also treat a breakout as mostly a fact about the algorithm rather than a repeatable choice: that same venue posted twice more referencing the viral joke and reached 1,086 and 2,279, not 141,241. ' +
      'CONTROVERSY IS NOT SUCCESS. A post can travel a long way because people disagreed with it — a dish that looked wrong to them, a recipe they thought was done badly. Reach cannot tell those apart from a post people loved. The contention measure narrows it down — disagreement costs typing where praise costs a tap — but it cannot prove disagreement, because giveaways and caption questions drive comments too. Before recommending more of anything that ranked high on reach, check its contention. If it is high, say the post travelled because it was CONTESTED, and do not recommend repeating it without saying that out loud. ' +
      'Stories are excluded entirely: they reach only existing followers, so grouping them beside posts compares audience rather than content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        start_date: { type: 'string', description: 'Start of range (inclusive), YYYY-MM-DD. Prefer a long range — a single month is too few posts to split.' },
        end_date: { type: 'string', description: 'End of range (inclusive), YYYY-MM-DD.' },
        dimension: {
          type: 'string',
          enum: ['hashtag', 'mention', 'media_type', 'media_product_type', 'weekday', 'time_of_day', 'caption_length', 'has_question', 'is_collab', 'category', 'shows_people', 'has_call_to_action', 'is_repost', 'is_trend', 'shows_process'],
          description:
            'What to group by. Default media_type. Use media_product_type rather than media_type for "do reels work": media_type reports VIDEO for both a feed video and a reel, which are distributed nothing alike. is_collab separates posts published WITH another account — those reach the collaborator\'s audience too, so a collab breakout is about distribution, not content. weekday uses the TRADING date (3am-to-3am, matching sales) so it lines up with the night a post belongs to; time_of_day uses the real Singapore clock hour it was published, which for a 2am post is a different answer — both are correct and they answer different questions.',
        },
        metric: {
          type: 'string',
          enum: ['reach', 'total_interactions', 'likes', 'comments', 'shares', 'saved', 'views', 'engagement_rate', 'contention', 'reach_multiple'],
          description: 'What to measure each group by. Default reach. reach_multiple is reach divided by the venue\'s MEDIAN post reach — 1.0 is normal, 150 means the post escaped the follower base entirely, and it is the measure that finds a breakout. contention is comments per like, shrunk toward the account average so tiny-denominator posts cannot top the list — it measures how much a post was DISCUSSED, which includes giveaways and questions, not only disagreement. engagement_rate is interactions divided by REACH, not by followers — it measures how hard the people who saw a post responded, and flatters small responsive audiences.',
        },
        limit: { type: 'number', description: 'How many groups to return. Default 15.' },
      },
      required: ['venue_slug', 'start_date', 'end_date'],
    },
  },
  {
    name: 'query_profit_and_loss',
    description:
      'Query Profit & Loss data from Xero for a venue over a period: revenue, cost of sales, operating expenses, and the account lines within each. Use this for any question about cost, margin, profit, food cost percentage, labour cost, overheads, or whether something was actually profitable. ' +
      'IMPORTANT: figures come from the accounting ledger, not the POS, so they will not match Revel sales exactly — the ledger is on a different basis and includes items the POS never sees. Say which source a figure came from when both are in play. ' +
      'Costs are POSITIVE numbers under sections named "Less ..." — that is Xero\'s convention, not an error. Detail lines and section totals are both returned; use the is_summary flag rather than adding everything up, or every section is counted twice. ' +
      'Only periods that have been ingested are available; if a period is missing, say so rather than estimating it from revenue. ' +
      'COMPARE VENUES ON canonical_account, NEVER ON account_name. The three ledgers spell the same cost differently — Fat Prince writes "Public Relations / Marketing costs" where the others write "fees" — so comparing raw names splits one cost across two buckets that never add up, and the answer looks complete. canonical_account is the shared name; account_name is kept beside it so you can say what was rolled together. ' +
      'Any account listed in unmapped_accounts has no entry in the account map and resolves to its own name, so it may not match the equivalent account elsewhere. Say so when comparing venues. ' +
      'business_line separates sub-businesses that still belong in the venue P&L — Neon Pigeon sells sushi and merchandise inside Potus Pte Ltd. Left unfiltered you get the entity\'s true profitability, which is what is wanted for "how is this venue doing"; filter to a single line when asked about that business on its own. ' +
      'CROSS-VENUE COMPARISONS MUST BE RUN WITH business_line:"main". The sushi operation is a B2B WHOLESALE business whose revenue and cost roll into Sales - Food and COGS - Food. That is correct for the entity and wrong for a benchmark: wholesale carries its own margin structure, so Neon Pigeon\'s blended food cost is not the same measurement as a restaurant-only food cost at Fat Prince, and comparing them reads as a difference in kitchen performance when it is a difference in business model. Whenever you compare a cost ratio, margin or percentage ACROSS venues, call this tool with business_line:"main" and say that is the basis you used. The response carries a comparability_warning whenever sub-lines are included and no filter was set — act on it rather than comparing anyway.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        start_date: {
          type: 'string',
          description: 'Start of the period (inclusive) in YYYY-MM-DD format.',
        },
        end_date: {
          type: 'string',
          description: 'End of the period (inclusive) in YYYY-MM-DD format.',
        },
        section: {
          type: 'string',
          description: 'Optional filter on the Xero section heading, e.g. "Income" or "Less Cost of Sales". Omit for the whole P&L.',
        },
        summary_only: {
          type: 'boolean',
          description: 'True returns only section totals (Total Income, Total Cost of Sales). Use for headline profit questions; omit to see the account lines behind them.',
        },
        business_line: {
          type: 'string',
          description: 'Optional. Isolate a sub-business: "sushi" or "merchandise" at Neon Pigeon, "main" for the rest. OMIT IT for any question about the venue\'s or the company\'s profitability — a sub-business belongs INSIDE the entity P&L, and Neon Pigeon\'s sushi exists precisely to improve Potus Pte Ltd\'s bottom line. Use it only when asked about that business specifically.',
        },
      },
      required: ['venue_slug', 'start_date', 'end_date'],
    },
  },
  {
    name: 'query_supplier_bills',
    description:
      'Break a Xero P&L cost line down into the actual supplier bills behind it — who was paid, for what, and how much. This is the drill-down for "we spent $26,034 on marketing in June, on what?". Returns bill lines with supplier name, description and amount, grouped by ledger account, for one venue and period. ' +
      'ALWAYS REPORT THE COVERAGE PERCENTAGE that comes back with the answer, and never present a breakdown as the complete story without it. Bills explain rent, utilities and food purchases almost entirely, but only a fraction of card- and bank-settled spend: measured at Neon Pigeon for June 2026, marketing was 26% covered, commissions 7%, merchant fees 1%, and beverage COGS 0%. A confident-looking list of suppliers that accounts for a quarter of the account is the most misleading answer this tool can give. Say "these bills account for X% of the $Y in that account" every time. ' +
      'Coverage above 100% means credit notes. We do not ingest ACCPAYCREDIT, so refunds and returns are not deducted and the bill-derived figure is OVERSTATED — food cost has measured 109%. Say so rather than presenting the higher number as the truth. ' +
      'PAYROLL IS NOT HERE AND NEVER WILL BE. Wages are posted as supplier bills in this chart of accounts, so payroll lines are excluded at ingestion and individual pay is never stored. Aggregate labour cost is available from query_profit_and_loss as a section total. If asked about someone\'s pay, say the system does not hold it. ' +
      'The P&L account total is the authority; these bills are the explanation beneath it, not a replacement for it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        start_date: {
          type: 'string',
          description: 'Start of the period (inclusive) in YYYY-MM-DD format. Use the same period as the P&L you are explaining.',
        },
        end_date: {
          type: 'string',
          description: 'End of the period (inclusive) in YYYY-MM-DD format.',
        },
        account_name: {
          type: 'string',
          description: 'Optional. The P&L account to explain, e.g. "Public Relations / Marketing" — matched loosely, so a fragment works. Omit to see every account with bills in the period.',
        },
        supplier: {
          type: 'string',
          description: 'Optional. Filter to one supplier, matched loosely. Use for "how much did we pay X this year".',
        },
        limit: {
          type: 'number',
          description: 'Maximum bill lines to return (default 100, max 500). Totals and coverage are computed over EVERYTHING in the period, not just the lines returned.',
        },
      },
      required: ['venue_slug', 'start_date', 'end_date'],
    },
  },
  {
    name: 'query_product_mix',
    description: 'Query product-level sales data for a venue on a given date or date range. Returns item names, quantities sold, sales amounts, categories, and percentage of total sales. Use this to answer questions about what sold, top/bottom sellers, food vs beverage breakdown, category performance, and modifier usage. For date ranges, results are aggregated across all dates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
        row_type: {
          type: 'string',
          enum: ['Product', 'Modifier', 'all'],
          description: 'Filter by row type. Default "Product" to avoid double-counting modifiers.',
        },
        class: {
          type: 'string',
          enum: ['Food', 'Beverage', 'all'],
          description: 'Filter by class. Use "all" to see both.',
        },
        order_by: {
          type: 'string',
          enum: ['sales_desc', 'sales_asc', 'qty_desc', 'qty_asc', 'name'],
          description: 'Sort order. Default sales_desc (top sellers first).',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return. Default 20.',
        },
      },
      required: ['venue_slug'],
    },
  },
  {
    name: 'query_daily_operations',
    description: 'Query daily operations summary for a venue: gross/net sales, discounts, taxes, tips, payments, covers, average check, average spend per head, service fees. DEFINITIONS, which are the business\'s and not the textbook ones: gross_sales is food + beverage + the 10% service charge; net_sales is gross_sales less discounts; food_bev_sales is food + beverage alone. Service charge is ALREADY INSIDE both gross_sales and net_sales — service_charge is returned for reference only and must never be added on top. Food and beverage cost percentages are measured against food_bev_sales, never against a figure carrying service charge. Supports single date or date range. IMPORTANT — two different systems of record: REVENUE always comes from Revel (the POS), and COVERS always come from SevenRooms (the reservation system), because Revel cannot break covers down by meal period. avg_spend_per_head is food_bev_sales — food + beverage, no service charge, before discounts — divided by SevenRooms covers. Revenue per PERSON, and the metric to lead with. It deliberately does NOT match Revel\'s own "Average Sale Per Guest", which uses net sales over Revel\'s paid-guest count; never present the two as the same figure or try to reconcile them. avg_check is revenue per BILL and moves with party size, so report it as secondary context, never on its own. covers_by_meal_period splits covers into brunch/lunch/dinner. Also returns walk_in_covers, no_show_covers and cancelled_covers, which only SevenRooms can see. The covers_check / covers_sop_review fields compare SevenRooms covers against Revel\'s paid-guest count: a gap means the floor team did not log walk-ins or adjust party sizes, so it is a data-entry issue to raise with the venue, NOT a reason to doubt the revenue figure. finance_notes is the venue\'s own free-text explanation of that day, written on the Monday board — vouchers, a wrongly closed table, an F&B credit, a payment arriving later. It appears only on days where something was written. ALWAYS check it before describing a figure as unusual or unexplained, and quote it when it accounts for what you were about to flag: the venue has often already answered the question. It is an explanation offered by a person, not a measurement, so attribute it ("the venue noted...") rather than stating it as fact. If covers are null, SevenRooms data has not been ingested for that date. A day flagged closed:true had zero sales and zero transactions, meaning the venue did not open — Firangi Superstar closes every Sunday. Always describe such a day as a closure, never as a decline or a bad day, and never include it when averaging; trading_days and avg_daily_gross already exclude them.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
      },
      required: ['venue_slug'],
    },
  },
  {
    name: 'compare_venues',
    description: 'Compare key metrics across venues for the same date or date range. Returns side-by-side gross sales, net sales, covers, average check, average spend per head, food/beverage split, and discount rates. gross_sales is food + beverage + the 10% service charge; net_sales is that less discounts; food_bev_sales is food + beverage alone and is what discount rate, food split and spend per head are measured against. Never add service_charge on top of gross_sales or net_sales — it is already inside both. Revenue comes from Revel (the POS); covers come from SevenRooms (the reservation system), including a covers_by_meal_period breakdown. avg_spend_per_head is food_bev_sales — food + beverage, no service charge, before discounts — divided by SevenRooms covers. Revenue per PERSON, and the metric to lead with. It deliberately does NOT match Revel\'s own "Average Sale Per Guest", which uses net sales over Revel\'s paid-guest count; never present the two as the same figure or try to reconcile them. avg_check is revenue per BILL and moves with party size, so report it as secondary context, never on its own. revel_guests and covers_check are included for transparency — a large covers_check variance means that venue is not logging walk-ins properly, which is worth flagging separately from performance. For date ranges, metrics are totalled across the period. Use this for benchmarking and cross-venue analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
        venue_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Venues to compare. Omit to compare all venues.',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_meal_period_sales',
    description: 'Query sales breakdown by meal period (lunch/brunch/dinner) for a venue. Returns, per meal period: sales, transactions (BILLS, not people), covers (PEOPLE, from SevenRooms), avg_check (revenue per bill), avg_spend_per_cover (revenue per person) and avg_party_size. avg_spend_per_cover is the metric that matters for comparing venues or meal periods — avg_check rises simply because parties are bigger, so quoting it alone misleads. Lead with spend per cover, quote avg check alongside. Never call a transaction count a cover count. If covers are null, SevenRooms data is missing for those dates — say so rather than falling back to avg_check as if it were the same thing. Derived from hourly sales data. Use this to answer questions about lunch vs dinner performance, brunch sales on weekends, or meal period trends. Note: Fat Prince Saturday/Sunday lunch is labelled "brunch", Firangi Superstar Saturday lunch is labelled "brunch".',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
      },
      required: ['venue_slug'],
    },
  },
  {
    name: 'query_reservations',
    description: 'Query reservation and covers data from SevenRooms for one venue or all venues. This is the ONLY source of booking-level detail — use it for any question about reservations, walk-ins, no-shows, cancellations, booking channels, party sizes, VIPs, or table turn times. Revel (the POS) cannot answer these. Returns: total bookings and covers, a brunch/lunch/dinner split, walk-in vs reservation covers, no-show and cancellation counts and rates, a breakdown by booking channel (booked_by — e.g. "Walk In", "Google Reserve Integration", "Booking Widget", or a staff member\'s name), average party size (computed on the same basis as the covers figure, so it excludes cancellations — a fully cancelled day returns null, not an average), bookings alongside active_bookings (bookings counts every record including cancellations; active_bookings excludes them, so quote active_bookings next to covers or the two will not reconcile), VIP count, and average table turn time in minutes. USE THIS FOR UPCOMING BOOKINGS TOO — Sauron is an operations tool, so questions like \'how many covers do we have tonight\', \'what does the weekend look like\' or \'how is next week booking up\' are answered here. Reservation data is ingested about 60 days forward. For a future date the response has period:\'upcoming\' and covers means EXPECTED covers (booked and not yet cancelled), not people who have dined — say so when reporting it, and never present a forward book as achieved covers. expected_covers and completed_covers are always both returned so you can be precise. For TODAY the period is \'today_in_progress\' and covers likewise means expected covers, because service is only part-done — completed_covers tells you how many have finished dining so far, so answer \'X booked tonight, Y already seated or finished\'. Status no_bookings_yet on a future date means an empty book, not a fault. Note covers are the booked party size, so they may differ slightly from the POS guest count; that variance is reported as covers_check and reflects floor data-entry, not a revenue problem. When a venue has no reservations for a date, the response carries a status field that has already checked Revel and distinguishes the cases — "venue_closed" means the venue was shut and there is nothing to investigate (Firangi Superstar closes every Sunday, so state that plainly and do NOT suggest chasing the venue team), "data_gap" means the POS took money and served guests so reservations really are missing and it is worth escalating, "minimal_pos_activity" means a trivial non-service transaction, and "awaiting_revel" means Revel has not landed for that date yet and it should be re-checked tomorrow. Report whichever case applies rather than hedging between them.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi". Omit to return all three venues side by side.',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_guest_retention',
    description:
      'Do guests come back? Returns, per venue and for the group, how many booked guests in a period were returning to THAT venue, arriving from a SISTER venue, or new to the group entirely. ' +
      'OUTLET AND GROUP RETENTION ARE DIFFERENT METRICS AND FIXING THEM IS DIFFERENT WORK. Outlet retention is whether this venue gave someone a reason to come back HERE — the venue owns it: food, service, room, value. Group retention is whether the group held the guest at all, at any venue — the group owns it: CRM, cross-venue communication, loyalty. Report both, never blend them into one rate, and attribute a problem to the right one. ' +
      'BOOKED GUESTS ONLY, and this is not optional. SevenRooms issues a fresh client id for nearly every walk-in (1.00 visits per guest against 1.34 for booked guests), so a walk-in can never be observed returning and including them would understate retention by construction. Walk-ins are counted separately and coverage_pct says what share of the period\'s guests this metric can actually see — at Neon Pigeon that is around 69%. Quote it whenever the rate is quoted. ' +
      'It counts GUESTS, meaning the booking, not diners. A returning regular who brings four first-timers is one returning guest. This measures relationship, not reach — never describe it as "x% of people in the room had been before". ' +
      'The lookback is a FIXED 365 days by default rather than "has ever visited", because with four years of history an ever-visited rate climbs every month purely as the window widens. Do not raise the lookback to make a number look better. ' +
      'CHECK THE COUNTS BEFORE READING ANY MOVEMENT. crossed_from_sister measured 12 guests across the whole group in a week — ordinary variation on a count that size is several guests, which is tens of percent of the metric. The response returns caveats; repeat the relevant ones rather than presenting a small-sample figure as a trend. Use a multi-week window when comparing periods.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi". Omit for all venues plus a group total.',
        },
        start_date: {
          type: 'string',
          description: 'Start of the period (inclusive), YYYY-MM-DD. Prefer a whole number of weeks — a part-week compared against a whole one invents a trend.',
        },
        end_date: {
          type: 'string',
          description: 'End of the period (inclusive), YYYY-MM-DD.',
        },
        lookback_days: {
          type: 'number',
          description: 'How far back a prior visit counts as a return. Defaults to 365. Changing it changes what the number means, so say so if you do.',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'query_guest_cohorts',
    description:
      'Is retention getting BETTER OR WORSE over time? Groups guests by when they first visited, and reports how many came back within a fixed window (365 days by default). Use this for any question about a trend in retention, whether a change worked, or how a period compares with an earlier one. ' +
      'WHY THIS AND NOT query_guest_retention: that one measures a period — who was in the room last week and had they been before. This one measures a COHORT — everyone who first arrived in the same quarter, each given exactly the same number of days to come back. Only the cohort version can be compared across time, because a lifetime rate mixes guests who have had four years to return with guests who have had four weeks. ' +
      'NEVER COMPARE AN IMMATURE COHORT. Rows carry is_mature and a warning. A cohort that has not yet had the full window shows a near-zero rate purely because the days have not passed, and plotting it as the latest point draws a collapse that is the calendar rather than a finding. Say the most recent cohort is still filling rather than reporting its number as a fall. ' +
      'Group rows have venue "Group" and are computed separately, NOT by summing the venues — a guest can be new to two venues in the same quarter, so the venue rows deliberately do not add up to the group row. ' +
      'Booked guests only, walk-ins excluded, for the reason given in query_guest_retention. Baseline measured Aug 2026: 81% of booked guests visited exactly once across four and a half years, and the 6-or-more group is under 1%, so there is very little loyal core — second-visit conversion is where the population is.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi". Omit for all venues plus the group.',
        },
        grain: {
          type: 'string',
          enum: ['month', 'quarter', 'year'],
          description: 'Cohort size. Quarter is the default and usually right — a month of first-time guests at one venue is often too small to read.',
        },
        window_days: {
          type: 'number',
          description: 'How long a guest has to come back and still count as returning. Defaults to 365. A shorter window makes more cohorts mature but measures a different thing, so say which you used.',
        },
        from_date: {
          type: 'string',
          description: 'Earliest first-visit date to include, YYYY-MM-DD. Defaults to 2022-01-01, the start of the reservation history.',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_booking_channels',
    description:
      'Health check on where bookings come from. Returns bookings per channel per month for a venue, and RAISES AN ALERT for any material channel that has fallen to half its normal level or below in the last complete month. Use it for any question about booking channels, where guests come from, or whether something has broken — and check it whenever new guests or covers are down and the cause is not obvious. ' +
      'WHY IT EXISTS. Neon Pigeon\'s two online booking paths both collapsed in February 2025 and stayed down until June: Google Reserve went 86, 43, 5, 1; the booking widget went 186, 133, 32, 24, 14. Roughly 360 bookings were lost over four months and nothing reported it, because a decline spread across four months is invisible in a week-on-week comparison. ' +
      'A CHANNEL AT OR NEAR ZERO IS USUALLY BROKEN, NOT UNPOPULAR. Say so: an integration that stopped, a listing taken down, a widget migration. Recommend checking the channel works before offering a market explanation. And check it has not simply been RENAMED — SevenRooms relabelled "Google" as "Google Reserve Integration" mid-period, which reads exactly like one channel dying and another appearing. ' +
      'AN EMPTY ALERT LIST IS THE NORMAL AND CORRECT RESULT. Report it as nothing wrong, not as no data. ' +
      'The month checked is always the last COMPLETE one, because a part-month is always down on its own baseline. Baselines are medians of the trailing six months, so one exceptional December cannot mask a real drop, and channels under about 20 bookings a month are ignored as noise.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi". Omit to check all venues.',
        },
        month: {
          type: 'string',
          description: 'The month to check, as YYYY-MM-01. Defaults to the last complete month. Only use this to investigate a past period.',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_hourly_sales',
    description: 'Query hour-by-hour sales breakdown for a venue on a specific date. Shows transactions, items sold, average check, and sales for each hour. Use this to understand peak hours, quiet periods, and hourly sales patterns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Business date in YYYY-MM-DD format.',
        },
      },
      required: ['venue_slug', 'business_date'],
    },
  },
  {
    name: 'list_available_data',
    description: 'List which dates have data for each venue. Use this FIRST when unsure what data is available, or when a query returns no results. Shows the most recent dates with operations summaries and product mix data.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Optional: filter to a specific venue. Omit to see all venues.',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_chart',
    description: 'Draw a chart from warehouse data and show it to the user. Call this WHENEVER the answer covers a trend over time — several weeks, months or years — because a line is far easier to read than a column of numbers. Also use it to compare venues side by side. You supply only the metric, venues, dates and chart type; the server re-queries the warehouse and plots the real figures, so never put numbers in this call and never describe a chart you have not created. The chart appears above your reply — reference it and interpret it in words (what moved, when, and why it matters), do not just restate every value. Available metrics: gross_sales, food_bev_sales, net_sales, avg_check, covers, avg_spend_per_head, walk_in_pct, no_show_rate. gross_sales is food + beverage + the 10% service charge; net_sales is that less discounts; food_bev_sales is food + beverage alone and is the basis cost percentages use. When the user just says "sales" with no qualifier, plot net_sales and call it net sales in the reply. Days when a venue was closed are plotted as a gap rather than a zero, and returned as closed_days — mention a closure if it is visible in the chart, but never read it as a sales collapse. Bucketing is chosen automatically — daily under ~5 weeks, weekly under ~4 months, monthly beyond — so a multi-month request produces a readable monthly line rather than hundreds of daily points. To answer "which days of the week are slow / busy", set granularity to "day_of_week": that returns seven bars averaging every Monday, every Tuesday and so on across the range, which is the only way to see the weekly pattern — a daily line over several months is unreadable and cannot answer it. The reply for a day_of_week chart carries every weekday value in by_weekday, so quote those figures rather than estimating from the picture. Instagram can be plotted too: instagram_reach, instagram_views, instagram_interactions, instagram_followers. Reach is UNIQUE accounts, so a weekly or monthly point is the AVERAGE DAY and not a total -- say \"average daily reach\" whenever the bucket is longer than a day. instagram_followers is the audience size at the END of the bucket, never a sum. Social is NOT blanked on a day the venue was closed, because a closed venue still posts and its audience still sees it. Plotting social beside trade is worth doing, but co-movement is not causation -- describe what moved and never say a post caused revenue. You may call this more than once for different metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: {
          type: 'string',
          enum: ['gross_sales', 'food_bev_sales', 'net_sales', 'avg_check', 'covers', 'avg_spend_per_head', 'walk_in_pct', 'no_show_rate', 'instagram_reach', 'instagram_views', 'instagram_interactions', 'instagram_followers'],
          description: 'What to plot. Revenue metrics come from Revel; covers, walk-in and no-show come from SevenRooms.',
        },
        start_date: { type: 'string', description: 'Start of range (inclusive), YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'End of range (inclusive), YYYY-MM-DD.' },
        venue_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Venues to plot: "neon-pigeon", "fat-prince", "super-firangi". Omit for all three, which draws one line per venue for comparison.',
        },
        granularity: {
          type: 'string',
          enum: ['day', 'week', 'month', 'day_of_week'],
          description: 'How to bucket the data. Omit for time-series questions and the server picks day/week/month from the range length — usually correct. Set "day_of_week" ONLY for questions about the weekly pattern (which days trade well or badly): it collapses the whole range into seven bars, Monday to Sunday, each the AVERAGE of that weekday, and ignores the calendar order entirely. Note "by day" is ambiguous in plain English — if the user is asking which days of the week are quiet, they mean day_of_week, not daily granularity.',
        },
        chart_type: {
          type: 'string',
          enum: ['line', 'bar'],
          description: 'Use "line" for anything over time (the default). Use "bar" only for comparing a handful of discrete buckets.',
        },
        title: { type: 'string', description: 'Optional title. Omit for a sensible default.' },
      },
      required: ['metric', 'start_date', 'end_date'],
    },
  },
];

/**
 * `web_search` used to be defined here, calling the Brave Search API from
 * handleToolCall. It is now Anthropic's server-side tool, declared in
 * src/ai/web-search.ts and added to the tool list in the engine -- so it is
 * absent from this file by design, not by omission.
 *
 * The reason for moving it is provenance: the server-side tool returns
 * citations tying each claim to a url and the sentence it came from, which is
 * what lets an external figure be checked instead of taken on trust. Brave
 * returned prose snippets with no such link.
 */
