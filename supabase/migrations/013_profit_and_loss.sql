-- Profit & Loss from Xero.
--
-- The first cost data in the warehouse. Everything until now has been
-- revenue-side -- sales, covers, product mix, hourly -- because Revel delivers
-- COGS as zero. Sauron could say what sold and when, and nothing about whether
-- any of it made money.
--
-- Stored one row per report line rather than as a summarised P&L, so a
-- question about a specific cost line can be answered without a new
-- integration, and so line items can be summed and checked against the totals
-- Xero reports (the reconciliation gate in CLAUDE.md).

create table if not exists public.profit_and_loss (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references public.venues(id) on delete cascade,
  -- Kept alongside venue_id so a figure can be traced back to the exact Xero
  -- organisation it came from, even if a mapping is later corrected.
  tenant_id    text not null,

  period_start date not null,
  period_end   date not null,

  -- Xero's own section heading: 'Income', 'Less Cost of Sales',
  -- 'Less Operating Expenses'. Amounts are stored exactly as Xero reports
  -- them -- costs are POSITIVE under a "Less ..." heading -- because
  -- re-deriving the sign here would put a second, undocumented convention
  -- between the ledger and the answer. The section carries the meaning.
  section      text not null,
  account_name text not null,
  account_id   text,
  amount       numeric(14,2) not null,

  -- True for a section total ("Total Income"). Summing rows without excluding
  -- these double-counts every section, which is the most obvious way to get a
  -- confident wrong answer out of this table.
  is_summary   boolean not null default false,
  sort_order   integer not null default 0,

  fetched_at   timestamptz not null default now(),

  unique (venue_id, period_start, period_end, section, account_name, is_summary)
);

create index if not exists profit_and_loss_venue_period_idx
  on public.profit_and_loss (venue_id, period_start, period_end);

comment on column public.profit_and_loss.is_summary is
  'Section total rather than a detail line. ALWAYS filter these out before '
  'summing, or every section is counted twice.';

alter table public.profit_and_loss enable row level security;

-- Same venue scoping as the rest of the warehouse. Note this is defence in
-- depth only: the application uses the service-role key and bypasses RLS, so
-- the real boundary is enforceVenueScope() in application code.
drop policy if exists "Users can view P&L for their venues" on public.profit_and_loss;
create policy "Users can view P&L for their venues"
  on public.profit_and_loss for select
  using (
    venue_id in (
      select venue_id from public.user_venue_roles where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_venue_roles
      where user_id = auth.uid() and role = 'owner'
    )
  );
