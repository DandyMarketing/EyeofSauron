-- Let an acceptance be given more than once, because it now expires.
--
-- Migration 042 put `unique (user_id, terms_version)` on this table, and that
-- was right for the rule as it stood: accept once, for ever, per wording. The
-- rule changed -- an acceptance now stands for a year (TERMS_VALIDITY_DAYS in
-- src/auth/terms.ts) -- and under the old constraint annual re-acceptance is
-- impossible. The insert would collide and either fail or, worse, be ignored,
-- leaving the ORIGINAL 2026 timestamp in place while the person believed they
-- had just renewed. The gate would keep asking, the button would keep
-- appearing to work, and nothing would ever change.
--
-- WHY A YEAR AT ALL. A three-month-old acceptance is much stronger evidence
-- than a three-year-old one on the day it is needed, and somebody asked in 2029
-- whether they understood in 2026 that they could not forward a P&L will say
-- honestly that they do not remember. They would be right.
--
-- SO RE-ACCEPTANCE ADDS A ROW RATHER THAN REPLACING ONE. The history of who
-- agreed to what, and when, is the entire reason this is a table instead of a
-- boolean on the user. An upsert that refreshed the timestamp in place would
-- keep the gate working and quietly destroy the record it exists to hold.
--
-- Duplicate rows from a double-click are possible and harmless: two identical
-- acceptances seconds apart are an accurate account of somebody pressing a
-- button twice. hasAcceptedCurrentTerms() reads the most recent.

alter table public.terms_acceptances
  drop constraint if exists terms_acceptances_user_id_terms_version_key;

-- The read is always "this person's acceptances, newest first", so the index
-- matches it. The old unique constraint was providing the lookup as a side
-- effect; dropping it without this would leave the gate doing a scan on every
-- single request, which is the one query that runs before anything else.
create index if not exists idx_terms_acceptances_user_recent
  on public.terms_acceptances (user_id, accepted_at desc);

comment on table public.terms_acceptances is
  'One row per acceptance event. A person appears once per version they have '
  'agreed to, and again each year they renew. The most recent row decides; the '
  'earlier ones are the record. Text and validity period: src/auth/terms.ts.';
