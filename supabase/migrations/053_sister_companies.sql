-- 053_sister_companies.sql
-- Which supplier names on a bill are our own venues' companies.
-- Matched EXACTLY on supplier_bills.supplier_name and confirmed by a person,
-- never guessed: "Potus Pte. Ltd." and "Potus Pte Ltd" are different contacts.
create table if not exists public.sister_companies (
  id            uuid primary key default gen_random_uuid(),
  supplier_name text not null unique,
  venue_id      uuid not null references public.venues(id) on delete cascade,
  confirmed_by  text not null,
  confirmed_at  date not null,
  notes         text
);

-- Read by the server only; no policy is deliberate (deny-all to anon/auth).
alter table public.sister_companies enable row level security;

insert into public.sister_companies (supplier_name, venue_id, confirmed_by, confirmed_at, notes)
select x.supplier_name, v.id, 'Khai', date '2026-10-06', x.notes
from (values
  ('Potus Pte. Ltd.',          'Neon Pigeon',       'Neon Pigeon''s company as it appears on bills to sister venues.'),
  ('Fat Prince Pte. Ltd.',     'Fat Prince',        'Fat Prince''s company as it appears on bills to sister venues.'),
  ('Craig Place 20 Pte. Ltd.', 'Firangi Superstar', 'Firangi Superstar''s company as it appears on bills to sister venues.')
) as x(supplier_name, venue_name, notes)
join public.venues v on v.name = x.venue_name
on conflict (supplier_name) do nothing;
