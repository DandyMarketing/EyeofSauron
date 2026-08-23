-- One venue's account name, and what it means everywhere else.
--
-- WHY THIS EXISTS. The three ledgers name the same cost differently. Measured
-- 23 Aug 2026, and the pattern is unusually clean: Firangi Superstar and Neon
-- Pigeon agree, and Fat Prince is the outlier on all nine.
--
--   Fat Prince                          Firangi + Neon Pigeon
--   Accounting and Audit                Accounting and Audit fees
--   Corporate Secretarial Expenses      Corporate Secretarial fees
--   Light, Power, Heating               Light, Power and Gas
--   Management Fees                     Management fee
--   Merchant Fees                       Merchant fees
--   Public Relations / Marketing costs  Public Relations / Marketing fees
--   Recruitment expeses  (their typo)   Recruitment / Visa expenses
--   Staff costs - Uniforms              Staff costs - Uniform
--   Staff Costs - Welfare               Staff welfare
--
-- CLAUDE.md calls cross-venue benchmarking the product's edge -- "your food
-- cost 32% vs sister venue 28%" -- and that only holds if the same cost lands
-- under the same label. Ask about marketing spend today and it splits across
-- two names that never add up, in an answer that looks complete.
--
-- WHY MAPPED RATHER THAN RENAMED IN XERO. Renaming would fix our three ledgers
-- once. But the stated goal is selling this to other F&B operators, and you
-- cannot ask a customer to rename their chart of accounts. A mapping layer is
-- therefore a product requirement, not a workaround -- and the table has to
-- exist anyway for business_line below.
--
-- TWO INDEPENDENT AXES, and conflating them was my first mistake here:
--
--   canonical_account  unifies naming so venues can be COMPARED
--   business_line      separates sub-businesses so they can be ISOLATED
--
-- Neon Pigeon runs a sushi business inside Potus Pte Ltd. It must roll INTO the
-- entity's P&L -- the whole point of launching it was to improve Potus's
-- profitability -- and it must also be reportable on its own. So COGS - Sushi
-- gets canonical_account 'COGS - Food' AND business_line 'sushi': it compares
-- with other venues' food cost, and it still filters out on demand. Nothing is
-- lost either way.
--
-- UNMAPPED DEFAULTS TO ITSELF, and that is deliberately unlike the BOH/FOH role
-- mapping, where an unmapped role must never default. The difference is what
-- the default DOES. Falling into a bucket makes a category drift with no
-- visible cause; falling back to your own name merges nothing and moves no
-- figure -- the only cost is that unification has not happened yet. So a new
-- account appears in the admin console's unmapped list rather than quietly
-- corrupting a comparison.

create table if not exists public.account_map (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references public.venues(id) on delete cascade,

  -- Exactly as the ledger spells it, typo included. This is the join key, so
  -- it must never be "tidied" -- see 'Recruitment expeses'.
  account_name      text not null,

  -- The shared name this rolls up to. Defaults to account_name, which is the
  -- safe no-op: it merges nothing.
  canonical_account text not null,

  -- Which business inside the venue. 'main' for everything ordinary.
  business_line     text not null default 'main',

  -- Provenance. Every other mapping table in this system carries it, because a
  -- mapping nobody can trace is one nobody can question later.
  confirmed_by      uuid references auth.users(id),
  confirmed_at      timestamptz,
  notes             text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (venue_id, account_name)
);

comment on table public.account_map is
  'Ledger account name -> shared name + business line, per venue. Rows are DECISIONS a person made. An account with no row here is unmapped: it falls back to its own name and is flagged in the admin console.';

comment on column public.account_map.account_name is
  'Verbatim from the ledger, including typos. It is the join key — never correct it here, correct it in Xero or add a mapping.';

comment on column public.account_map.business_line is
  'main | sushi | merchandise. A sub-business rolls INTO the venue P&L and can also be isolated; the two are not alternatives.';

create index if not exists account_map_venue_idx on public.account_map (venue_id);

alter table public.account_map enable row level security;

drop policy if exists "Users can view the account map for their venues" on public.account_map;
create policy "Users can view the account map for their venues"
  on public.account_map for select
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

-- ---------------------------------------------------------------------------
-- Seed: every account we already hold, mapped to itself.
-- ---------------------------------------------------------------------------
-- Generated from the data rather than hand-typed, so the table starts COMPLETE.
-- That is what gives "unmapped" its meaning: not "we have not got round to it"
-- but "this account appeared after a human last looked".

insert into public.account_map (venue_id, account_name, canonical_account, business_line, notes)
select distinct p.venue_id, p.account_name, p.account_name, 'main',
       'Seeded from existing ledger data — mapped to itself, not yet reviewed.'
from public.profit_and_loss p
where p.is_summary = false
  and p.account_name is not null
on conflict (venue_id, account_name) do nothing;

-- ---------------------------------------------------------------------------
-- Overrides: the decisions.
-- ---------------------------------------------------------------------------
-- Canonical names take the MAJORITY form (Firangi + Neon Pigeon, two of three)
-- rather than a tidier invention. A name somebody already recognises is easier
-- to check than one this migration made up.

update public.account_map m
set canonical_account = v.canonical,
    notes = v.why,
    updated_at = now()
from (values
  ('Accounting and Audit',               'Accounting and Audit fees',          'Fat Prince spelling of the majority form.'),
  ('Corporate Secretarial Expenses',     'Corporate Secretarial fees',         'Fat Prince spelling of the majority form.'),
  ('Light, Power, Heating',              'Light, Power and Gas',               'Fat Prince spelling of the majority form.'),
  ('Management Fees',                    'Management fee',                     'Fat Prince spelling of the majority form.'),
  ('Merchant Fees',                      'Merchant fees',                      'Fat Prince spelling of the majority form. Distinct from Merchant Fee - Delivery.'),
  ('Public Relations / Marketing costs', 'Public Relations / Marketing fees',  'Fat Prince spelling. Splitting marketing across two names is what breaks cross-venue comparison.'),
  ('Recruitment expeses',                'Recruitment / Visa expenses',        'Typo in the Fat Prince ledger. Mapped, not corrected — account_name is the join key.'),
  ('Staff costs - Uniforms',             'Staff costs - Uniform',              'Fat Prince spelling of the majority form.'),
  ('Staff Costs - Welfare',              'Staff welfare',                      'Fat Prince spelling of the majority form.'),
  ('Historical tax adjustment',          'Historical Tax Adjustment',          'Case-only difference at Neon Pigeon.'),
  ('COGS - Alcohol',                     'COGS - Beverages',                   'Fat Prince splits alcohol out; the other two do not. Rolled up so beverage cost is comparable. Fat Prince also has its own COGS - Beverages — both belong in the total.')
) as v(source, canonical, why)
where m.account_name = v.source;

-- Business lines. Neon Pigeon's sushi operation and merchandise sales.
update public.account_map m
set canonical_account = v.canonical,
    business_line = v.line,
    notes = v.why,
    updated_at = now()
from (values
  ('Sales - Sushi',          'Sales - Food',       'sushi',       'Rolls into food revenue for comparison; isolate with business_line = sushi.'),
  ('COGS - Sushi',           'COGS - Food',        'sushi',       'Rolls into food cost so Neon Pigeon compares like-for-like; isolate with business_line = sushi.'),
  ('COGS - Sushi Packaging', 'COGS - Packaging',   'sushi',       'Rolls into packaging cost; isolate with business_line = sushi.'),
  ('Transportation - Sushi', 'Transportation - Sushi', 'sushi',   'CONFIRM: may belong under COGS - Delivery Fee. Left as itself until somebody decides.'),
  ('Sales - Merchandise',    'Sales - Merchandise', 'merchandise', 'No equivalent at the other venues; kept as itself.')
) as v(source, canonical, line, why)
where m.account_name = v.source;
