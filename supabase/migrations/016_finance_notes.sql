-- Notes for Finance: the venues' own explanation of a day.
--
-- The Monday board has a free-text "Notes for Finance" column that the outlets
-- fill in when something needs explaining -- a voucher, a wrongly closed table,
-- an F&B credit, a payment that will arrive later. We were not reading it.
--
-- That cost real time. Neon Pigeon, 1 August 2026 read "Extra Items $84.00 For
-- beverage", which was exactly the $84 we had written up as unexplained and put
-- in front of Finance. The venues had been answering the question all along.
--
-- Nullable, and null means "nothing to say". The ingestion strips placeholders
-- ("NA", "-", "none") to null so a note in this column always means a note.

alter table daily_operations
  add column if not exists finance_notes text;

comment on column daily_operations.finance_notes is
  'Free text from the Monday board''s "Notes for Finance" column: the venue''s own explanation of anything unusual that day. Null when the venue had nothing to say. Placeholders such as "NA" are stored as null.';

-- Only a handful of days carry a note, so the useful query is "show me the days
-- that have one" rather than a text search. A partial index keeps that cheap
-- without indexing the thousands of null rows.
create index if not exists daily_operations_finance_notes_idx
  on daily_operations (venue_id, business_date)
  where finance_notes is not null;
