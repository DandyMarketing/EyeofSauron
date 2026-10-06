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

**It did recur, repeatedly, and is now enforced rather than remembered.** On
6 Oct 2026 Firangi's cost panel withheld its food cost as "only 52% on bills"
when the bills explained 91%. The coverage check read September's bill lines in
one request, and every venue had more than 1,000 that month (Firangi 1,556, Fat
Prince 1,102, Neon Pigeon 1,001). An audit then found **88 reads** with no
bound at all, and a second form of the same bug: **`.limit(5000)`,
`.limit(10000)` and `.limit(2000)`**, which look like bounds and are not,
because the database returns 1,000 whatever is asked for. Live casualties
included:
- the chat's top sellers, ranked on about twelve days of a month;
- labour beyond about two months;
- the recommendation engine's fee check, which read half of last year;
- the Xero backfill's "what do we already hold";
- "resolved by a later success" on System Health.

The fix has three layers, because each catches what the others miss:
1. **`selectAll()`** (`src/lib/paged.ts`) reads every page, ordered by the
   unique `id` so pages cannot repeat or skip a row (1.3). It returns the same
   `{ data, error }` shape, so a call site changes by one wrap.
2. **`src/lib/paged.test.ts` reads the whole codebase.** Every read must be one
   row, a count, paged, a deliberate top-N of at most 500, or carry a
   `// row-cap: <why>` comment saying why it can never come close. Any `.limit()`
   of 1,000 or more fails outright. `selectAll` on a table without an `id` fails
   too. That one was caught in testing, where wrapping `school_calendar` would
   have broken the school-holiday tool.
3. **`rowCapFetch`**, on both database clients, logs `[row-cap] <table>` to
   Railway whenever an unpaged request comes back at exactly the cap. The test
   reads source text and a query built some way it does not recognise could get
   past it; the alarm watches what actually came back.

**Raising the cap was considered and rejected.** It is a Supabase setting, but
it moves the cliff rather than removing it, and the cap is also what stops one
bad query from pulling a whole table across the Tokyo link.

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

### 1.5 A permissions boundary that returns an empty success
**Symptom.** StaffAny's `shifts`, `shift-slots` and `timesheets` endpoints
returned **HTTP 200 with zero rows** for three separate complete weeks at a
group with seven configured sections and thirty-seven roles. The probe
concluded, in writing, that the weeks had probably not been rostered. Khai
could see those shifts on his screen.
**Root cause.** The requests named no `sectionIds`. **The API silently scopes
to the sections the caller belongs to**, and the token's user belongs to
exactly one — `The Dandy Collection`, the group section, which has no shifts in
it. Passing the six venue section ids explicitly turned three weeks of clean
green results into `403 insufficientPermission — You are not allowed to view
the timesheets for these sections: <six ids>. Please contact the respective
section's owner`.
**Fix.** Always name the sections. The probe now sends `sectionIds` on every
roster and timesheet call, reports the request form that actually returned
rows, and compares the caller's section memberships against the full section
list.
**Recurs?** **Every customer, and on any multi-tenant source.**

**This is section 1's pattern with a new cause.** Every other entry there is a
*pagination* limit that drops rows. This one is a *permissions* limit that
drops rows, and it is worse in one specific way: a truncated page still returns
something, so a total of zero at least looks odd. Here the correct answer for
the scope requested genuinely *was* zero, so the response was accurate,
successful, and useless.

**An org-level `owner` with thirty-seven permission scopes read nothing.**
`accessLevel` was `owner` and the scope list included `STAFF_VIEW`,
`TIMESHEET_EDIT_ALL` and `PAYROLL_VIEW`. Section membership is a **separate
axis** that those scopes do not satisfy, so every signal we would naturally
check said full access. That is the trap: the permission model has two
dimensions and only one of them is visible on the thing called "permissions".

**The rule this leaves.** On any source where the caller has a scope of its
own, an empty success is a fault until proven otherwise — and the way to prove
it is to **name the scope explicitly and see whether the answer changes from
silence to a refusal**. A 403 is a good outcome here. It is the only response
that told us the truth.

**What it would have cost unfixed.** The ingest would have run nightly, logged
success, and written zero labour rows for ever. `checkDataGaps` watches for
missing *days*, not for a source that consistently returns nothing, so the
watchdog would have been green too.

### 1.6 A line break typed into a discount reason rejected the whole day's report
**Symptom.** Neon Pigeon's operations report for **29 Sep 2026** would not
ingest. The error was `Quote Not Closed: the parsing is finished with an opening
quote at line 4` — and line 4 of the file is `Total,170,3723.00,...`, which has
no quote in it. Nothing was ingested for the day.
**Root cause.** Somebody had typed a discount reason over three lines in Revel.
It arrives in the CSV like this:

```
Dandy Family,5,65.50
"Josh
                      <- a blank line, INSIDE the quotes
Runaway",1,42.00
```

**The file is valid.** RFC 4180 explicitly permits a newline inside a quoted
field, Revel emits it correctly, and `csv-parse` handles it correctly. The
defect was ours: the operations report is a dozen little tables separated by
blank lines, and `splitSections()` split on blank lines **before** any CSV
parsing, so it knew nothing about quotes. It cut the `DISCOUNT REASON` table
after `"Josh` and handed the parser an unclosed quote. "Line 4" was line four
*of that section*, which is exactly why the number pointed at nothing.
**Fix.** `splitSections()` now scans character by character tracking quote
state, and only treats a line ending as a line ending when it is outside a
quoted field (`""` is an escaped quote and toggles nothing). The reason text is
then whitespace-collapsed by `label()` rather than preserved, because a newline
inside a cell terminates a markdown table and the line break carries no
information. `src/parsers/revel/operations.test.ts` is the regression — the
parser had no tests at all before this.
**Recurs?** **Every customer.** Any free-text field somebody can type a newline
into does this: a discount reason, a void reason, a product name, a modifier.

**It is in section 1 but it is the opposite failure, and that is the point.**
Every other entry here returned a confident answer on partial data. This one
refused the file outright, which is the *good* direction to fail in — the day
was visibly missing rather than quietly wrong. What it shares with the rest is
that **the error blamed the source**: the message said the file was malformed,
the file was fine, and an operator reading it would have gone back to Revel.

**The generalisable rule.** Never pre-split a CSV on anything before parsing it.
Line endings, commas and blank lines are all legal inside a quoted field, so any
code that chops the text up first has silently decided no customer will ever
type one. The same hazard applies to a product name with a comma in it, which
this parser gets right only because `csv-parse` does the splitting there.

### 1.7 NETS was parsed as a sub-type of House Account
**Symptom.** None. Found while verifying 1.6, because the payment rows were on
screen.
**Root cause.** The operations report carries **no indentation** — `American
Express` sits flush against `Credit` in the CSV — so which payment rows are a
method and which are a card brand underneath one has to come from a hardcoded
list, `TOP_LEVEL_PAYMENTS`. `NETS` was missing from it, so it inherited the
previous top-level row as its parent and was flagged `isSubType`. In Singapore
NETS is the most common debit rail; anything summing `!isSubType` would have
dropped it. It was $0.00 at Neon Pigeon that night, which is the only reason
nothing was wrong yet.
**Fix.** `NETS` added — the same file settles it, since the `TIPS` section lists
NETS alongside Cash, Credit and Custom Payment, all methods. More usefully,
`paymentsReconcile()` now checks the methods against the report's own stated
Grand Total, which is free and catches the *next* one: a method wrongly demoted
vanishes from the sum, a brand wrongly promoted double-counts, and both show up
as a mismatch. It returns `null` when there is no Grand Total row, because an
absent check and a passing check must not look the same.
**Recurs?** **Every customer.** A hardcoded list of payment methods is wrong for
any venue using one that is not on it, and the next one will arrive the same
way — silently, as a plausible number.

**And the guard was then not wired in.** `paymentsReconcile()` was written,
tested and called by nothing — the same defect one layer up, and the one this
log keeps recording. It now runs on the operations ingest and **warns without
blocking**: a mismatch means the method list does not recognise something, not
that the figures are wrong, and refusing the day would throw away real sales
over a classification question. A test asserts both that it is called and that
the block it sits in contains no `continue`.

### 1.8 The upload page reported each result against the wrong file
**Symptom.** None visible, which is why it survived. Found while adding the
warning above.
**Root cause.** `/ingest/revel` returns a `results` array, and the upload page
read `results[j]` onto `files[j]`. The server does not emit results in the order
the files were sent: it groups the batch by venue and business date, emits the
product mix before the operations report, handles hourly sales in a separate
pass afterwards, and pushes any parse failure ahead of all of it. Upload an
operations report and a product mix together and the two statuses swap.
**Why it was invisible.** When every file succeeds, every row says "Ingested"
and a swap cannot be seen. It only shows when something fails — which is the
one moment the label matters, and it then sends you to inspect a file that is
perfectly fine.
**Fix.** The row carries `data-fname` and results are matched by filename. A
test asserts the match and fails if the positional index returns.
**Recurs?** **Every customer.** Any UI that zips a response array against a
request array has assumed an ordering the server never promised.

**The page also discarded every `detail` the server computed** — the parse
error, the reconciliation difference, the row count — and showed a one-word
status with nothing to act on. That is the same complaint as 5.11 (errors that
were accurate and unreadable), except here the explanation was already being
generated and thrown away at the last step.

**This is 1.6 in a different medium.** Both produce an accurate-looking message
pointing at the wrong thing — "line 4" that was line four of a section, and a
failure attributed to the file above it. A wrong pointer is worse than no
pointer, because it is acted on.

### 1.9 A correct figure "fixed" into a wrong one, for the second time
**What I claimed.** Asked for Neon Pigeon's 29 Sep 2026 sales, Sauron answered
net $3,759.26 against gross $3,639.00. I wrote in this log: *"Net larger than
gross is not a thing that happens in a restaurant."* It is, here. I redefined
gross sales as net plus discounts, shipped it, and reported gross as $3,980.76
— **9% too high** — in three commits with tests pinning the wrong number.

**The business's definitions, settled.** Khai, 4 Oct 2026: *"Gross is supposed
to be just food + bev without svc charge"*, and then the thing that actually
closed it — *"we deduced it before to match the monday.com one right"*:

    Gross Sales = food + beverage, service charge EXCLUDED
    Net Sales   = (gross - discounts) + the 10% service charge
    Cost basis  = food + beverage, i.e. gross sales

The 10% is levied **after** the discounts come off, so it enters net and was
never in gross. **Net exceeds gross on every trading day and that is correct.**

**The proof was running in production the whole time.** `reconcileMondayVsRevel`
compares the Monday board's food + beverage against Revel's `gross_sales` column
with a tolerance of **exactly zero**, and it passes. Had that column carried
service charge, every day at every venue would have failed by about 10%.
`deriveTotals()` in the Monday ingest computes it the same way: `gross = food +
bev`, `net = gross - discounts + service charge`. Two independent sources,
agreeing to the cent, in code, for months.

**What I actually got wrong, and it was not the arithmetic.** The identity
`net = (gross - discounts) x 1.10` is in `sales.ts`, verified against five real
days across three venues and three years. It is true under BOTH readings,
because the `gross` in it means the COLUMN — food and beverage. The prose beside
it said "Gross Sales = food + beverage + service charge". **The file contained
the evidence and a conclusion the evidence does not support**, and I took the
conclusion.

**This is BUILD_LOG 2.4 again, in the opposite direction, by someone who had
read 2.4.** That entry records the same term being mis-read toward the textbook
convention, the same confident "fix", and the same test suite re-pinned to the
wrong answer. Its closing line is *"An accounting term is a house convention,
not a standard... Ask."* I did not ask. I inferred from a plausibility argument
— net cannot exceed gross — which is exactly the kind of reasoning 2.4 warns
is worthless here, because both readings fit the arithmetic.

**Fix.** `grossSalesOf()` returns food + beverage and no longer derives anything
from net sales. The prompt, both tool descriptions and `FIGURE_DEFINITIONS` say
so, and all of them now state the consequence out loud — *net is larger than
gross, that is correct, never reconcile it* — because an unexplained oddity is
what invites the next fix. The five real days assert `net > gross` directly, so
the next person has to break them.
**Recurs?** **Every customer**, and this is now the second instance. A house
convention cannot be derived from the data, because the data fits both readings.

**The rule, sharper than 2.4 could make it.** *When a figure looks impossible,
the first move is to find the code that already reconciles it against another
source.* `reconcileMondayVsRevel` would have settled this in two minutes, before
any of it shipped. A plausibility argument is not evidence; a zero-tolerance
reconciliation that has been passing in production is.

**What was genuinely a defect, and stays fixed.** `query_sales` had two paths
that disagreed — the date-range path used `src/lib/sales.ts` and the single-date
path spread the raw row — so asking about a day and asking about a one-day range
returned different figures for the same question. `salesFiguresOf()` builds the
block once and both paths spread it. That part was real and is unaffected.

**Settled again, 6 Oct 2026, the other way round.** Khai compared the dashboard
with Monday's NP Weekly Report and the gross figures differed. The cause is
Monday's own formula: `Gross Sales Exc. Sushi = Food + Bev + Delivery + Service
Charge`. For 28 Sep – 4 Oct that is $17,286 + $16,312 + $0 + $3,204.98 =
$36,803, against Sauron's $33,598. Net agreed to the dollar ($35,255). Khai's
decision: **keep gross as food + beverage** and say on the dashboard and in
`FIGURE_DEFINITIONS` that Monday's weekly report includes service charge. So
the daily board's food and bev columns, which Revel reconciles against, follow
the house definition, and the weekly report's "Gross Sales" label does not. A
reader comparing the two needs to be told, and both places now say it.

The same gap turned up at Fat Prince the same day ($48,241 against $43,885, of
which $4,283 was service charge and about $67 was the known 30 Sep board
difference). After that, Khai agreed to **rename the label**: the dashboard,
the chart label and the chat now say **"Food & beverage sales"**, and the
`gross_sales` field keeps its name in the code. One word meaning two figures in
two systems will be questioned every week, however good the footnote is.

### 1.10 A table drawn with spaces, in a code block
**Symptom.** The same answer's table arrived as fixed-width ASCII with a row of
dashes under the header, inside a code block.
**Root cause.** The system prompt said "write it as a markdown table; the app
renders it properly" and the renderer does support them — but the prompt never
said what one looks like, and never ruled out the ASCII alternative.
**Why it matters.** It looks correct in the model's output and on a desktop. It
is read on a phone between services, where fixed-width text cannot reflow: the
table overflows sideways and the reader scrolls a column at a time. The
WhatsApp image export bakes that in permanently.
**Fix.** The prompt now names the pipe form, the separator row, and forbids the
code-block version with the reason attached.
**Recurs?** **Every customer.** An instruction that describes the goal without
naming the form leaves the form to the model.

### 1.11 A report Gmail filed as spam, so n8n never saw it
**Symptom.** Fat Prince's Operations report for Monday 5 Oct 2026 never loaded.
System Health showed a data gap and nothing in the ingestion log: no failure,
because Sauron was never sent anything to fail on.
**Root cause.** Revel sends each report to two addresses, Khai@ and Reports@.
In Reports@, the mailbox n8n reads, Gmail filed the 3:00 am email as **Spam**.
n8n reads the inbox, so that night's run carried 8 of the 9 files, and the
missing one was exactly this one. In Khai@ the same email sat in the inbox with
the file attached.
**Why it was hard to see.** Every Revel email is near-identical ("See report(s)
in attachment" plus a file), so the spam filter judges each one on its own and
can catch any of them on any night. It looks random because it is. Two wrong
leads cost time on the way: Gmail threading (every night threads the same way
and the other nights loaded) and "Revel failed to send" (it had sent; the copy
had been read in the other mailbox).
**Fix.** "Not spam" on the email, and a Gmail filter in Reports@:
`from:noreply@revelsystems.com` → **Never send it to Spam**. Re-delivering the
file is harmless, because the operations report upserts on
`(venue_id, business_date)`.
**Next time a file is missing with no error logged**, check in this order: the
n8n run's item count for that night (it should be 9: three venues × three
reports), then **Spam in the mailbox n8n actually reads**, then the sender.
**Recurs?** **Every customer** whose reports arrive by email. The "never send
to Spam" filter belongs in onboarding, next to the venue-key mapping.

### 1.12 Every correction on the Monday board was skipped, hourly, for two months
**Symptom.** Neon Pigeon's July food cost read 301%. Chasing it showed that
months before Revel's daily files carry no food/drink split (a separate
defect, being fixed next), and comparing the two sources for August and
September turned up something worse. Fat Prince's food on the Monday board ran
up to 6% below Revel's, and on 17 Aug Sauron held **$1,744** of food against
**$6,468** on the board and in Revel. The board was right and matched Revel to
the cent on all but two days. Sauron was holding an old copy.
**Root cause.** The sync runs hourly and skips any day whose fingerprint
matches the stored one. The fingerprint was
`JSON.stringify(mealPeriods, Object.keys(mealPeriods).sort())`. An array as
`JSON.stringify`'s second argument is an **allow-list of property names applied
at every depth**, so the nested figures were filtered out and every day hashed
as `{"dinner":{},"lunch":{}}`. Whatever the board showed the first time Sauron
saw a day was kept. A correction only got through if a whole meal period was
added or removed. Fat Prince enters dinner in stages, so it was hit hardest.
The same hash drove the "changed after close" alert, so that could never fire
either.
**Why it was invisible.** 18 successful runs a day, `status = success`,
`row_count = 0`. A sync that has nothing to do and one that cannot see changes
log identically. The figures were plausible, just short, and the only thing
that exposed them was putting a second source beside them.
**Fix.** Whether a day changed is now decided by comparing the figures to the
cent (`figuresChanged`, the same rule the alert uses to describe a change), and
never by the stored hash. The hash is kept as a record and now covers every
figure. Open months update on the next run. Closed months (Jan–Aug at the time)
raise one "changed after close" alert per differing day and are not
overwritten. That turns the backlog into an audit, to be applied deliberately.
Tests use Fat Prince's real 16 Sep figures. A structural test fails if a
decision compares the stored hash again.
**Recurs?** **Every customer.** Two rules. *A change-detector must be tested
with a change*: this one was only ever exercised on unchanged data, where a
detector that sees nothing passes. And *an "unchanged, skipped" count of 100%
for weeks is a finding*, not a quiet week.

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

### 2.8 A 301% food cost: the sales side read one source, and history lives in another
**Symptom.** Neon Pigeon's July 2026 food cost read **301%** on the cost trend.
**Root cause.** Food cost is Xero's cost of sales over food sales for the same
month, and food sales came from Revel's class split (`sales_by_class`) and
nothing else. Revel's daily files began in late July (three July days carry a Revel split). Every earlier day's
food/drink split exists only on the Monday board (`meal_periods`), so it counted
as **$0**. Measured 6 Oct 2026 across all three venues: January to June had 0
days with a Revel split, July had 3, August and September every day. July
divided a full month of cost by three days of sales: Neon Pigeon $7,496 against
$69,486 on the board, about a ninth, and 301% instead of about 32%.
**Why it was invisible.** The rows existed. "No sales found" only fired when
there were no rows at all, and a row carrying $0 of food looks like a row. For
January to June the ratio came out null ("unavailable") rather than wrong, so
six months of history were simply missing, and missing looks like a gap
nobody filled. Only the one month with a little Revel data produced a number
loud enough to notice. The chat's `query_cost_ratios` had the same blind spot.
**Fix.** `classSplitOf` falls back to the board on any day Revel did not split,
and says which it used (`split_basis`). `sumClassSplits` counts days per source.
Every cost figure names the board days, and **any day that carried sales with
no split from either source withholds every percentage**: the cost is still
shown, the ratio is not. A cost over short sales reads high by exactly the
missing share. Tests use July's real figures.
**Found on the way:** comparing the two sources for August and September exposed
1.12, a sync that had been keeping stale board figures for two months. The
fallback is only sound because that was fixed first.
**Recurs?** **Every customer**, and especially at onboarding. A new operator's
history will almost always sit in a different system from their live feed. Any
figure that sums a field must also count the rows where the field was absent,
and a sum with absent rows must not be divided.

### 2.9 Food cost by name: two operating expenses, a deleted bill, and sushi
**Symptom.** The weekly panel put Neon Pigeon's food cost for 28 Sep – 4 Oct
2026 at **$6,609, 38.2%**. Monday's weekly report said **23.0%**.
**Root cause, four parts, found by listing every bill behind the figure:**

| | Amount | Should it count? |
|---|---|---|
| COGS - Food | $4,264.54 | yes |
| COGS - Sushi | $596.14 | separate line: sushi sales are not in Revel's food sales |
| Transportation - Sushi (operating expense) | $1,490.00 | no; matched on the word "sushi" |
| Toho bill **DELETED** in Xero, re-entered at $147.80 | $161.10 | no; counted twice |
| Kitchen expenses (operating expense) | $97.50 | no; matched on the word "kitchen" |

The weekly panel classified a bill line by its account **name** alone. The
monthly figure checked the section first, but the weekly path never got that
filter. `classifyCogs`' own comment said "the caller filters on section first",
and one caller didn't. The dashboard also never excluded VOIDED/DELETED bills,
although `query_supplier_bills` always had (`NON_SPEND_STATUSES`). That's the
same lesson as 4.2: a rule applied at one call site is not a rule.
**Fix.** `costBucket()` is the only rule: **cost-of-sales section first**, then
sushi (by business line or name) as its own bucket, then food or drink by name.
Every cost figure uses it: the weekly panel, its coverage, the monthly panel and
the chat's `query_food_beverage_cost`. Sushi is shown as an amount with no
percentage, because there is no sushi sales figure in Revel to divide by.
Operating expenses appear nowhere, by Khai's decision: "we are not calculating
profits yet". Voided and deleted bills are skipped in the figure and in its
coverage. The week now reads food $4,264.54, **24.7%**. What remains against
Monday's 23.0% is invoice timing (delivery date against bill date).
**Recurs?** **Every customer.** Their accounts will have names. Never classify
by name until the section says it is the kind of account the name is being
asked about. And when a figure looks wrong, **list the rows behind it**: this
one was four defects and one decision, and no amount of reasoning about the
total would have separated them.

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

### 3.4 An answerable question declared impossible, with an invented reason
**Symptom.** Asked on 3 Sep 2026 how many days ahead each booking came in, the
chat replied that we do not hold a reservation creation timestamp, and that
answering would need a booking-created field pulled through from SevenRooms
"which isn't ingested". It then offered to raise it with the vendor.
**Root cause.** Every part of that was false. `reservations.source_created_at`
has been on the table since migration 009, `src/ingest/sevenrooms.ts` has always
mapped SevenRooms' `created` onto it, and it is populated on **142,623 of
142,623 rows** going back to April 2022. What was actually missing is that
`query_reservations` selects eleven columns and this was not one of them.
**Fix.** Migration 036 `booking_lead_time()` plus `query_booking_lead_time`. An
aggregate rather than an extra column on the existing tool, because handing the
model 142,623 rows to subtract dates across is the arithmetic-in-the-model
failure the warehouse exists to prevent, and PostgREST caps a page at 1,000 rows
anyway.
**Recurs?** **Every customer, and at every new column.**

**This is 3.3's failure with the sign flipped, and it is the worse of the two.**
There, a question outside the menu produced a chart that looked like an answer.
Here, a question inside the data produced a confident denial that the data
exists. A wrong chart invites argument; "we don't have that" ends the
conversation, and the person who asked walks away believing something false
about their own system. Nobody re-asks a question they have been told is
impossible.

**The generalisable lesson: the tool layer defines what the model can know, and
an omitted column is indistinguishable from a column that does not exist.** The
model had no way to tell those apart and no reason to doubt itself — the
absence was total from where it was standing. So a `SELECT` list is not an
implementation detail, it is the boundary of the system's self-knowledge.

**A model that cannot find something must say it cannot find it.** The specific
harm here was not the gap, it was the *explanation* — a mechanism ("not
ingested"), a remedy ("would need a field pulling through") and an action
("worth raising"), none of which existed. Fluent, checkable, and wrong. The
tool description for `query_reservations` now states outright that lead time is
held and names the tool that returns it, because the correction has to live
where the model is looking.

### 3.5 A window's weekday mix read as a season
**Symptom.** Caught before shipping, on the first render of the cover forecast
(4 Oct 2026). The seasonal note said the coming days "ran 22% quieter" last
year, on a synthetic venue deliberately built to be 12% BUSIER in October.
**Root cause.** The next five nights were Monday to Thursday — Sunday was shut —
and they were averaged and compared with a twelve-week baseline that included
every Friday and Saturday. The measure was reading *which weekdays were in the
window*, not the season. On real data it would have announced a quiet spell
every time the next five days missed a weekend, and a seasonal turn every time
they caught one.
**Fix.** `seasonalLift()` divides each night by the average of ITS OWN weekday
and averages those ratios. A test now asserts a lift of exactly zero on a venue
with no seasonal change, for a window with no weekend and one with.

A second fault surfaced in the same measure once the first was fixed: five
nights at ordinary ±20% variation read a true 12% lift as 5%. Widening to three
weeks of last year fixed the noise — but only using the weeks AFTER the
equivalent date, because the week before sits inside the baseline and including
it compares the baseline with itself, pulling every lift toward zero. Measured
after: 11.7% against a true 12%.
**Recurs?** **Every customer, and in any comparison over a window shorter than
a week.** This is 3.1 in a different shape: 3.1 was a partial *month* compared
with whole ones; this is a partial *week* compared with whole ones. Weekday is
the largest single driver of covers in F&B, larger than month or season, so any
window that is not a whole number of weeks carries a weekday mix — and a mix
difference looks exactly like a trend. The dashboard's like-for-like
week-to-date (same weekday span, never against a whole week) exists for the
same reason. **Compare a night with nights of its own weekday, or compare whole
weeks. Nothing in between is safe.**

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

### 5.6 Every page was slow, and nothing in the code looked wrong

Reported as "a UI that is more responsive and loads faster" elsewhere. Nothing
was broken, no test failed, and no line of the front end was obviously at
fault — which is why it had survived since the first page was written. Three
separate causes, found by measuring rather than reading:

| Cause | Measured | Fix |
|---|---|---|
| **No compression anywhere.** No `Content-Encoding`, no middleware, never configured | admin.html went down the wire at 87,178 bytes against 23,731 gzipped; index.html 40,801 against 12,874 | `hono/compress` registered FIRST, so it wraps the static handler. 65–73% off every page |
| **The auth client came from esm.sh**, a third party, on the critical path of every page | 349 ms for a **531-byte** re-export shim — 302 ms of it TLS to a host we had never spoken to — which then pulled six more modules, ~181 KB across 7+ further requests, each discoverable only after the one before it arrived | Bundled into `public/vendor/supabase.js` and committed. One same-origin request, 60 KB gzipped, on the connection the HTML already opened |
| **The boot sequence was six serial round trips** on every page: `/api/config` → the client import → `getSession()` → `/terms-gate.js` → `/api/me` → the data | On briefing.html the briefing itself — the only slow request, a database read — was **sixth of six** | `Promise.all` where there was never a dependency, `<link rel="modulepreload">` so the client downloads during parse, and the page's own data fetch started as soon as there is a token |

**Recurs? Every customer, and worse at every one of them.** All three were
invisible from Singapore on an office connection and are not invisible on a
phone: TLS to a third party costs a round trip that scales with distance, and
an uncompressed 87 KB page is 87 KB of someone's data allowance. The product is
for operators between services, on a phone, which is the exact case none of
this was measured in.

**Two things worth carrying forward beyond the fix itself.**

*The modulepreload is doing the work, and it was verified rather than assumed.*
Measured from the browser's own Resource Timing: `/vendor/supabase.js` starts at
**23 ms**, initiated by the link element, while the script that asks for it does
not run until 26 ms. A dynamic `import()` is invisible to the preload scanner,
so without the link the download cannot begin until the whole document has
parsed.

*Parallelising a request can change its ANSWER, not just its timing.* The
briefing's data fetch now runs alongside the terms gate. If the gate has to
appear, that request was issued before the acceptance existed and the server
correctly refused it — so `enforceTerms()` was changed to report WHICH case it
was (`already` / `accepted` / `skipped`) and the page re-fetches when the answer
is not `already`. A parallelisation that silently serves a 403 page to
first-time users would have been a worse bug than the slowness.

And the usual one: `tsc` never looks inside an HTML file, so a brace dropped
while editing four boot sequences by hand would have produced a **blank page**
with the whole suite green. `src/frontend/pages.test.ts` now compiles every
page's inline script without running it, and carries a test proving it still
rejects broken code.

### 5.13 The dashboard got "slower a lot" in one afternoon, by being added to

Reported by Khai on 4 Oct 2026, hours after four features shipped to the
dashboard at once. No production timings existed, so the causes were measured
on a local Postgres 16 with production-sized data (142,896 reservations
against production's 142,623):

| Cause | Measured locally | Fix |
|---|---|---|
| **Two batches in sequence.** Retention, cost of sales, bills and the new forecast need only the DATE, but started only after the sales-and-covers batch finished — the serialisation 5.6 had already removed from the browser, rebuilt on the server | One full batch of waiting, every load, before the heaviest work began | Everything that needs only the date starts before the first `await`. A test asserts it by position in the source |
| **The forecast's history query and backtest** ran on every load, on the critical path | ~260 ms query; ~250 ms of CPU, during which Node answered **nobody** | Hourly cache, and an index: the backtest is now two binary searches per forecast. **~50 ms**, output byte-identical across 18 compared runs |
| **Lifetime retention undid migration 044's speed fix.** A bound before everything held is a scan of everything held — and the comment written with it claimed the index kept it fast | 65–115 ms at a year, **120–200 ms** at lifetime, every load, uncached | Hourly cache. The comment now says what it costs |

**The cache is stale-while-revalidate, keyed by identity and refreshed by
token** (`src/lib/hourly-cache.ts`). The hour turning over serves the previous
hour's value at once and refreshes behind it, so only a never-seen key waits —
the first load after a deploy, a new month. Concurrent loads share one query.
A failure is never cached; a "nothing to show" is never cached either.
**Sales and covers are never cached** — they are what the page is opened for
and a test asserts neither passes through it.

**A cold panel ships as "still calculating", never as its empty state.** Each
optional panel gets 250 ms after the core is in; a panel still running is named
in `pending` and the work carries on into the cache. The empty states are the
trap: "no P&L ingested" printed about a figure ten seconds away is a false
statement, and on a cold cache it would have been printed four times.

**And production now measures itself.** One log line per load —
`[dashboard] 840ms data_through=… core=… retention=hit@0ms forecast=stale@0ms`
— and the same as a `Server-Timing` header in the browser's network panel.
This entry's numbers came from a laptop because the server had none; the next
one will not have to.

**Recurs? Every customer, and every time a panel is added.** Each addition was
reasonable on its own and measured on its own; nobody measured the PAGE. The
rule that came out of it: a new dashboard panel is either live-and-cheap or
cached-and-optional, and it says which in `buildDashboard` — there is no third
kind.

**Round two, from the first production log (5 Oct 2026).** The instrumentation
paid for itself at once. Every heavy panel was a cache hit at 0–2 ms, so the
first fix had worked — and what was left was not work but DISTANCE:

- `data_through`, a one-row indexed lookup, took **110–700 ms**. Nothing that
  small costs that much; it is the round trip. Two more such trips sat in
  front of it (the venue list, and the session on a cold load), all in series.
  The venue list and the last-day-of-data lookup are now cached, the latter
  CLEARED by the ingest route so an upload shows on the next load.
- `retention unavailable: canceling statement due to statement timeout`, on a
  background refresh. The cache served the old value, exactly as designed —
  which is how it showed up as a log line and not as a missing panel. The
  cause was this entry's own third row: lifetime lookback plus a date-bounded
  history scan is a full scan. Migration 052 reads history for the PERIOD'S
  GUESTS through the (client, date) index. Checked against 044 on 148,230
  synthetic rows: identical output for 15 month/lookback pairs, 130 → 40 ms at
  lifetime, and the plan shows one index probe per guest.
- Retention was cached per reader, so the owner and each manager each ran it.
  The RPC returns every venue whoever asks; it is now one run per month per
  hour, sliced per reader afterwards.

**What a slow line looks like now, so it can be read without this entry.**
`[dashboard] total data_through=… core=…` is server time; the `[slow] GET
/api/dashboard` line just after it is the same request INCLUDING session
validation and the venue read. The gap between the two is time spent before
the dashboard started. Railway shows every `[slow]` line as severity "error"
because it is written to stderr; none of them is an error.

### 5.10 The retry was wrapped around everything except the call that failed

Spotted by Khai in the admin console: three `sevenrooms:auth-error` rows at
**29 Sep 2026, 17:04**, one per venue, all reading `SevenRooms auth failed:
HTTP 503`.

**503 is their server, not our credentials** — a rejected key returns 401, which
the script already distinguishes. SevenRooms was briefly unavailable, the run
died before reading a single reservation, and it recovered on its own: the 3 Oct
runs ingested 397 and 307 rows.

**The defect is where the retry was, not whether there was one.**
`isTransientHttp()` lists 503 explicitly, and was written on **21 Sep 2026**
after SevenRooms returned 502 on three consecutive nights — its own comment says
*"each one cost a night of the forward book."* But the retry loop was wrapped
around the **page fetches**. `authenticate()` called `fetch()` directly and threw
on the first non-OK response. **The one call that happens first, and whose
failure costs all three venues before anything is read, was the only one not
protected by the mechanism built for exactly its status code.** Eight days later
it cost a run.

**Recurs? Every customer, for every integration.** The general form: when a
retry is added to a hot path, the setup call in front of it is easy to miss
precisely because it is not the part that was failing at the time.

**Nothing was lost, and the reason is worth being uneasy about.** Each run
re-reads today−7 to today+60, so the next success repaired the gap. That is a
recovery which depends on an outage being shorter than the lookback — had
SevenRooms been down eight days, the hole would have been permanent and silent,
because the watchdog reports ingestion ERRORS and a venue with no past
reservations for a week does not look different from a quiet week.

### 5.12 An alert that was true four days ago and false now

Khai, on seeing the SevenRooms 503 still sitting in the console on 3 Oct: *"It
recovered on its own and no data was lost — so it should not also display the
error, or it could display the error but define it as resolved."*

He was right, and the second option is the better one. The panel was **accurate
about the past and misleading about the present**, which is the worst kind of
alert: read enough of them and the panel stops being read at all.

`resolutionFor()` matches each failure against the successful runs that came
after it. **The error is marked, not hidden** — a week of blips that each
self-healed is a pattern about a vendor somebody should be able to see. What
changes is that it stops looking like a task, stops counting on the tab, and
sorts below the failures that are still live.

**Two kinds of failure, repaired by different things, and conflating them would
be the easy mistake.** A DATED failure — a Revel file for 29 Sep that would not
parse — is repaired only by that date later loading; the 30th loading proves
nothing about it, and treating it as proof would close a real gap on screen
while leaving it open in the warehouse. A RUN failure has no business date
because it never got far enough to be about a day, and those sources re-read a
rolling window, so the next successful run of the same type covers the same
ground.

**What it deliberately does NOT claim.** For a run failure it says a later run
succeeded, not that every missing row is back. The second is only true while the
outage is shorter than the source's lookback, and the log does not record what
that lookback was. Saying the weaker, true thing is the point.

The badge had to move with it: it counted every recent failure, so a repaired
one would have sat on the tab while the panel greyed it out — the
badge-disagrees-with-panel fault this file already treats as worse than no badge.

### 5.11 The error messages were accurate and unreadable

The same panel showed, verbatim:

    ingestion_error   sevenrooms:auth-error   SevenRooms auth failed: HTTP 503
    parse_error       Operations_Report_…csv  Quote Not Closed: the parsing is
                                              finished with an opening quote at line 4

Both precise, both useless to most people who open this page. "HTTP 503" does
not say whether our password is wrong or their server is down, and those need
**opposite responses** — one is a thing to fix today, the other a thing to wait
out. Somebody who cannot tell them apart either escalates every blip or ignores
a real outage. `ingestion_error` and `parse_error` are our own vocabulary,
printed first, where they are read first.

`explainIngestError()` now returns a sentence and an action — *needs fixing*,
*should clear itself*, *worth a look* — and `describeStatus()` says the status in
words.

**BOTH ARE SHOWN, never one instead of the other.** The sentence is for deciding
what to do; the raw message and the raw status are what you quote to a vendor's
support desk and what you search for. Replacing them would move the problem.

**An unrecognised error returns null and the raw message appears alone**, which
is all the panel ever showed — so silence is never a regression, and a wrong
explanation (which would send somebody to check credentials that are fine) is
never possible. The list grows as real errors turn up rather than by
anticipating them. There is a test asserting that no explanation itself contains
a status code or a parser term.

### 5.9 The admin page was slow because authentication was, forty-eight times

Reported as "admin.html loads very slow". The page is 24.6 KB gzipped and makes
eleven API calls, so the obvious suspects were the payload and the request
count. Neither was it.

**`validateSession()` made FOUR serial round trips to Supabase** — `getUser`,
then roles, then profile, then terms acceptances — and it runs on **every
authenticated request** through `requireAuth`. Loading the admin console issues
twelve of them. That is **forty-eight sequential network calls to answer "who is
this" twelve times about the same person**, before a single admin query had run.

Invisible from both ends, which is why it lasted: the browser sees twelve slow
requests and the server said nothing at all.

Three fixes, in descending order of effect:

1. **A thirty-second session cache**, keyed on the access token. Twelve
   validations become one. It is an authorisation cache, so the trade is stated
   rather than buried: every path in this process that grants or revokes a role,
   deletes a user or records an acceptance calls `forgetSessions()`, making the
   staleness window **zero for anything the app itself does**. Only a change made
   directly in the Supabase dashboard can be stale, and only for half a minute.
   It caches an answer and never a refusal, so a transient Supabase error can
   never be held as a lockout. It lives in its own file because the rules are
   security-sensitive and `session.ts` cannot be imported by a test without
   credentials.
2. **The three remaining reads in parallel.** They are all keyed on the same
   user id and none feeds another; they were sequential for no reason. Four
   round trips become two on every cache miss.
3. **The page's second wave started with its first.** `render()` kicked off the
   account map, fee acknowledgements and StaffAny sections only after all seven
   of the first batch had returned — so the slowest of the seven gated three
   requests that depend on none of them.

**And a latent correctness bug found while reading the slow query.**
`/admin/api/account-map` computed "which ledger accounts are unmapped" by
pulling every non-summary row of `profit_and_loss` **with no paging**. PostgREST
caps a response at 1,000 rows, and the table holds 2,898 — so it was reading
35% of the ledger, in Postgres's physical order, with no `ORDER BY`. Which rows
it saw was not even stable between page loads. Migration 049 adds a view that
does the DISTINCT in Postgres: 159 rows instead of a thousand, and correct.

**IT HAD NOT ACTUALLY COST ANYTHING, and that was checked rather than assumed.**
Measured after the migration: 2,898 non-summary rows, 159 distinct accounts,
and **zero unmapped**. `account_map` was seeded by migration 024 in server-side
SQL, which has no PostgREST cap, so it already held all 159 — and truncation can
only produce FALSE NEGATIVES. It can hide an unmapped account; it cannot invent
one. With nothing unmapped there was nothing to hide.

I had written here that the unmapped list "was quietly short" and told Khai to
expect it to get longer. It did not, and the claim was wrong. **A truncated read
is a real defect and its damage is still a separate question — ask what the
missing rows would have CHANGED before describing the harm.**

So 049 is prospective protection rather than a repair, and it is still worth
having for the case that was waiting: the moment Xero gains a new expense
category it arrives as an unmapped account, lands outside an arbitrary
1,000-row window, and is reported as mapped — then quietly rolls up under its
own name in exactly the cross-venue comparison `account_map` exists to make
possible.

This is the fifth time the 1,000-row cap has been found in this codebase; the
comment on `fetchAccountMap()` counts four that cost data. **Recurs? Every
customer, and it will keep recurring until a read without `.range()` is treated
as a defect on sight.**

Two things worth carrying forward. The view is `security_invoker = true`:
without it a Postgres view runs as its owner and would have been a hole straight
through the RLS on `profit_and_loss`, and `rls_audit()` does not inspect views.
And the handler **falls back to the old query if the view is missing**, loudly,
because a deploy lands the moment a branch is pushed and a migration is run by a
person afterwards — in between, an empty unmapped list reads as "everything is
mapped", which is the most misleading answer available.

**A `[slow]` log line now reports any request over 400ms.** The diagnosis above
came entirely from reading code, because nothing measured anything. The next
report should start with a lookup instead.

**The cache as first shipped was a half-fix, and measuring production is what
showed it.** Against the live app: `/health`, which touches no Supabase,
answers in 384ms; the same request carrying a token, which forces one
`getUser`, answers in 659ms. **One auth round trip costs about 275ms**, and it
is Railway-to-Supabase, so it is the same from Singapore as from anywhere.

A cache only helps the SECOND caller. The admin page's twelve requests are
SIMULTANEOUS — they all miss an empty cache in the same millisecond, all twelve
call Supabase, and the first answer arrives long after the other eleven have
already been asked. As shipped, the cache would only have helped a page load
that happened within thirty seconds of another one, which is not the case
anybody complained about. `SingleFlight` coalesces them: the first caller does
the work, the other eleven await the same promise. The entry is removed when
the promise settles either way, because a rejected promise left in the map
would be handed to every future caller — one transient Supabase error becoming
a permanent lockout.

**And the config fetch was removed entirely rather than parallelised.** It was
a whole round trip at the front of every page for two values that are public by
design and change only when the project does. It is now substituted into the
HTML by the server, with the fetch kept as a fallback so a failed substitution
costs a round trip instead of authentication. Measured after: login.html makes
**one** subresource request — the auth client, started at 24ms by its
modulepreload, while the document is still parsing.

**What is deliberately NOT done.** The last serial link is that the API calls
need a token, which needs the client. It could be broken by reading the session
out of localStorage before the client loads — and it is not worth it: the
vendored bundle is cached for a day, so on any visit after the first it arrives
from browser cache in single-digit milliseconds and there is nothing to save.
The cost would be a coupling to Supabase's private storage format, paid every
day, for a saving that exists only on the first load of the day.

**Three hours of this were wasted on a stale server.** A test kept showing the
injection not happening; the middleware was correct and the local server had
failed to restart with `EADDRINUSE`, so every check was reading the old build.
The error was in a log file nobody looked at. **When a verification keeps
failing in a way the code cannot explain, confirm what is actually running
before debugging what you think is.**

### 5.8 Four layout bugs that only existed on a phone

Reported from a real phone on 3 Oct 2026, with screenshots, and every one
reproduced at 390px before anything was changed. The desktop admin page was
fine; none of this is visible there, which is why it had survived.

| Symptom | Root cause | Recurs? |
|---|---|---|
| The five Meta probe buttons rendered on top of one another | Inline-block buttons separated by a space. They fit on one line on a desktop; wrapped, a box taller than the inherited line-height overlaps the line above it | Every customer |
| The StaffAny date fields were white boxes on a dark page | `.invite-form input` and `.modal input` were styled, a bare `input` was not, and those two were the only inputs outside both. `color-scheme: dark` was also needed — the calendar icon is drawn by the browser, and CSS cannot reach it | Every customer |
| An AI note rendered **one character per line**, hundreds of lines tall | `word-break: break-all` on `.fname`, correct for the filenames the class was written for and wrong for the sentences it was later reused for, once flex had squeezed the column to ~10px | One-off |
| The page scrolled sideways, 557px of content in a 375px viewport, so every table's right-hand column was unreachable | No scroll container on any table. The role matrix carries a hard `min-width: 520px` | Every customer |

**The fix that did not work, and why it is worth recording.** The obvious move
for the tables is `display: block; overflow-x: auto` on the table itself —
`display: block` is genuinely required, because a table box ignores `overflow-x`
at all. It changed nothing: computed style came back `display=block
overflowX=auto` **`width=520px`**, and the page was still 557px wide. The
`min-width` had simply moved onto the scrolling box. **Where a table has a
minimum, the scroll must go on a WRAPPER outside it.** Where it has none — the
markdown tables in the chat — putting it on the table is correct, and
index.html had been doing exactly that since it was written.

**The wrapper is applied by a MutationObserver, not at each call site.** This
page builds tables in about a dozen places and several inject their HTML long
after load, when somebody clicks a probe. Wrapping at each site means finding
all twelve today and remembering the thirteenth next year — and the forgotten
one is always the newest. Same argument as the page tests discovering pages
rather than listing them.

**Looking for the bug found two more.** `plan.html` had the same table overflow
(409px of content in 375px) and `briefing.html` had nothing stopping it; both
were simply missed when `index.html` got it. The briefing is the page most
likely to be read on a phone.

**Two process notes.** A static test cannot prove a layout — the proof was a
browser reporting `scrollWidth` against `clientWidth`, and those numbers are in
`mobile-layout.test.ts` beside each assertion. And when a check first fired, it
was on a **legitimate** 760px: the off-screen PNG staging element, held at
`left: -10000px`, which contributes nothing to layout. The exemption was made
specific rather than the check weakened, because the easy response to a false
positive is to delete the test.

### 5.7 Three dots for ninety seconds, and two wrong assumptions on the way to fixing it

A question that runs a twelve-round tool loop takes well over a minute, and the
only thing in front of the person asking was the bouncing-dots indicator. 5.1
and the `/ask` error handler had already written down why that is worse than
dull: *"a six-minute answer and a crash look identical from the front end and
are nothing alike."* `/ask/stream` reports the engine's own account of what it
is doing -- Thinking, then each query in plain language, then Writing -- and
keeps the old `/ask` as a fallback, so an intermediary that buffers an event
stream costs the progress display and never the answer.

**The answer text is deliberately NOT streamed.** Sauron's replies are mostly
tables, by instruction, and a table streamed as raw markdown is a wall of pipes
and asterisks that only becomes readable at the end. Khai's call, 3 Oct 2026.

**Two assumptions were wrong, and both were caught by measuring rather than
reasoning. They are the point of this entry.**

*gzip would buffer the event frames.* Plausible -- a compressor holds small
writes back, and a progress frame is about eighty bytes -- so a path exclusion
was written, with a comment stating it had been measured. It had not. Measured
afterwards, the frames arrive at 0.00s, 0.40s, 0.80s, 1.20s, 1.60s **with
compression enabled**, because Hono excludes `text/event-stream` from its own
compressible set by an explicit negative lookahead. The exclusion was removed:
a redundant guard that looks load-bearing hides the real reason something
works, and the next person to touch it reasons from the wrong fact.
`server.compress.test.ts` pins the real protection instead.

*A screenshot showed the progress labels overflowing the bubble.* They were not.
Headless Chromium laid the page out at 500px while writing a 390px image, so a
perfectly contained bubble was CROPPED and read as broken. Measured properly
inside a 390px iframe: `scrollWidth === clientWidth`, no overflow. **A rendered
image is evidence of layout only if you know what width it was laid out at** --
otherwise it is as likely to invent a bug as to find one.

What rendering it DID find, correctly, was a real defect no test could see: the
completed-step tick is an L rotated 45°, and it only reads as a tick if it is
taller than it is wide. At 7×7 it drew a chevron. Every test passed. Same
lesson as the chart palette in 5.3 and the legend order: **render it and look
at it.**

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
   confirm which feeds are live, and add a "never send to Spam" filter for the
   report sender in the mailbox n8n reads (1.11).
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
