-- ============================================================
-- Seed: venues + revel_venue_keys for the 3 confirmed venues
-- Run in Supabase SQL Editor after the schema migrations.
-- Uses ON CONFLICT so re-running is safe.
-- ============================================================

insert into public.venues (name, slug) values
  ('Neon Pigeon', 'neon-pigeon'),
  ('Fat Prince',  'fat-prince'),
  ('Super Firangi', 'super-firangi')
on conflict (slug) do nothing;

insert into public.revel_venue_keys (report_key, venue_id) values
  ('neonpigeon_neonpigeon',        (select id from public.venues where slug = 'neon-pigeon')),
  ('fatprincepteltd_fatprince',    (select id from public.venues where slug = 'fat-prince')),
  ('superfirangi_superfirangi',    (select id from public.venues where slug = 'super-firangi'))
on conflict (report_key) do nothing;
