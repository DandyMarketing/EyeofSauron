# Build Log — defects, root causes, and what must not recur

Sauron is being built for The Dandy Collection first and sold to other F&B
operators after. This file exists so the second customer does not pay for the
first customer's lessons.

**How to use it.** Every entry ends with a *Recurs?* line. That is the only
field that matters commercially:

- **Every customer** — this will happen again on every deployment. It must
  become a test, a guard in code, or a step in the onboarding checklist. A note
  in this file is not sufficient.
- **Per integration** — happens whenever that specific source is connected.
  Belongs in that integration's setup notes.
- **One-off** — genuinely specific to this build. Recorded for context only.

Add to this file when something breaks and the cause was not obvious. Do not
record routine work here.

---

## The pattern that matters most: silent data loss

Four separate incidents (1.1–1.4) shared one signature, and it is the most
dangerous failure mode this product has:

> **The system returned a confident, plausible answer built on incomplete data,
> and raised no error.**

Nothing crashed. No alert fired. The numbers looked reasonable. In one case
(1.1) it produced a report of "22 missing days" for Fat Prince that were not
missing at all — the read had silently truncated, and the absence was then
presented as a finding about the business.

For an internal tool that is embarrassing. For a paid product it is existential:
a customer makes a staffing or pricing decision on a number that was quietly
wrong, and neither they nor we can tell.

**The rule this produces:** any code that reads a bounded API or a paginated
endpoint must assert that it read everything, not assume it. If a limit exists,
the code must either page past it or fail loudly on hitting it. Never both
silently truncate and return.

---

## 1. Silent data loss in ingestion

### 1.1 Paginated read silently truncated at 1,000 rows
**Symptom.** A covers report showed 22 missing days for Fat Prince. The days
existed; 646 rows had been dropped.
**Root cause.** PostgREST caps a response at 1,000 rows by default. The query
returned successfully with exactly 1,000 rows and the code treated that as the
complete set.
**Fix.** Explicit paging loop, reading in 1,000-row pages until a short page
returns. See `pagedSelect()` in `src/ai/charts.ts` and `getCovers()` in
`src/lib/covers.ts`.
**Recurs?** **Every customer.** This is a property of the database layer, not of
any one venue. Every new read path is a fresh chance to reintroduce it.

### 1.2 API result ceiling returned an error instead of a page
**Symptom.** HTTP 400 fetching twelve months of SevenRooms reservations.
**Root cause.** SevenRooms enforces a hard 4,000-result ceiling per query and
rejects the request rather than truncating.
**Fix.** Fetch in 28-day windows, halving the window and recursing when the cap
is hit. See `fetchRangeSplitting()` in `src/ingest/sevenrooms.ts`.
**Recurs?** **Per integration** for SevenRooms — but the *class* of problem
(undocumented hard ceilings) applies to every API we connect. Assume one exists
until proven otherwise.

### 1.3 Offset pagination duplicated rows against live data
**Symptom.** 31 duplicate reservation IDs at Neon Pigeon, 1 at Fat Prince.
**Root cause.** Cursor is an integer offset. New bookings arriving mid-fetch
shift rows across page boundaries, so the same record is read twice.
**Fix.** Deduplicate by source ID into a Map before upsert, and count the
duplicates rather than hiding them.
**Recurs?** **Every customer**, for any offset-paginated source read against
live data. Ingesting during service makes it certain rather than likely.

### 1.4 Failed batches lost without an error
**Symptom.** Two batches of 500 rows never landed. Nothing reported a failure.
**Root cause.** Transient connection timeouts on upsert were not retried and
not surfaced.
**Fix.** Four attempts with 1s/2s/4s backoff, restricted to transient network
errors so genuine data errors still fail fast.
**Recurs?** **Every customer.** Network flakiness is universal.

---

## 2. Data that is valid but wrong

### 2.1 Implausible year passed date validation
**Symptom.** A row dated `2925-12-30`.
**Root cause.** A Monday.com item was literally named "2925-12-30 Tuesday". The
parser checked the date was *syntactically valid* — which `2925-12-30` is — and
accepted it.
**Fix.** Plausibility range on the year (2015 .. current year + 1); outside it,
fall back to the item's `created_at`. See `validOrNull()` in
`src/ingest/monday.ts`.
**Recurs?** **Every customer** that hand-types dates anywhere in its stack.
Syntactic validity is not correctness — the general rule is that any
hand-entered field needs a plausibility bound, not just a format check.

### 2.2 Venue-specific vocabulary assumed to be standard
**Symptom.** Fat Prince meal-period splits were nonsense — roughly $20/head at
lunch and $212/head at dinner.
**Root cause.** The code assumed shifts are named `LUNCH` and `DINNER`. Fat
Prince uses `DAY` and `LEGACY`.
**Fix.** `normaliseShift()` maps known aliases and falls back to arrival hour.
Verified against Revel's own hour-to-meal-period labels before trusting it,
which returned a sane $44 lunch / $98 dinner.
**Recurs?** **Every customer, differently.** This is the archetypal onboarding
defect: every operator names things their own way. Never assume a label set —
enumerate the distinct values from the customer's own data during setup, and
have a human confirm the mapping.

**Process note:** the fix was initially proposed on reasoning alone. Khai asked
whether it had been reconciled against Revel — it had not. The cross-check is
what made the mapping trustworthy. Cross-validate a mapping against an
independent source before shipping it.

### 2.3 Ratio built from mismatched date ranges
**Symptom.** Spend per cover of ~$17 and average parties of 17 people.
**Root cause.** Covers were counted across the whole requested range while
revenue covered only the 4–5 days that had POS data. Numerator and denominator
were measured over different periods.
**Fix.** Count covers only over the dates that also have sales.
**Recurs?** **Every customer.** Feeds arrive at different times and with
different lags — Revel lands overnight, SevenRooms hourly — so any ratio
crossing two sources is exposed to this. Every cross-source ratio must state
which date basis it used.

---

### 2.4 An accounting convention assumed instead of asked
**Symptom.** A figure that was already correct was "fixed" into a wrong one,
and the wrong finding reached a report shared with the finance department.
**Root cause.** `daily_operations.net_sales` holds Revel's "Total Sales" —
net of discounts, **inclusive** of the 10% service charge. Having established
that (correctly, and to the cent: `Total Sales = (gross − discounts) × 1.10`),
I applied the usual F&B convention, in which net sales *excludes* service
charge, concluded the figure was ~10% overstated, and rewrote it as gross less
discounts.

The business uses the opposite convention:

    Gross Sales = food + beverage + service charge
    Net Sales   = gross sales − discounts
    Cost basis  = food + beverage only

Under that definition the stored column was exactly right and needed nothing.
The change made every net sales figure Sauron reported ~10% too low.
**How it was caught.** Khai stated the three definitions in one sentence.
Tested against five real days spanning three venues and three years, they
matched the stored column to the cent on all five.
**Fix.** Reverted. `src/lib/sales.ts` now writes down all three definitions
with the identity that proves them, and the tests carry the five days, so
changing this means disproving real data first.
**The distinction that matters.** The *observation* — that `net_sales` carries
service charge — was right. The *inference* — that it was therefore mislabelled
— was not, and it was never checked against anyone who knew. The arithmetic
supported both readings equally well; that is exactly why it felt safe.
**Recurs?** **Every customer.** *An accounting term is a house convention, not
a standard.* "Gross sales", "net sales", "covers" and "average check" all vary
by operator, and the data will not tell you which is meant — both readings fit.
Ask, write the answer next to the code, and pin it with real days. Xero makes
this sharper, not safer: it has its own "Revenue", and service charge and tips
sit in their own accounts again.

---

### 2.5 A lock that protected the wrong number
**Symptom.** Five Fat Prince days in August 2026 disagreed with Revel. One was
reported to the finance department as **$1,271 of missing trade**. The venue had
in fact corrected the Monday board days earlier, and every one of the five
reconciled to the cent on the live board.
**Root cause.** A day was locked the moment the board first matched Revel
exactly. After that, `src/ingest/monday.ts` rejected any incoming change, raised
a `post_lock_change` alert and moved on — so the corrected figures were never
written. The lock was built to stop a settled day being tampered with; what it
actually did was freeze whatever we held at one arbitrary instant and make the
venue's own corrections unreachable. Permanently: nothing in the system could
ever update that row again.
**Why it read as the venue's fault.** The alert says the two systems now hold
different figures, which is true and says nothing about which one is right. We
had it backwards for weeks — the board was correct and we were refusing it. The
admin page even described the change as "rejected", framing a correction as an
intrusion.
**Fix.** The gate is now the accounting close, not a match: figures are final
from the **15th of the month following the trading month** (Khai's rule).
Before close a correction flows straight through; after close it is genuinely an
event and still alerts. A closed month with *no* row is still ingested — filling
a gap is not the same as changing a settled figure. `src/lib/accounting-period.ts`
holds the rule and its one tunable constant.
**The other half: alerting before the answer could exist.** Finance does not
reconcile daily and does not work weekends, so Friday's sales are untouched
until Monday. Comparing Friday against Revel on Saturday disagrees with work
nobody has started — and every one of those days raised an alert. True, and
meaningless. A mismatch now only becomes a finding once **two working days**
have passed (`isSettled`), which covers a weekend with room to spare: Friday
settles on Tuesday, Monday on Wednesday.
**Recurs?** **Every customer.** Three rules worth carrying:
*A lock needs a reason to end.* One that only ever closes will eventually hold
something wrong, and the longer it holds the more confident the wrong number
looks. Tie it to a business event — a close, an approval, a period end — never
to "the data agreed once".
*Ask which side is authoritative before building the alert.* We spent real
effort analysing discrepancies that existed only because we refused the answer.
*Never check faster than the process being checked.* An alert that can fire
before the work is done is noise by construction, and noise is not neutral —
it buries the real findings among days that will resolve themselves. Ask what
the human turnaround is, in working days, before writing the comparison.

---

### 2.6 A report layout merged two accounts, and the reconciliation gate could not see it

**Symptom.** None, for a year. Neon Pigeon's stored P&L carried `COGS - Beverages`
at 13,079.52 every month and no `COGS - Alcohol` line at all. Xero's own report
for the same month showed 11,246.00 and 1,833.52 — two accounts, both Direct
Costs, both with their own code. Every beverage-cost figure the system had ever
produced for that venue was a blend of two accounts.

**Cause.** `Reports/ProfitAndLoss` takes a `standardLayout` parameter and we
passed neither value. The default returns the *organisation's custom layout*,
and that layout merges the two accounts into one line. `standardLayout=true`
returns the accounts. Proven by asking all three ways in one probe rather than
by reading the documentation.

**Why nothing caught it.** `reconcileSections()` is the gate CLAUDE.md requires
before a figure is trusted: detail lines must sum to the total the report
states. It passed, every month, correctly. Total Cost of Sales is 45,166.87
under every variant — **a merge inside a section preserves the section total.**

That is the lesson, and it generalises past this bug: *the reconciliation gate
proves the total and never the composition.* Anything that redistributes value
within a section is invisible to it by construction. A second check — account
count, or account names against a known set — would be a different question and
would have caught this one.

**Two further things the fix needed.**

A warehouse must ask for **accounts, not a presentation**. Any grouping can be
rebuilt from accounts; a merged line can never be un-merged. The custom layout's
own groupings are the cost of this, and `account_map` is where they belong.

And switching layout required a **delete the ingest did not have**. An upsert
cannot remove a line that has stopped existing, and changing layout makes
several stop at once. `Total Staff Costs` would have remained in
`profit_and_loss` forever: never updated, never obviously wrong, a summary row
with a real figure carrying a grouping that no longer exists — which
`query_profit_and_loss` would have happily summed. Rows are now deleted per
period where the current report did not write them, keyed on `fetched_at`
rather than on a diff of names, because the question is not which names went
but which rows this run did not write.

**Recurs at every customer.** Any organisation with a custom report layout in
Xero has this, and the symptom is a plausible number rather than an error.

---

### 2.7 "Cannot be measured" read as "missing", and meant the opposite

**Symptom.** `query_supplier_bills` reported four Neon Pigeon accounts holding
$22,641 of June bills as coverage that could not be measured — which a reader
takes as cost we failed to capture.

**Cause.** Two of the four were 620 Prepayments and 730 Renovation: a Current
Asset and a Fixed Asset. That spend is *correctly* absent from a profit and
loss. Nothing was missing; the caveat was describing a normal accounting fact
in the vocabulary of a fault.

**Fix.** The caveat now says a missing P&L line most likely means a
balance-sheet account and is not a gap, while naming the other possibility
rather than asserting one. A *zero* ledger line is now a separate message
again: zero means the account was reported and came to nothing, so the bills
are in the wrong period or the account nets off — a different problem entirely
from not being on the report.

**The general shape.** A caveat is a sentence a person acts on. One that
describes a correct state in the language of an error costs exactly as much
attention as a real finding, and spends it on nothing.

---

## 3. Analysis that misleads

### 3.1 Partial buckets read as a collapse
**Symptom.** A trend reported −95.1% when the real movement was +22%.
**Root cause.** A range ending today leaves a stub final month. Two days of
August were compared against full months.
**Fix.** Flag `partial_first` / `partial_last` and exclude those buckets from
trend maths; tell the model explicitly not to describe the stub as a decline.
**Recurs?** **Every customer.** Any time-bucketed chart with an open final
period has this.

### 3.2 A closed day plotted as a catastrophic trading day
**Symptom.** Firangi Superstar's Sundays appeared as £0 trading days.
**Root cause.** Revel delivers a report for closed days with every figure at
zero. Nothing distinguished "shut" from "open and sold nothing".
**Fix.** `isClosedDay()` — zero gross *and* zero transactions means closed.
Plotted as a gap, excluded from averages, counted and reported separately.
**Recurs?** **Every customer.** Opening hours differ per venue and change over
time; this must never be hardcoded per site.

### 3.3 An unanswerable question answered anyway
**Symptom.** Asked which weekdays trade badly, the system produced a 180-point
daily line chart — unreadable, and incapable of answering the question.
**Root cause.** `create_chart` supported only day / week / month buckets. With
no way to group by weekday, the model chose the nearest available shape, which
*looked* like an answer.
**Fix.** Added `day_of_week` granularity, averaging over trading days.
**Recurs?** **Every customer**, and this is the important architectural one.

The deeper cause was a design error: the anti-hallucination rule requires that
*every number comes from the database*, and it was implemented as *the model may
only choose from a fixed menu of questions*. Those are not the same constraint.
Locking down the questions as well as the answers created a treadmill where each
new shape of question needs new code and a deploy — and worse, when a question
fell outside the menu the model's only remaining option was to estimate from raw
rows, which is the exact behaviour the restriction existed to prevent.

**Being too strict increased the hallucination risk rather than reducing it.**
The permanent fix is the read-only SQL tool recorded in `CLAUDE.md` — Postgres
still performs every calculation, so the model chooses the *question* and never
produces the *answer*.

---

## 4. Security

### 4.1 Venue isolation was not enforced anywhere
**Symptom.** Found during review, not in use.
**Root cause.** Row-Level Security protects the database, but the application
connects with the service-role key, which **bypasses RLS entirely**. Four query
tools treated an omitted venue parameter as "all venues".
**Fix.** `enforceVenueScope()` and `scopeVenues()` in
`src/ai/tool-handlers.ts` apply the user's permitted venue list in application
code on every tool call.
**Recurs?** **Every customer, and it gets worse with scale.** Today the blast
radius is one venue seeing another's numbers inside one company. Under the
multi-tenant plan it becomes one *company* seeing another's. This is the defect
class that ends the business, and it is invisible until someone looks.

**Standing rule:** RLS is not the isolation boundary while the service-role key
is in use. Anything reaching the warehouse on behalf of a user must have venue
(and later company) scope applied server-side, in code, and must never trust a
scope supplied by the model or the client. Any future read-only SQL tool
inherits this requirement in full.

### 4.2 Venue scope was enforced on tools but not on the system prompt
**Symptom.** Found during review, not in use. Every venue's `venue_notes` were
written into every user's system prompt.
**Root cause.** 4.1 was fixed at the tool layer. The notes query was a second,
separate path to the warehouse — unfiltered, on the service-role key — and it
appended its results one line below the text telling the user which venues they
were limited to. The fix for 4.1 did not generalise to it because nobody
enumerated the other paths.
**Fix.** `scopeNotes()` in `src/ai/knowledge.ts`, applied in code, with tests
covering the empty-grant case.
**Recurs?** **Every customer, and it is the lesson rather than the bug.** A
security fix applied at one call site is not a security fix. When a boundary is
established, enumerate every path that crosses it — tools, prompt assembly,
admin endpoints, exports, and later the read-only SQL tool — and check each
one. Notes made this worse than a tool leak in two ways: they are free text, so
the leaked content is unbounded, and they were injected unconditionally rather
than only when the model chose to query.

### 4.3 An empty venue grant read as unrestricted access
**Symptom.** Found during review. A user with no rows in `user_venue_roles`
could see every venue.
**Root cause.** `handleToolCall()` guarded on
`venueFilter && venueFilter.length > 0`, so an empty array skipped
`enforceVenueScope()` entirely and the allow-list was never stamped. `undefined`
(an owner, who may see everything) and `[]` (a caller holding nothing) were
treated identically while meaning opposite things.
**Fix.** Guard on `venueFilter` alone; `enforceVenueScope()` already handled the
empty case correctly.
**Recurs?** **Every customer.** The reachable path is revocation — removing a
user's roles emptied their grants, which widened their access instead of closing
it. Any permission check that treats "no permissions" as a falsy value has this
shape. Test the empty case explicitly; it is the one nobody tries by hand.

---

### 4.4 Two tables had no row-level security, and one held revenue

**Symptom.** None from inside. Found by Supabase's own security advisor:
`rls_disabled_in_public` on `public.reconciliation_alerts` and
`public.ingestion_log`.

**Why it mattered.** The anon key is **public by design** — the web app fetches
it from `/api/config` so the browser can authenticate. RLS is the only thing
between that key and a table. `reconciliation_alerts` carries `monday_gross`,
`revel_gross` and `difference`: daily revenue, per venue, per day. Anyone who
could load the login page could read every venue's takings, and edit or delete
them. That is section 4.1 defeated at a level below the tools — not a manager
seeing a sister venue, but anybody at all seeing all of them.

`ingestion_log` holds no money and failed the other way: readable, and the
entire watchdog history **deletable** by a stranger. A watchdog whose record can
be erased is not a watchdog.

**Cause.** Every other table in the schema had RLS from creation. These two
arrived in migrations 004 and 008 without it, and nothing in the repo, the
tests, or a year of use asked the question. RLS is invisible when absent: the
app works identically either way, because the server uses the service role,
which bypasses RLS entirely.

**Also fixed alongside.** `handle_new_user()` was SECURITY DEFINER with a
mutable `search_path` *and* EXECUTE granted to public. Those two compound into
the textbook Postgres escalation: a caller who controls `search_path` can make
a definer function resolve a call to code of their own. DEFINER is correct here
— the trigger writes a profile for a user who does not exist yet — so the path
is pinned and execute revoked from public, anon and authenticated. A trigger
needs EXECUTE granted to nobody.

**Not fixed, deliberately.** `xero_connections` has RLS enabled with no policy,
which the advisor reports as information. No policy means it denies every
client while the service role still reads it — the correct state for a table of
encrypted OAuth tokens. Clearing the notice would be a regression.

**Recurs at every customer, and is the reason to automate it.** A table added
without RLS is silent, and the only thing that found it was a vendor's periodic
scan.

**Now automated, 3 Sep 2026.** Migration 035 adds `rls_audit()`, a service-role
function returning every ordinary table in `public` with its RLS state and
policy count. `classifyTables()` reads it, `npm run audit:rls` exits non-zero on
any exposure, and the result is rendered on the admin console beside the ingest
health.

**It reads the live catalogue, never the migrations directory**, which is the
only version worth having: an un-run migration has been a defect here more than
once, and a check on what we INTENDED would have passed on every one of those
days.

**The check turns on a distinction that is easy to collapse and ruinous either
way.** RLS OFF is a hole. RLS ON with no policy is a locked door, and
`xero_connections` is deliberately in that state. Faulting on deny-all would
make the card permanently red, which is the Firangi Sunday lesson for the
fourth time in this codebase; ignoring it would hide a table nobody meant to
seal. It is reported in muted text and never counted as a failure. There is no
allowlist of expected deny-all tables, because an allowlist on a security check
rots and a stale one is worse than none.

**Policies are counted but never used as the test.** A table can carry policies
with RLS never enabled, and they do nothing at all — so counting policies
instead of reading `relrowsecurity` would report exactly that table as the best
protected one on the page. There is a test for it.

**The function is SECURITY INVOKER and granted only to `service_role`.** Making
a catalogue reader run as its owner, in order to close a hole about visibility,
would be the wrong shape of fix. The catalogue is world-readable inside
Postgres but PostgREST does not expose `pg_class`, so this function is the only
route to it from a client and the grants are the whole of the control.

---

## 5. Presentation and delivery

Lower stakes, but each one made real data unusable or invisible.

| # | Symptom | Root cause | Recurs? |
|---|---|---|---|
| 5.1 | Intermittent blank reply bubbles | `max_tokens` 2048 exhausted mid-answer; the loop exited on `max_tokens` holding only tool-use blocks, so no text existed | Every customer |
| 5.2 | Markdown table columns shifted left | Empty interior cells filtered out, so remaining cells moved up a column | One-off |
| 5.3 | Charts rendered too small to read | `.chart-card` was a shrink-to-fit flex item with no `flex: 1; min-width: 0` | One-off |
| 5.4 | Unstyled white tooltip over the whole chart | SVG root `<title>` is rendered by browsers as a native tooltip; it also shadowed the per-point tooltips | Every customer |
| 5.5 | Bars offset from their own axis labels | Bars positioned by group width, labels by line-chart spacing. Invisible across 26 weekly points, obvious across 7 weekday bars | Every customer |

5.1 is the one to carry forward: an empty answer must never be possible. The
recovery path re-asks with tools withheld, and a plain-language fallback runs if
that also fails.

---

## 6. Process failures

### 6.1 Documentation drifted from reality
Revel ingestion was described as manual CLI-only when it had been running
nightly via Gmail → n8n → `POST /ingest/revel` for some time. The claim was
made confidently and was wrong.

`CLAUDE.md` still opens with "planning complete, nothing built yet" while three
feeds run in production.

**Recurs?** **Every customer.** Stale project documentation is the first thing a
new engineer — or a new AI session — reads and believes. Verify operational
claims against the running system before repeating them.

### 6.3 A deploy that only half-arrived
**Symptom.** "Where is this button?" — twice. A new control was in the repo, on
`main`, and served correctly by Railway, and still absent from the browser.
**Root cause.** No `Cache-Control` header on the static HTML. Browsers fall back
to heuristic caching off `Last-Modified` and can hold a page for hours.
**Why it wasted time.** The failure is *partial*, which makes it look like
anything but a cache. The server updates instantly while the page does not, so
the user sees new server-side messages appearing in response to buttons that do
not exist yet — last week's page talking to this week's API. Every explanation
except the right one fits.
**Fix.** The HTML shell now sends `no-cache, must-revalidate`; assets keep
default caching. Note the header must be set by rebuilding the Response — its
headers are immutable once constructed, so assigning to them silently does
nothing, which is its own small trap.
**Recurs?** **Every customer, and every deploy until fixed.** Two rules: *serve
the app shell with revalidation from the first deploy*, and when a change is
"definitely deployed" but invisible, **check what the browser actually holds
before debugging the code** — `curl` the deployed asset and diff it against the
repo. That is thirty seconds and rules out the whole class.

### 6.2 Deployment source diverged from the working branch
The app deployed from a feature branch while `main` sat 53 commits behind and
effectively empty. Work could be committed, pushed, and appear finished without
reaching the running system.

**Recurs?** **Every customer.** Whatever branch is deployed must be unambiguous
and written down.

---

## What must exist before customer #2

Ordered by how much damage the absence causes.

1. **An automated test suite. There is currently none.** Every fix above can
   silently regress and no one would know. The highest-value targets are the
   pure functions where the subtle bugs lived and which need no database:
   `isClosedDay`, `normaliseShift`, `coversVariance`, `autoGranularity`,
   `bucketOf` / weekday derivation, `validOrNull`, weekday averaging, and the
   partial-bucket flags. These are cheap to test and are exactly where being
   wrong is hardest to notice.
2. **Tenant isolation tests.** Section 4.1 must be provable, not asserted —
   a test that a user scoped to one venue cannot retrieve another's figures,
   through every tool, including any future SQL tool.
3. **A customer onboarding checklist.** Every *per-customer* item above:
   enumerate the actual shift names from their data, map venue keys, confirm
   trading days per venue, verify credential length after paste (see below),
   confirm which feeds are live.
4. ~~**A test that every table in `public` has RLS enabled.**~~ **Built 3 Sep
   2026** — migration 035, `npm run audit:rls`, and a card on the admin console.
   Section 4.4 has the detail. It stays on this list as an onboarding STEP
   rather than a build item: run it once against a new customer's schema before
   any of their data is loaded, because it is the only version of the check that
   runs before the exposure rather than after.
5. **Ingestion watchdogs per customer.** `src/scripts/ingestion-status.ts`
   exists for one company. Silence — a cron that stopped firing — looks
   identical to a quiet day, and is the failure mode most likely to go
   unnoticed across many tenants.

### Onboarding gotcha worth its own line

A 401 from SevenRooms was caused by credentials containing **newlines in the
middle** — 129 characters instead of 128, copied from a wrapped display in the
Railway UI. It presented as an authentication failure, which sends you looking
at permissions rather than at the string.

`cleanCredential()` now strips all whitespace and reports the length against the
expected one. **Any credential field in the customer-facing product should
validate length and character set at entry and say so plainly.** This will
happen at every single customer onboarding.
