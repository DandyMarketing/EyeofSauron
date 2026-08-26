# Project Sauron — Context for Claude Code

This file is the project brief. Read it fully before doing anything. It is the source of truth for what we're building and how we've decided to build it.

## What Sauron is

An **AI business-advisor platform for F&B**, built for **The Dandy Collection** (a multi-venue F&B group). It connects every operational system into one data warehouse, shows real-time analytics on custom dashboards, and — the core product — puts a Claude/Opus "brain" in front that not only answers questions but **proactively tells each venue leader how to improve their business, backed by charts**. Delivered through a web app chatbot AND a Telegram number, so the ops team never has to open a laptop. Long-term goal: sell it to other F&B operators (multi-tenant SaaS).

**Positioning (important):** This is NOT "another restaurant dashboard." The analytics are table stakes; the **recommendations are the product**. The dashboard and the AI advice must live in one integrated surface — that's why we build the front end ourselves and did NOT use an off-the-shelf BI tool (Metabase was explicitly considered and rejected for this reason).

## Who I am / how to work with me

I'm Khai — many years in F&B, building this as the company AI. I code alongside you. My working rules:
- **Ask questions when anything is ambiguous. Do not assume.**
- **Never hallucinate.** If you don't know, say so and check.
- **Ask permission before changing anything** (files, config, infra).
- Explain the *why*, not just the *what* — I want to understand the system I'm building.

## The data sources (and how we get each)

| System | Gives us | How | Notes |
|---|---|---|---|
| Revel (POS) | Product mix + revenue per venue | **Nightly CSV** via Revel's Auto-Delivery to a Gmail inbox | Their API is US$500/venue/mo — REFUSED. Venue + business date are **in the filename** (e.g. `Product_Mix_Daily_Report_neonpigeon_neonpigeon_20260716_20260717.xlsx`). Daily granularity. |
| Xero | P&L, costs, profit | OAuth2 API (free dev app) | Easiest integration. |
| SevenRooms | Reservations, covers, guest CRM | API (approval-gated) | Request access early. |
| StaffAny | Rosters, hours, labour cost | API | Khai has access. |
| Zeemart | Inventory, purchasing, ingredient cost | Open API (+ native Xero integration) | Fills the food-cost gap → true food cost % + margin. |
| Metricool/Meta, Monday, Gmail, Drive | Social, PM, comms, docs | Already connected via MCP | — |

**Revel ingestion detail:** one Gmail inbox handles all venues because the filename self-identifies. Parse venue + date from the filename. Map the opaque venue key (e.g. `neonpigeon_neonpigeon`) to a `venue_id` via a **lookup table**; an unknown key must be flagged by a watchdog, never guessed. File columns: Row Type (Product/Modifier), Class (Food/Beverage), Name, SKU, Barcode, Category, Subcategory, Qty, Sales (taxable + non-taxable), % Total Sales, COGS. COGS arrives as 0 (food cost comes from Zeemart, not Revel). Flag Modifier rows so they aren't double-counted. Sample verified: Neon Pigeon, 16 Jul 2026 = **$5,974** across 74 products / 283 units; the file's % column reconciles to 100%.

### Xero: the general ledger is closed to us, and bills are the way in

Established 19 Aug 2026, after two rounds of failed consent.

Xero replaced its broad API scopes with **granular** ones for every app created
on or after **2 March 2026**. Ours is one of them, and that has two consequences
that cannot be worked around:

- **`accounting.reports.read` does not exist for us.** The granular form is
  `accounting.reports.profitandloss.read`, and asking for the broad one fails the
  whole authorization with `invalid_scope` — not a warning, not a partial grant.
- **The general-ledger `/Journals` endpoint is unavailable, and the reason is
  commercial.** It sits on Xero's **Advanced tier — US$895 a month** — and
  additionally requires a Xero security assessment, initially and annually, plus
  use-case approval. There is also no granular scope for it: connections made
  before the cutover keep `accounting.journals.read`, ours can never have it.
  Treat the ledger drill-down as closed. It is not worth $10,740 a year to learn
  what is inside a cost bucket.

So "marketing cost $26,034 in June — on what?" cannot be answered from the
ledger. It can be answered from **supplier bills**, which are invoices of type
ACCPAY under the `accounting.invoices` scope group, and arguably better: a bill
carries a supplier, a description and line items coded to an account, where a
journal line carries only a code.

**When adding a scope, add exactly one, and test it through the `XERO_SCOPES`
environment variable before it goes into the code default.** Xero refuses the
entire consent and never names the offending scope, so a list that grows by two
is a list nobody can debug — which is precisely how this cost two rounds of
reconnecting three organisations.

**API tiers and limits, since they now exist.** Five tiers: Starter (free),
Core, Plus, Advanced (US$895/mo), Enterprise. We are on **Starter**, which
allows **5 connections and 1,000 API calls per organisation per day** — ample,
since the whole two-year P&L backfill is 72 calls. Paid tiers meter data
*egress* rather than calls, so a future decision to upgrade is about volume
pulled, not requests made.

**Supplier bills are not tier-gated, but were not granted.** On 19 Aug 2026
`accounting.invoices.read` was accepted by the consent screen, fresh tokens were
stored for all three organisations, and `GET /Invoices` still returned 401. The
consent screen had listed only "View your profit & loss reports", which turned
out to be literally true rather than a summary. The remaining lead is the app's
own permitted-scope configuration in the Xero developer portal — unresolved.

**Payroll arrives through supplier BILLS, and had to be excluded at ingest.**
Not requesting a payroll scope was necessary and not sufficient. This chart of
accounts posts wages as ACCPAY bills, so the first bill ingestion on 19 Aug 2026
pulled 168 lines across four payroll accounts for one venue in one month --
roughly forty people times four accounts, i.e. individual pay. Those rows were
deleted and `payrollAccountIds()` now drops them before anything is written,
matching on account NAME from the P&L because a bill line carries only a code
and a UUID. Aggregate labour cost still reaches the warehouse through the P&L,
where it is a section total with no names. The exclusion is reported on every
run: an exclusion nobody can see is indistinguishable from one that stopped
working.

**Bills do not explain every account, and the tool must say so.** Measured for
Neon Pigeon, June 2026: bills cover rent, utilities and food purchases at ~100%,
and Public Relations / Marketing at **26%**, Commissions at 7%, Merchant fees at
1%, COGS Beverages at 0%. Anything card- or bank-settled is invisible to
`/Invoices` and needs `accounting.banktransactions.read` (free, already in the
app's scope list). Four accounts came back ABOVE 100% -- COGS Food at 109% --
which points at credit notes: ACCPAYCREDIT reduces the ledger and we do not
ingest it, so bill-derived food cost is currently overstated. Never present a
supplier breakdown as complete without the coverage percentage beside it.

**One authorization, one refresh token, three organisations — and rotation
breaks all but one of them if you let it.** Xero issues a SINGLE token pair for
an authorization covering every organisation approved, and a refresh CONSUMES
the old refresh token the instant the new one is issued. `storeConnection`
writes that shared token to all three rows correctly; the refresh originally
wrote the rotated one back to only the tenant it was refreshing, leaving the
other two holding a token Xero had just destroyed. On 23 Aug 2026 the 24-month
backfill stored four months and 3,702 bill lines for Neon Pigeon while Fat
Prince and Firangi Superstar failed on EVERY month with `invalid_grant:
Refresh token has been consumed`. Reconnecting fixes it only until the next
refresh, which is why it looked intermittent. `sharedAuthorizationTenants()`
now writes the rotated pair to every row holding the token that was just used,
found by DECRYPTING and comparing — `encrypt()` uses a random IV, so the same
token has different ciphertext in every row and the columns cannot be matched
directly.

**A column a bug fix might CHANGE must never be part of a unique key.** The
`profit_and_loss` key included both `section` and `is_summary` -- the parser's
DESCRIPTION of a row rather than its identity. One fix rewrote both at once:
Gross Profit, Operating Profit and Net Profit went from detail lines under
positional labels ("Section 3", "Section 9/10/11/12", which drifted month to
month because they came from the report's shape) to totals under their own
names. The upsert matched nothing and INSERTED -- 213 duplicate rows across
three venues and two years, each line present once correctly and once still
claiming to be a detail line. Both real, both the same amount, invisible unless
somebody counted. Worse than the bug being fixed, because
`query_profit_and_loss` tells the model to trust `is_summary` instead of adding
everything up, so a "total costs" question would have swept three computed
totals into the cost base. Migration 023 keys on
`(venue_id, period_start, period_end, account_name)` and nothing else.

**The account-name exclusion has a blind spot, and a second guard now covers
it.** `payrollAccountIds()` learns which accounts hold personal pay by reading
account NAMES out of the P&L -- so it is structurally blind to an account the
P&L never reports. An audit on 23 Aug 2026 found 46 bill lines carrying named
individuals' net salaries and SDL (supplier: Ministry of Manpower), plus
dividends and a director loan repayment, all coded to accounts with no P&L row.
They were deleted, and `looksLikePersonalPay()` now reads the LINE itself --
description and supplier -- on every row regardless of its account. The two
counts are reported separately on every run, because the second one measures
how much the first would have missed. Bill lines coded to an account the P&L
does not report are also counted now: usually balance-sheet and harmless, but
that is exactly the condition that hid the salary accounts.

**The three ledgers name the same cost differently, and it is mapped rather
than renamed.** Measured 23 Aug 2026: Firangi Superstar and Neon Pigeon agree,
and Fat Prince is the outlier on all nine variants -- "Public Relations /
Marketing costs" against "fees", "Merchant Fees" against "merchant fees",
"Recruitment expeses" (their typo) against "Recruitment / Visa expenses".
Cross-venue benchmarking is the product's edge and only holds if the same cost
carries the same label, so comparing raw account names splits marketing across
two buckets that never add up, in an answer that looks complete.

Renaming in Xero would fix our three ledgers once. It was rejected because the
stated goal is selling this to other operators, and **you cannot ask a customer
to rename their chart of accounts** -- a mapping layer is a product requirement,
not a workaround. `account_map` (migration 024) holds two independent axes:
`canonical_account` unifies naming so venues can be COMPARED, `business_line`
separates sub-businesses so they can be ISOLATED. Neon Pigeon's sushi rolls into
Potus Pte Ltd's P&L -- improving it was the point of launching it -- while
staying reportable alone.

**An unmapped account defaults to ITSELF, deliberately unlike the BOH/FOH role
mapping where defaulting is forbidden.** The difference is what the default
does: falling into a bucket makes a category drift with no visible cause;
falling back to your own name merges nothing and moves no figure, and the only
cost is that unification has not happened yet. It is listed in the admin console
so somebody decides, rather than flagged as a fault.

**Never request a payroll scope.** The security model's strongest protection is
not ingesting personal pay at all, and lacking the permission is surer than
remembering to filter. There is a test asserting it.

### Google Business Profile: check the licence before building the pipe

**Not blocked, but not cleared either. Do not build ingestion until this is
settled.**

Google Business Profile is the most tempting source we have not connected —
direction requests, call clicks, food orders and menu clicks are closer to
footfall than any Instagram number will ever be. Someone asking Maps how to get
to Fat Prince is nearly a cover.

The obstacle is not technical. Google's
[content policies](https://developers.google.com/my-business/content/policies)
say you may not "pre-fetch, cache, index, or store any content provided through
the Business Profile APIs for use outside of your Business Profile project",
and where storage is allowed it must be **no more than 30 calendar days** and
**"cannot be manipulated or aggregated in any way"**.

Warehouse-first plus daily aggregation plus joining to covers is a direct
description of what that forbids. Enforcement is API project disablement
"without warning".

Three things are genuinely unresolved and none is an engineering question:

- whether the **Performance API** carries the same terms as the management APIs
  this page seems aimed at;
- what "outside of your Business Profile project" means when the locations are
  **your own**;
- what agreement **Metricool** operates under, since it plainly does store and
  aggregate this data.

That third point matters, because it inverts the usual preference. Normally we
take the raw source and avoid a middleman. Here, if Google forbids us from
storing it and permits a partner to, then going through the partner is the
legitimate route rather than the compromise.

**Get the answer in writing when requesting API access**, and prefer it to any
reading of the page. The only unambiguously safe design is querying live per
question and storing nothing — which cannot do trends, comparisons, or anything
joined to trade, and is therefore most of the reason to want it.

Location ids are already known, from Metricool's brand settings:

| Venue | Google location |
|---|---|
| Firangi Superstar | `accounts/102505042675622804445/locations/11636347290593663654` |
| Neon Pigeon | `accounts/102505042675622804445/locations/17617416516498414612` |
| Fat Prince | `accounts/102505042675622804445/locations/14934836359944958535` |

### Meta's follower data has two hard limits, and neither is obvious

Measured 18 Aug 2026 by listing row counts per metric after a full two-year
backfill. Both were invisible until then, because a metric that returns nothing
looks exactly like a metric nobody asked for.

- **`followers_count`** (plural, the audience TOTAL) — **no history at all.**
  The series starts the day we began capturing it. Every night the job does not
  run is a permanent hole.
- **`follower_count`** (singular, new followers that day) — **last 30 days
  only.** Not two years. A question about follower movement further back has no
  data, however much other history the venue has.

Together these kill an idea that keeps suggesting itself: reconstructing the
historical follower total by subtracting cumulative daily gains from today's
figure. There are no daily gains to subtract beyond a month.

**The consequence for analysis.** Post performance cannot be normalised by
follower count for anything historical, so `query_post_patterns` uses
interactions ÷ **reach**. That measures how hard the people who saw a post
responded, not how many it deserved to reach — and old posts still flatter or
flatter less depending on the account's size at the time, which we cannot know
before mid-July 2026. Say so when comparing across long periods.

**Unresolved:** whether `follower_count` is net or gross. Across 30 days at Neon
Pigeon it ran min 0, max 10, avg 3 and never once went negative — unlikely for a
genuinely net figure on an 11,000-follower account, so it probably excludes
unfollows. `follows_and_unfollows`, the metric that would answer it directly,
returned **zero rows for two full years** and now sits in `CANDIDATE_METRICS`
rather than being requested. A reminder to re-test is scheduled for 26 Aug 2026,
once enough `followers_count` history exists to compare against.

Until it is resolved, never report the sum of `follower_count` as growth — it is
"new follows", and unfollows may not be deducted.

### Metrics do not all land together — one marker cannot prove a window complete

Fat Prince, same investigation: `views` had all 729 days while `reach` had 678 —
missing 29 at the start and 22 scattered inside. Everything else had 729.

The backfill judged a window done by checking one representative metric, which
was `views`. So every window looked complete, every window was skipped, and
re-running could never repair `reach`. The gap was permanent and silent, and the
run reported success.

`backfill-meta.ts` now takes `--marker=<metric>`, so a specific metric's gaps
can be refilled. Be aware that repairing one metric re-fetches every metric for
the affected windows — correctness over economy, but it is not free. Never set
the marker to `follower_count` or `followers_count`; with no usable history,
every window would look incomplete forever.

### What each social source is actually for

Settled 18 Aug 2026, after checking what each one can really provide:

- **Meta API** — our own Instagram. Two years of history, the full metric set.
  Authoritative.
- **Google API** — Business Profile, subject to the licence question above.
- **Metricool** — **competitors, and nothing else.** Its Instagram history only
  begins Jan/Feb 2026, so it is the shallower source for anything we already
  own. What it uniquely provides is competitor followers, post and reel counts,
  average likes and comments, and engagement per 1,000 followers. Meta will
  never expose insights for an account you do not own, so no direct integration
  can replace this.

Ingesting Instagram from both Meta and Metricool would give two figures for the
same metric that disagree slightly — the Monday-versus-Revel problem, bought
voluntarily. Don't.

Competitor data is **public-surface only**: post counts, likes, comments,
followers. Not reach, not impressions, not saves. It answers "are we posting
more than them, and does their audience respond harder per follower" and not
"how many people did they reach". Cross-venue benchmarking runs on owned data
and is solid; competitor benchmarking is directional. Sauron must say which of
the two it is using.

### Layer 2: what a post is ABOUT, and why visualisation is a rule

Built 23 Aug 2026. The taxonomy had been agreed and written into
`src/ai/post-taxonomy.ts` -- nine categories in Khai's own words -- and nothing
consumed it. No columns, no classifier, no query dimension.

Layer 1 is what a post IS: media type, hashtags, caption length, posting hour.
It answers "reels beat images", which nobody can act on. Layer 2 is what it is
ABOUT -- dish, drink, room, lifestyle, team, promotion, activation, news, brand
-- and "dish out-reaches lifestyle two to one at Fat Prince" is a plan.

**Category and flags are different shapes on purpose.** A post has exactly one
subject and any number of attributes. A trending-audio reel of a cocktail is a
Drink post wearing a trend format; making "trend" a tenth category would delete
it from the subject analysis and destroy the only question worth asking --
whether trend formats beat straight ones with the subject held constant.

**The image is UPLOADED, not linked.** Passing Instagram's CDN url to the API
fails every time with `This URL is disallowed by the website's robots.txt file`
-- Anthropic's image fetcher obeys robots.txt and Instagram disallows crawlers,
so no Instagram media can ever reach the API by link. The bytes are fetched by
us and sent as base64. A failed image degrades that ONE post to caption-only
rather than skipping it, and the count is reported so a weak pass is visible.

**The image is sent, not just the caption.** Dish vs Drink vs Room vs Lifestyle
is a distinction about what is in the picture, and a cocktail post captioned
"Friday." is unclassifiable from text. `classified_from` records which was used
because a caption-only pass and a caption+image pass are not comparable.

**A making video and a plated shot are both Dish, and `shows_process`
separates them.** Spotted at fifty posts: a good number are the team presenting
or building a dish, which the taxonomy's own rule correctly sends to Dish
because the food is the subject -- leaving a build and a finished plate
indistinguishable in the data. Made a FLAG rather than a tenth category, on the
same argument as `is_trend`: format cuts across subject, and a tenth category
would have removed those posts from the subject analysis and destroyed the only
question worth asking -- does a dish shown being MADE beat a dish shown
finished, with the subject held constant. Not the same as `shows_people`: a
guest eating a finished plate shows people and no process. Added at fifty posts
deliberately, because a taxonomy change costs whatever is already classified.

**`is_trend` is low confidence and says so everywhere.** Trends live largely in
audio the classifier cannot hear, and one that ran after the training cutoff
cannot be recognised at all -- so the true count is probably higher than the
number. Report it as an indication, never as a fact.

**NULL is not a category and not a false.** An unclassified post has not been
judged; grouping it would put the classifier's backlog on the same footing as a
real subject. Same for every flag: judged-absent and never-judged are different,
and collapsing them makes a flag a majority-false column that means nothing --
the `collaborator_count` mistake, one table over.

**Show the data, do not narrate it.** A paragraph containing six figures is the
hardest possible way to read six figures, and this is for operators on a phone
between services. The system prompt now requires a table for anything past
about three numbers or any comparison, and `create_chart` whenever the metric is
one it supports. Being honest about the boundary matters: create_chart covers
sales, covers, spend per head, walk-ins, no-shows and Instagram only -- P&L
lines, supplier bills, product mix and post categories have to be markdown
tables, and the prompt says so rather than letting the model promise a chart it
cannot draw.

## Company structure (Singapore incorporation)

Each venue is its own private limited company, under an umbrella that operates
them. This is the standard Singapore structure, and it matters to how the
accounts are read:

| Legal entity | Trading as |
|---|---|
| **The Dandy Partnership Pte Ltd** | umbrella — operates the others |
| Potus Pte Ltd | Neon Pigeon |
| 20 Craig Road Pte Ltd | Firangi Superstar |
| Fat Prince Pte Ltd | Fat Prince |

**Two of the three entity names tell you nothing about the venue.** "Potus" and
"20 Craig Road" (an address) would not be guessed by any human or model, and
Meta's verified entity is a fourth name again. This is the concrete reason
every source that arrives keyed by a legal entity — Xero organisations above
all — maps to a venue through a lookup table confirmed by a person, never by
name matching. See BUILD_LOG 2.2 for what name-guessing costs.

**The umbrella has no P&L.** Confirmed by Khai. Every cost lands in a venue's
own Pte Ltd, with genuinely shared costs split across venues where necessary.
Nothing is stranded at group level.

This is the good case, and it matters more than it sounds:

- **A venue's Xero P&L is its real, fully-loaded profitability** — not profit
  before an overhead layer that gets added elsewhere. It can be stated plainly
  without a qualifier.
- **Cross-venue margin comparison is valid.** Benchmarking is described above as
  the product's edge, and it only holds if each venue's costs are on the same
  basis. Here they are. Had group costs sat above the venues, every comparison
  would have needed an allocation caveat attached.

There are **three Xero organisations**, one per venue. The umbrella is not one
of them.

The one residual judgment: a shared cost that is split still has a split basis,
so a line item allocated across venues is less comparable than a direct one.
Worth knowing which lines those are before leaning hard on a small margin
difference — but this is a refinement, not the structural problem it would have
been.

Entity and venue are 1:1 today; do not assume that holds if a single Pte Ltd
ever operates two outlets.

## Tech stack & key decisions

- **Railway** — compute (backend, web app, self-hosted n8n). Holds static secrets as **sealed variables**.
- **Supabase** — Postgres warehouse + Auth + **Row-Level Security**. Start on hosted free tier, SEA region.
- **Claude / Opus (Anthropic API)** — the chatbot + Insight & Recommendation Engine.
- **n8n** — ingestion orchestration (Gmail triggers, scheduling, retries). Self-host on Railway.
- **GitHub** — repo; Railway deploys from it.

**Firm conventions:**
- **Keep the Revel parser + all validation/reconciliation logic in versioned code** (in this repo), NOT in n8n nodes. n8n is for triggers/orchestration only.
- **Warehouse-first**: the LLM queries the prepared Supabase warehouse, it does NOT call source APIs live per question. (Faster, resilient, and the only way to answer historical/trend questions.)
- **Anti-hallucination is non-negotiable**: the LLM never states a number from memory. Every figure comes from a query tool; every suggestion and chart is built on real warehouse data. A reconciliation gate checks figures (line items sum to totals; Revel sales CSV reconciles with revenue CSV) before data is trusted.
- Postgres is correct at this scale — do NOT over-engineer with a big analytics warehouse.

### Model tiering, thinking and caching: settled 23 Aug 2026

Until now `claude-sonnet-5` was hardcoded in three places in `engine.ts`, there
was no tiering at all, and **no `thinking` parameter existed anywhere in the
codebase** -- every answer, including the analytical ones, was written straight
through. The brief had specified "Opus for deep reasoning/suggestions; a
faster/cheaper model for routine lookups & routing" and it had never been built.

`src/ai/model-policy.ts` maps a PURPOSE to a model, and the purpose is chosen
once per request rather than per turn. That is forced rather than tidy: prompt
caches are **model-scoped**, so switching mid-conversation discards the entire
cached prefix. It is also the only honest split -- the tool loop's first round
is routing and its last is analysis, through the same call site.

| Purpose | Model | Thinking | Why |
|---|---|---|---|
| `chat` | Opus 5 | adaptive, high | Where the product's value is delivered |
| `recommendation` | Opus 5 | adaptive, xhigh | Nobody waiting; a weak proactive suggestion teaches people to ignore the feature |
| `lookup` | Sonnet 5 | none | A date and a number. Latency beats depth |
| `recovery` | Sonnet 5 | none | Restating data already gathered, after something already failed |

**Thinking is `{type: 'adaptive'}` and never `budget_tokens`** -- the older form
is rejected with a 400 on Opus 5 and Sonnet 5, so a stale prior there takes the
chat down rather than degrading it. Per-purpose env overrides
(`SAURON_MODEL_CHAT` and friends) change the MODEL only; thinking and effort
describe the job, not the engine.

**Caching is a prefix match, so the ordering IS the design.** The system prompt
was one concatenated string -- base prompt, then today's date, then a
conditional venue paragraph, then the notes -- and every one of those is a
documented cache-killer. The venue paragraph was the worst: it made the prefix
per-user, so no two people could ever share an entry. It is now two blocks, the
frozen half first with the breakpoint on it, so tools and standing instructions
cache together across every user and question. A second breakpoint MOVES along
the conversation's tail rather than accumulating, because a request allows only
four and a twelve-round loop would want twelve.

**Every response logs `cache_read`, `cache_write` and a hit rate.** A cache that
silently stops working otherwise appears as a bill months later and nothing
else. Known limit worth watching there: a breakpoint looks back at most 20
content blocks, so one round with more than 20 tool_use/tool_result blocks
misses and pays full price -- visible as the hit rate dropping.

**A refused optional feature costs the feature, never the product.**
`isModelFeatureError()` catches a 400 naming thinking or output_config, retries
without them and says so loudly -- the same rule as `isWebSearchConfigError()`,
learned from `country: 'SG'` taking down every question including ones that
never touched the web.

### Web search: external context, and the provenance problem it creates

Settled 19 Aug 2026. Sauron uses **Anthropic's server-side web search**
(`web_search_20260209`), not a search API called from our own handler.

The first implementation called Brave from `handleToolCall`. It never ran once:
`BRAVE_SEARCH_API_KEY` was never set, so every search the model attempted
returned the string "Web search not configured" and the model wrote its answer
without it. Nothing reported this, for the entire life of the feature. That is
the same failure class as the unapplied migrations and the silent reach gaps —
it worked, it looked fine, it was doing nothing.

**The switch was made for provenance, not for search quality.** The rule is that
every figure comes from a query tool, and an external number breaks it unless a
reader can see where it came from. Brave returns a description snippet with no
link between any particular number and any particular source, so attribution
would have to be inferred from prose — by us. The server-side tool returns
**citations**: each cited claim carries the url, the page title, and up to 150
characters of the sentence it was drawn from. That is the provenance record,
supplied rather than reconstructed, and the web app renders it under the answer
in a visibly different style. Cost was not a factor either way (Anthropic $10
per 1,000 searches, Brave ~$5; at this volume both are a few dollars a month),
and Brave's free tier ended in Feb 2026 in any case.

**Three controls, only one of which is a prompt.** `max_uses: 5` is enforced by
Anthropic, so a runaway loop cannot happen — the Brave alternative was a card
with no spending cap behind a tool the model can call twelve times a question.
`user_location` is set to Singapore, without which holidays and local events
return a different and useless web -- but with **no `country` field**, because
`country: 'SG'` is a valid ISO 3166-1 alpha-2 code that the API rejects
outright (`Country code SG is not supported`). Anthropic accepts a subset and
does not publish which, so a valid code is not an accepted one and reading the
spec cannot tell you. City and timezone carry the localisation instead.

**A rejected tool definition must not take the product down.** That 400 shipped
on every request, so every question failed -- including ones that never touch
the web. `isWebSearchConfigError()` now catches a 400 naming web_search, drops
the tool, retries once and logs loudly. Same principle as `warnSchema` versus
`requireSchema`: a degraded app beats a dead one, and a misconfigured optional
tool costs the feature, never the chat. The framing text telling the model to name
its sources and never mix an external figure into a computed one is a **hint,
not a control** — the same standing as `KNOWLEDGE_FRAMING`, and it is written
knowing that. The citations are what let a reader check.

**`allowed_domains` is the strongest guardrail available and is deliberately
not set.** Restricting searches to vetted sources would end "a blog said 30%",
but it is the wrong control for holidays and local events, which is most of
what this is for. It belongs on the benchmarks path, where an external NUMBER
is the point.

**The citation claim above was overstated, and the reason was checked rather
than guessed.** Two recommendation runs performed seven searches between them
and produced ZERO citations, which undercut the provenance argument the switch
was made on. The docs settle part of it: *"Citations are always enabled for web
search"*, so dynamic filtering does not suppress them and the theory that it did
was wrong. What the docs also say is that when a search runs through dynamic
filtering the nested `server_tool_use` and `web_search_tool_result` pairs arrive
INSIDE the code execution result — and `searchErrors()` walked nested blocks
while `extractSources()` read only the top level. The same response, read two
different ways, in one file.

The likeliest remaining explanation is mundane and not a defect: the engine
searched for context, wrote its analysis from warehouse figures, and quoted
nothing — in which case zero citations is correct. `consultedPages()` now
records what the search RETURNED regardless, because "we read these and quoted
none of them" is a different and far more useful message than silence, and it
is what will distinguish the two on the next run.

**Three things about the server-side tool that are not obvious:**

- A failed search returns **HTTP 200** with an error object where the results
  should be. From outside it is identical to a search that found nothing, so
  `searchErrors()` pulls it out and logs it. An empty result list is *not* an
  error.
- The turn can stop with **`stop_reason: 'pause_turn'`**, resumed by sending the
  assistant message back unchanged. That is not a tool round and has its own
  counter. The old loop only handled `tool_use` and would have dropped it.
- Assistant content must be pushed back **unchanged**: search results carry
  `encrypted_content` the API decrypts to restore them, and rebuilding the array
  fails with a 400. Conversation *history* across requests is plain text, so
  search results do not survive between questions — lossy, but valid.

**Supplier bills are reachable now.** `query_supplier_bills` answers "$26,034 on
marketing -- on what?" from the bills beneath a P&L account. Its coverage
percentage is COMPUTED, in `coverageByAccount()`, and returned with every
response rather than left to the model to remember: a list of four suppliers
totalling $6,800 presented as the breakdown of a $26,034 account is a true list
and a wrong answer, and nothing else in the reply tells the reader which they
are looking at. Under 80% it says so; over 100% it names credit notes as the
reason and calls the figure overstated.

**Not yet built:** the `benchmarks` table. An external figure worth comparing
ourselves against should be a warehouse row confirmed by a person — source, url,
published date, review date — the same shape as `revel_venue_keys` and the Xero
tenant mapping, and reached through a query tool. A blog post found
mid-conversation is the least trustworthy input in the system; live search is
for discovery and qualitative context, and a searched number should never be an
operand in a comparison the model computes itself.

## Security model — three dimensions (every door checks all three)

- **WHO** (venue): Row-Level Security at the DB. Users belong to venue(s) + role via a `user_venue_roles` table; each sees only their own venue. HQ sees all.
- **WHAT** (sensitivity): payroll is walled off. Strongest protection = **don't ingest personal pay** (rates/bank/NRIC). Any aggregate payroll cost → finance/owner role only, in a separate table. Managers see labour % , never individual pay. Payroll query tools only exist for the finance/owner role.
- **WHERE** (channel): Telegram is locked to an HQ-managed **allowlist of verified phone numbers** (user taps "Share my number"). Telegram bot chats are NOT end-to-end encrypted → personal/payroll data NEVER goes over Telegram; web app only.

**Secrets:** static keys → Railway sealed vars. n8n integration creds → n8n encrypted store. Xero/per-client OAuth tokens (they rotate) → encrypted in Supabase, master key in Railway. Never in code, never in git.

## The Insight & Recommendation Engine (core product)

- Two modes: **reactive** (leader asks → Opus answers) and **proactive** (scheduled per-venue suggestions pushed unprompted).
- **Benchmarking across venues** is the edge (one warehouse enables it), e.g. "your food cost 32% vs sister venue 28%."
- **Charts:** the engine emits a chart *spec* filled with real warehouse data; the web app renders it live, Telegram gets a rendered **PNG**. Charts are always from real queried data.
- **Model tiering:** Opus for deep reasoning/suggestions; a faster/cheaper model for routine lookups & routing.

### The proactive half, built 23 Aug 2026

Until now the engine only ever answered questions somebody thought to ask, and
`recommendation` — the Opus/xhigh purpose in `model-policy.ts` — had never been
called once. A venue leader who does not know to ask why their beverage margin
is drifting never finds out, which is the whole difference between a dashboard
and an advisor.

**The failure mode is not a wrong recommendation, it is a boring one.** A wrong
one gets argued with. Three obvious observations every Monday — "covers were
down on Tuesday", "food cost rose slightly" — teach a manager this thing has
nothing to tell them, and they stop reading inside a month. Four decisions all
point at that:

- **Weekly, not nightly.** A Tuesday dip is a Tuesday. Only a quiet *week* is
  news, and the week is the unit an operator already thinks in.
  `lastCompleteWeek()` always returns a full Monday–Sunday: reviewing "the last
  seven days" on a Wednesday compares four trading days against seven and
  reports a collapse in covers every single time.
- **Permission to say nothing.** An empty result is VALID and is reported as a
  quiet week, not a failure. An engine that always has something to say is one
  nobody believes, and a cap of three forces a ranking decision instead of a
  list whose best item is seventh.
- **Repeats are suppressed on the SUBJECT, not the sentence.** `fingerprint()`
  strips numbers deliberately: "margin down 4 points" and "margin down 6 points"
  are the same advice with a refreshed figure, and a fingerprint including the
  number would say it again next week. The brief also lists what was already
  said — that half is a hint, `suppressRepeats()` is the control.
- **Evidence is stored with the conclusion.** In a chat the user watches the
  reasoning happen; here nobody is watching. What is stored is the QUERIES, not
  the rows they returned — re-runnable rather than reproduced, and the
  difference is stated rather than glossed.

**Cross-venue comparison is comparative-only, and that is enforced in code.**
The analysis runs UNSCOPED, because a single-venue scope makes benchmarking
impossible — the tool layer refuses every comparison. So the guard moved to the
output: `namesOtherVenues()` withholds any recommendation naming another venue
or its legal entity, before anything is written. "Your food cost is four points
above the group average" ships; "Fat Prince runs 28%" does not. It matches
NAMES, so "the venue on Craig Road" would pass — a narrower guarantee than RLS,
and every withholding is counted on the run so a brief being ignored is visible.

This implements the resolution CLAUDE.md guesses at above and does not settle
it: **whether a restaurant manager sees another venue's raw figures is still
Khai's decision.** Comparative-only is the safe direction to be wrong in, since
loosening it later is a config change and a figure already shown cannot be
withdrawn.

**Two passes, because prose and rows are different jobs.** Opus writes the
analysis naturally with the full tool set; a cheap Sonnet call with a forced
tool splits it into records. Asking the analyst to end with JSON was the
alternative, and it is the pattern the post classifier already rejected.

**Status and rating are separate columns on purpose.** "I did it" and "this was
worth reading" are different facts — advice can be acted on and turn out wrong.
Collapsing them would make the only measure of whether this feature works
unreadable.

## Data model (starting sketch)

- `venues` (id, name, ...)
- `profiles` / users (linked to Supabase auth)
- `user_venue_roles` (user_id, venue_id, role)  ← powers all access
- `revel_venue_keys` (report_key → venue_id)  ← filename lookup
- `product_mix` (venue_id, business_date, row_type, class, name, sku, category, subcategory, qty, sales, pct_total, cogs)
- (later) `sales_daily`, `reservations`, `labour`, `procurement`, etc. — all carry `venue_id` + `business_date`
- Design so a `company_id` can be added ABOVE `venue_id` later (multi-tenant sell phase).

## Build order & current status

**Status: planning complete, nothing built yet. Starting Phase 0.**

- **Phase 0** (now): create accounts (Supabase, Anthropic API, GitHub); build backbone tables + RLS + first policy; seed test data & verify venue isolation; wire the Revel sample file end-to-end (parser → validate → upsert → query back under RLS); one Claude query tool answering a real question.
- **Phase 1**: automate Gmail delivery + watchdog; add Xero, StaffAny, SevenRooms, Zeemart one at a time.
- **Phase 2**: custom dashboards (per-venue + HQ).
- **Phase 3**: chatbot + Insight & Recommendation Engine + chart generation + Telegram.
- **Phase 4**: multi-tenant productization (PDPA, hard data isolation).

### Deferred: read-only SQL query tool

**Decided, not scheduled — belongs after the chatbot is settled, and gets its own piece of work.**

Every query tool today is a fixed-shape question with blanks to fill in. That means each new *shape* of question needs new code and a deploy — day-of-week analysis, category splits, and so on. The `group_by` dimension widens the menu, but it is still a menu, and eventually a question will fall outside it again.

The permanent answer is to let the model write SQL against the warehouse directly. This does **not** weaken the anti-hallucination rule: Postgres still does every calculation, so every number still comes from the database. The model would be choosing the *question*, never producing the *answer*. (Locking the questions down as well as the answers was an over-correction on my part, and it is what created the treadmill.)

Do not build it without all four guardrails, because the service-role key bypasses RLS:

1. **A separate read-only Postgres role** — no write, no DDL, no access to payroll tables.
2. **Venue scoping injected server-side**, never trusted to the generated SQL. Same hole `enforceVenueScope()` already had to plug for the existing tools.
3. **A statement timeout and a row cap**, so one bad query cannot lock the database for every venue.
4. **Every generated query logged**, so a wrong answer can be traced back to the SQL that produced it.

The honest trade-off: a tool I wrote is wrong the same way every time, so it gets found once and fixed forever. A query written fresh each time can be wrong a new way each time — harder to spot, harder to trust. That is the reason this is deferred rather than dropped.

### Labour: split BOH from FOH, and never store individual pay

Decided 19 Aug 2026. The split that matters is **back of house versus front of
house** — the individual means nothing for any question this product answers.

That is fortunate, because it means the useful figure is an aggregate and the
warehouse never needs a person's salary. Payroll bill lines are summed by
category **at ingest** and only the totals stored; the per-person lines are
discarded in memory.

**The role → BOH/FOH mapping belongs in a table, editable in the admin console**,
not in code. Role names change when the business changes and that must not need
a deploy. Same shape as `revel_venue_keys`, the social account mapping and the
Xero tenant mapping — all confirmed by a person, never guessed.

**An unmapped role is flagged, never defaulted.** The Revel venue-key rule
again. A "Head Barista" added next March that silently lands in "other" makes
BOH cost drift with no visible cause; an unmapped-roles warning on the admin page
is fixed in thirty seconds.

Two limits to check before trusting any split:

- **Salaried staff may not be rostered.** Head chef, sous, managers. If they are
  absent from StaffAny, an hours-based allocation misses precisely the people
  who cost most, and both sides come out wrong.
- **Hours are not cost.** A chef and a runner do not cost the same hour, so an
  hours-weighted split systematically understates BOH by an unknown amount. If
  StaffAny carries cost per shift it is a measurement; if it carries only hours
  it is an estimate and must be labelled one. The P&L's `Wages and Salaries`
  total is the reconciliation check either way.

**StaffAny is per-person data too.** Rosters carry names, so it is not
automatically safer than payroll bills. Ingest hours aggregated by venue, date
and role — never by individual.

## Open decisions (confirm with Khai, don't assume)

StaffAny API grant method · Revel report frequency · Revel venue-key mapping (Khai to gather one filename per venue) · user scale (managers only vs all staff) · exact StaffAny fields to ingest · Telegram allowlist owner · Supabase hosted vs self-hosted.

### Role model: access level and function are two different things

**Khai is mapping the roles and ranks. Do not change the schema until he has.**

`user_venue_roles.role` is currently `owner | finance | manager | staff`, and it
answers exactly one question: *what are you allowed to see*. Owners see every
venue, everyone else sees their own. Beyond that every user gets an identical
experience — one system prompt, one tool list.

The business has functions that this cannot express: kitchen, exec chef, ops,
events, marketing. **Function is orthogonal to seniority.** The clearest proof
is marketing, which needs sales for *all* venues but has no business in the P&L
or in payroll. That is not a rung on the owner→staff ladder, and adding
`marketing` to the enum would grant either too much or too little.

So there are three independent axes, which line up with the WHO/WHAT/WHERE
model already described above:

- **Scope** (WHO) — which venues: one · some · all
- **Function** (WHAT) — which data domains, and which questions matter
- **Channel** (WHERE) — web vs Telegram (already decided)

Function is also the better carrier for the sensitivity wall than seniority is.
An exec chef needs product mix, COGS and item performance and has no need of the
P&L; a manager is not *less trusted* than finance, they simply need different
things.

**The trap to avoid when this is built.** Implementing function as "which tools
we offer the model" is right for *relevance* and useless for *permission*.
Withholding a tool from the list is a hint, not a control — the model can name a
tool from conversation history, and the deferred read-only SQL tool would ignore
it entirely. It must be both: the tool list for relevance, and a server-side
domain check next to `enforceVenueScope()` for permission. This is BUILD_LOG 4.1
repeating itself if it is got wrong.

**The WHAT dimension is now enforced, built 26 Aug 2026.** `src/ai/data-domains.ts`
sits beside `venue-scope.ts` and answers what KIND of data a role may read, where
that one answers whose venue. `enforceDomainScope()` runs in `handleToolCall`
before anything else, so it is a control rather than a hint — the trap named
below, that withholding a tool from the model's list is defeated by the model
naming it from history or by the deferred SQL tool ignoring the list.

**The wall is around PAYROLL, not around finance.** A manager may read the P&L:
someone who cannot see cost of sales cannot run a kitchen, and the security
model guards payroll specifically. So `query_profit_and_loss` stays available
and its payroll LINES lose their amount, keeping `pct_of_income` — which is
exactly what "managers see labour %, never individual pay" says. The detector is
`isPayrollAccount()`, the same one that keeps personal pay out of the warehouse
at ingest.

**An unmapped tool defaults to `operations`, the least guarded domain.** A new
tool that quietly gained payroll access by being forgotten is the worst failure
available; one that is over-restricted merely does not work and somebody says
so.

**The recommendation engine is filtered on its OUTPUT, not its input**, for the
same reason as `namesOtherVenues()`: it runs as the system and must see the P&L
to say anything about margin. `sensitivityOf()` tags each recommendation and
`/api/recommendations` withholds what the reader's role may not see, counting
what it withheld. `mentionsPayrollAmounts()` looks for a payroll word within a
SENTENCE of a currency amount — so "labour is 44.8% of income" passes and
"staff costs $63,118" does not, which is the line the rule actually draws.

**Still open:** whether a restaurant manager sees other venues' figures.
Benchmarking across venues is stated above as the product edge ("your food cost
32% vs sister venue 28%"), while the security model says each venue sees only
its own. Both cannot be true as written. Likely resolution is a third thing —
own figures plus *comparative* figures (rank, group average, anonymised sister
venue) but never another venue's raw P&L. Not decided. There are no GMs today,
only restaurant managers.

## Working style — hard rules

- **Do not overcomplicate.** Try the simplest, most direct fix first. Exhaust the obvious before reaching for workarounds, CLI installs, or multi-step procedures.
- **When troubleshooting:** diagnose the root cause, propose the shortest path to fix it, then act. Do not send the user on a wild goose chase.
- **Khai is on Windows PC.** Keep platform-specific instructions Windows-friendly.

## Reference

Two companion documents exist (HTML): the visual **blueprint** (architecture, diagrams, security, roadmap) and the **Phase 0 checklist**. Ask Khai for them if useful.

**`docs/BUILD_LOG.md`** — defects hit during this build, their root causes, and whether each one will recur at every new customer. Read it before adding an ingestion path, a query tool, or anything that reads a paginated source; several of the bugs recorded there lost data silently and returned a confident wrong answer. Add to it when something breaks and the cause was not obvious.
