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

## Open decisions (confirm with Khai, don't assume)

StaffAny API grant method · Revel report frequency · Revel venue-key mapping (Khai to gather one filename per venue) · user scale (managers only vs all staff) · exact StaffAny fields to ingest · Telegram allowlist owner · Supabase hosted vs self-hosted.

## Working style — hard rules

- **Do not overcomplicate.** Try the simplest, most direct fix first. Exhaust the obvious before reaching for workarounds, CLI installs, or multi-step procedures.
- **When troubleshooting:** diagnose the root cause, propose the shortest path to fix it, then act. Do not send the user on a wild goose chase.
- **Khai is on Windows PC.** Keep platform-specific instructions Windows-friendly.

## Reference

Two companion documents exist (HTML): the visual **blueprint** (architecture, diagrams, security, roadmap) and the **Phase 0 checklist**. Ask Khai for them if useful.

**`docs/BUILD_LOG.md`** — defects hit during this build, their root causes, and whether each one will recur at every new customer. Read it before adding an ingestion path, a query tool, or anything that reads a paginated source; several of the bugs recorded there lost data silently and returned a confident wrong answer. Add to it when something breaks and the cause was not obvious.
