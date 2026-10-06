-- 054_sales_invoices.sql
-- Xero SALES invoices (ACCREC) and customer credit notes (ACCRECCREDIT).
--
-- Why: Neon Pigeon's sushi is sold wholesale and invoiced in Xero, never rung
-- through Revel. The P&L gives sushi sales a month at a time; invoices carry a
-- date, so they give it by the week. Khai, 6 Oct 2026.
--
-- SEPARATE TABLES FROM supplier_bills, on purpose. Every bill query sums
-- supplier_bill_lines without filtering on document type; a sale stored there
-- would be counted as spend by all of them.
--
-- No new Xero scope: ACCREC is the same /Invoices endpoint and the same
-- accounting.invoices permission that bills already use.

create table if not exists public.sales_invoices (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references public.venues(id) on delete cascade,
  tenant_id         text not null,

  -- Xero's InvoiceID, or CreditNoteID for a credit. Different UUID spaces, so
  -- both live under one key without colliding.
  invoice_id        text not null,
  -- ACCREC = sales invoice. ACCRECCREDIT = customer credit note, stored NEGATIVE.
  document_type     text not null check (document_type in ('ACCREC', 'ACCRECCREDIT')),
  invoice_number    text,
  reference         text,

  -- The customer. Usually a business; can be a person, so treated like any
  -- other name in the warehouse and never sent over Telegram.
  customer_name     text,

  invoice_date      date not null,
  due_date          date,
  -- DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, DELETED. Only AUTHORISED and
  -- PAID are sales -- the others are not in the ledger. Stored, filtered on read.
  status            text,
  -- Exclusive | Inclusive | NoTax: what line_amount means on this invoice.
  line_amount_types text,
  sub_total         numeric(14,2),
  total_tax         numeric(14,2),
  total             numeric(14,2),
  currency_code     text,
  fetched_at        timestamptz not null default now(),

  unique (tenant_id, invoice_id)
);

create table if not exists public.sales_invoice_lines (
  id                uuid primary key default gen_random_uuid(),
  sales_invoice_id  uuid not null references public.sales_invoices(id) on delete cascade,
  venue_id          uuid not null references public.venues(id) on delete cascade,
  line_item_id      text not null,
  description       text,
  quantity          numeric(14,4),
  unit_amount       numeric(14,4),
  -- As Xero sends it: tax-INCLUSIVE when line_amount_types is Inclusive.
  line_amount       numeric(14,2),
  tax_amount        numeric(14,2),
  -- Ex-GST, computed at ingest. THE figure to sum; comparable with the P&L.
  net_amount        numeric(14,2),
  account_code      text,
  -- Joins to profit_and_loss.account_id, which is how a line is tied to
  -- Sales - Sushi without a chart-of-accounts lookup.
  account_id        text,
  tracking          jsonb,
  fetched_at        timestamptz not null default now(),

  unique (sales_invoice_id, line_item_id)
);

comment on column public.sales_invoice_lines.net_amount is
  'Ex-GST line amount. Sum this, never line_amount (which includes GST on Inclusive invoices). Customer credit notes are already negative.';

create index if not exists sales_invoices_venue_date_idx
  on public.sales_invoices (venue_id, invoice_date desc);
create index if not exists sales_invoice_lines_invoice_idx
  on public.sales_invoice_lines (sales_invoice_id);
create index if not exists sales_invoice_lines_account_idx
  on public.sales_invoice_lines (venue_id, account_id);

-- Read by the server only; no policy is deliberate (deny-all to anon/auth).
alter table public.sales_invoices enable row level security;
alter table public.sales_invoice_lines enable row level security;
