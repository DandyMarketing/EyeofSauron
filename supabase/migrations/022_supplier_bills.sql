-- Supplier bills, and the lines beneath them.
--
-- The P&L says "Public Relations / Marketing fees 26,034.46 in June" and cannot
-- say on what. The general ledger would have answered it and is closed to us --
-- /Journals sits on Xero's Advanced tier behind an application process. Bills
-- answer the same question and carry more: a supplier, a description, and a
-- line coded to an account.
--
-- TWO TABLES, NOT ONE, and the reason is arithmetic. Denormalising a bill's
-- total onto each of its lines makes `sum(total)` triple-count a three-line
-- bill. That is the same trap as is_summary in profit_and_loss, where section
-- totals sit beside detail lines and summing everything double-counts every
-- section. There it is documented and has to be remembered; here the shape
-- makes it impossible.

create table if not exists public.supplier_bills (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references public.venues(id) on delete cascade,
  tenant_id      text not null,

  -- Xero's own id for the bill. Stable across edits, unlike the number.
  invoice_id     text not null,
  invoice_number text,
  reference      text,

  -- The supplier. A business name in almost every case -- but a sole trader's
  -- bill carries a person's name, so this is treated with the same care as any
  -- other name in the warehouse and never goes over Telegram.
  supplier_name  text,

  bill_date      date not null,
  due_date       date,
  -- AUTHORISED, PAID, VOIDED, DELETED. A VOIDED bill still exists in Xero and
  -- must not be counted as spend, so the status is stored rather than filtered
  -- at ingest -- filtering at ingest would leave no way to explain a figure
  -- that changed when a bill was voided later.
  status         text,

  sub_total      numeric(14,2),
  total_tax      numeric(14,2),
  total          numeric(14,2),
  currency_code  text,

  fetched_at     timestamptz not null default now(),

  unique (tenant_id, invoice_id)
);

create table if not exists public.supplier_bill_lines (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references public.supplier_bills(id) on delete cascade,
  venue_id      uuid not null references public.venues(id) on delete cascade,

  -- Xero's id for the line. Some very old lines have none, so a generated
  -- fallback keys them instead -- see the ingestion.
  line_item_id  text not null,

  -- What was bought, in the bookkeeper's words. This is the actual answer to
  -- "26,034 on what".
  description   text,
  quantity      numeric(14,4),
  unit_amount   numeric(14,4),
  line_amount   numeric(14,2),

  -- BOTH identifiers, and both matter.
  --
  -- account_code is the number a human recognises (300, 310). account_id is
  -- Xero's UUID, and it is the one that JOINS: profit_and_loss.account_id holds
  -- the same value, so a bill line can be tied to the exact P&L line it landed
  -- in without a chart-of-accounts lookup. Discovered by probing rather than
  -- assumed, and it is what removed the need for another OAuth scope.
  account_code  text,
  account_id    text,

  -- Xero tracking categories, kept raw. Unused today; a venue that starts using
  -- them for departments would otherwise need a migration to benefit.
  tracking      jsonb,

  fetched_at    timestamptz not null default now(),

  unique (bill_id, line_item_id)
);

comment on table public.supplier_bills is
  'Supplier bills (Xero invoices of type ACCPAY). One row per bill. Never join to lines and sum `total` — that multiplies a bill by its line count.';

comment on column public.supplier_bill_lines.account_id is
  'Xero account UUID. Joins directly to profit_and_loss.account_id, which is how a bill line is attributed to the P&L line it landed in.';

comment on column public.supplier_bills.status is
  'AUTHORISED, PAID, VOIDED or DELETED. VOIDED and DELETED bills are stored but are NOT spend — filter them before totalling anything.';

create index if not exists supplier_bills_venue_date_idx
  on public.supplier_bills (venue_id, bill_date desc);

create index if not exists supplier_bill_lines_account_idx
  on public.supplier_bill_lines (venue_id, account_id);

create index if not exists supplier_bill_lines_bill_idx
  on public.supplier_bill_lines (bill_id);

alter table public.supplier_bills enable row level security;
alter table public.supplier_bill_lines enable row level security;

drop policy if exists "Users can view bills for their venues" on public.supplier_bills;
create policy "Users can view bills for their venues"
  on public.supplier_bills for select
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );

drop policy if exists "Users can view bill lines for their venues" on public.supplier_bill_lines;
create policy "Users can view bill lines for their venues"
  on public.supplier_bill_lines for select
  using (
    venue_id in (select venue_id from public.user_venue_roles where user_id = auth.uid())
    or exists (select 1 from public.user_venue_roles where user_id = auth.uid() and role = 'owner')
  );
