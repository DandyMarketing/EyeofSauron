-- Supplier credit notes, so bill-derived cost stops being overstated.
--
-- Measured for Neon Pigeon, June 2026: four accounts came back ABOVE 100% of
-- their ledger total, COGS Food at 109%. Bills claimed more was spent on food
-- than the P&L recorded, which is impossible. The missing piece is ACCPAYCREDIT
-- -- a credit note reducing what a supplier is owed. `query_supplier_bills` has
-- named credit notes as the cause since coverage was built, which made the
-- answer honest and left the figure wrong.
--
-- NO NEW SCOPE WAS NEEDED. Credit notes sit under `accounting.invoices`, which
-- this app already holds. That was checked against Xero's granular scope
-- mapping BEFORE any work started -- the one-scope-at-a-time rule exists so
-- nobody guesses and burns a consent round across three organisations, and the
-- guess here would have been wrong in the expensive direction.
--
-- STORED IN THE SAME TABLES AS BILLS, on purpose. A credit is a negative bill:
-- it has a supplier, a date, a status and lines coded to accounts. Sharing the
-- table means coverageByAccount() needs no special case -- it sums line amounts
-- and a credit simply reduces the numerator -- and, more importantly, it means
-- ONE code path and therefore one copy of the payroll exclusions. Two paths
-- would be two copies, and the day they drift is the day a credit note
-- reversing a wage payment carries a person's name into the warehouse.
--
-- AMOUNTS ARE NEGATED AT INGEST, because Xero returns them positive. A $436
-- credit arrives as Total: 436, and stored as it came would ADD $436 to
-- apparent spend -- doubling the error it exists to correct while looking like
-- a fix. See src/parsers/xero/credit-notes.ts.
--
-- The unique key is untouched: a CreditNoteID and an InvoiceID are different
-- UUID spaces, so both live under (tenant_id, invoice_id) without colliding.

alter table public.supplier_bills
  -- ACCPAY | ACCPAYCREDIT. Defaulted rather than backfilled: every row that
  -- exists today came from the bills path, so the default IS the truth for
  -- them, and a NULL here would be indistinguishable from a row nobody typed.
  add column if not exists document_type text not null default 'ACCPAY';

comment on column public.supplier_bills.document_type is
  'ACCPAY = supplier bill. ACCPAYCREDIT = supplier credit note, whose amounts are stored NEGATIVE so they net against bills. Never sum the two with a sign correction — the sign is already in the data.';

-- The coverage query reads a venue's lines for a period and now has to pick up
-- credits alongside bills; both live behind this index.
create index if not exists supplier_bills_type_idx
  on public.supplier_bills (venue_id, document_type, bill_date);
