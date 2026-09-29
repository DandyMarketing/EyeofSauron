-- The Singapore diary, October to December 2026.
--
-- WHY A SEED AT ALL, when the design is that the calendar fills itself from
-- planning. Because an empty table teaches the agent that checking it is
-- pointless, and because the planning window right now IS this quarter. The
-- flywheel needs a first turn.
--
-- WHAT IS IN HERE AND WHAT IS NOT. Only things with a real date that could
-- plausibly move trade in the CBD: the race season, large-venue concerts, the
-- film festival, Halloween. Not restaurant openings, not anything undated --
-- CATS is running at Sands Theatre this October and the run dates did not come
-- back cleanly, so it is absent rather than guessed. A guessed date in the
-- table whose job is warning about dates is worse than the gap.
--
-- EVERY ROW IS confirmed = false AND THAT IS THE POINT. These came from a web
-- search on 30 Sep 2026 -- an events aggregator, not the organisers -- which is
-- the weakest evidence in this system. The query tool reports the flag with
-- every row so a reader knows what they are holding, and a person promotes one
-- by checking it. Treat the dates as indicative until somebody has.
--
-- THE DIRECTION MATTERS MORE THAN THE SIZE, and effect_notes carries it. The
-- Indoor Stadium and the National Stadium are at Kallang: a fifty-thousand
-- person night there pulls the city's evening AWAY from Telok Ayer and Craig
-- Road rather than toward it. Something at Marina Bay does the opposite. A
-- large number with no direction beside it is not information.
--
-- PUBLIC HOLIDAYS ARE NOT REPEATED HERE. Deepavali, Christmas and the rest are
-- in public_holidays from MOM, the gazetting authority. Two sources for one
-- fact is the failure this codebase keeps finding. The Deepavali street
-- LIGHT-UP is a different thing -- a specific event on a specific evening --
-- and belongs here.

insert into public.city_events
  (name, start_date, end_date, category, location, part_of,
   ticket_price_low, ticket_price_high, audience, effect_notes, source, source_url)
values
  -- ---- October -----------------------------------------------------------
  ('Grand Prix Season Singapore 2026', '2026-10-02', '2026-10-11', 'festival',
   'Citywide, centred on Marina Bay', 'Singapore Grand Prix 2026',
   null, null,
   'Everyone. The season around the race is free to be in the middle of, so it is far broader than the ticketed race — the city fills with visitors for ten days, not three.',
   'Begins a full week BEFORE the race weekend and is the reason the whole period trades abnormally rather than just the Saturday. Road closures build through it. Treat any date from 2 to 11 October as distorted, not comparable to an ordinary week, and not a fair baseline for anything.',
   'visitsingapore.com via events roundup',
   'https://www.visitsingapore.com/whats-happening/all-happenings/'),

  ('Deepavali Street Light-Up Ceremony', '2026-10-03', '2026-10-03', 'festival',
   'Little India', null,
   null, null,
   'Families and the Indian community, plus general crowds. Free and very well attended.',
   'Pulls the evening to Little India. Relevant to Firangi Superstar as an audience signal rather than a clash — the people at it are a target demographic for Indian dining, and the weeks around it are when that audience is most reachable.',
   'events roundup',
   'https://www.visitsingapore.com/whats-happening/all-happenings/'),

  ('TWICE — Ready to Be tour', '2026-10-11', '2026-10-12', 'concert',
   'Singapore Indoor Stadium, Kallang', null,
   null, null,
   'K-pop audience, reported at about 12,000 per show. Skews young and female, heavily regional visitors.',
   'Kallang, not the CBD, so the direction is AWAY: it takes the city''s evening out to the stadium. Note the 11th collides with the Grand Prix race day — two very large draws on one night, pulling in opposite directions.',
   'concert listings roundup',
   'https://www.harpersbazaar.com.sg/lifestyle/upcoming-concerts-and-music-festivals-singapore-dates-and-tickets'),

  ('ARTBAT', '2026-10-17', '2026-10-17', 'concert',
   'Pasir Panjang Power Station', null,
   null, null,
   'Melodic techno crowd. Late, and a night-out audience rather than a dining one.',
   'West of the CBD and late. More likely to take a late bar trade than a dinner service.',
   'events roundup',
   'https://www.theurbanlist.com/singapore/a-list/singapore-events'),

  ('NCT Dream', '2026-10-18', '2026-10-19', 'concert',
   'Singapore Indoor Stadium, Kallang', null,
   null, null,
   'K-pop audience, reported sold out across two nights. Young, heavily regional visitors.',
   'Kallang again — direction AWAY from the CBD on both evenings.',
   'concert listings roundup',
   'https://www.harpersbazaar.com.sg/lifestyle/upcoming-concerts-and-music-festivals-singapore-dates-and-tickets'),

  ('Singapore International Film Festival 2026', '2026-10-21', '2026-11-01', 'festival',
   'Multiple venues, several central', null,
   null, null,
   'Film audience, older and higher-spending than a concert crowd, out in the evening on weeknights.',
   'Twelve days of weeknight evening activity in and around town. A mild positive for anywhere near a screening venue and close to nothing elsewhere — worth knowing rather than worth planning around.',
   'events roundup',
   'https://www.visitsingapore.com/whats-happening/all-happenings/'),

  ('Halloween', '2026-10-31', '2026-10-31', 'other',
   'Citywide', null,
   null, null,
   'Broad, skewing young and going out late. One of the largest bar nights of the year.',
   'Not a public holiday and not organised by anyone, which is exactly why it is easy to miss when planning. A Saturday in 2026. Anything dinner-led competes with a night that belongs to bars; anything bar-led should be planned for months ahead rather than weeks.',
   'calendar',
   'https://www.visitsingapore.com/whats-happening/all-happenings/'),

  -- ---- November ----------------------------------------------------------
  ('LANY', '2026-11-04', '2026-11-04', 'concert',
   'Singapore Indoor Stadium, Kallang', null,
   null, null,
   'Pop audience, young, large. Regional visitors as well as local.',
   'Kallang, a Wednesday. Direction AWAY from the CBD on a weeknight that would otherwise be ordinary.',
   'concert listings roundup',
   'https://www.harpersbazaar.com.sg/lifestyle/upcoming-concerts-and-music-festivals-singapore-dates-and-tickets'),

  -- ---- December ----------------------------------------------------------
  ('PGL Major Singapore 2026 — playoffs', '2026-12-10', '2026-12-13', 'sport',
   'Singapore Indoor Stadium, Kallang', null,
   null, null,
   'Esports audience, international, in town for several days. Young and skews male.',
   'Four days at Kallang. Unlike a concert the crowd is in Singapore for the whole run rather than one evening, so the daytime and pre-event trade across the city is affected as much as the nights.',
   'events roundup',
   'https://www.theurbanlist.com/singapore/a-list/singapore-events'),

  ('BTS — National Stadium', '2026-12-17', '2026-12-22', 'concert',
   'National Stadium, Kallang', null,
   null, null,
   'Reported across four nights (17, 19, 20 and 22 December). A National Stadium run is tens of thousands per night and draws heavily from the region — visitors in Singapore for days around it, not just the evening.',
   'THE LARGEST DRAW OF THE QUARTER and it lands in the middle of the Christmas trading fortnight. Two opposing effects and they must not be confused: on show nights the evening goes to Kallang, but the days around them put a large visiting population in the city with hotel nights to fill. The 18th and 21st fall between shows and are likely the strongest of the run for anywhere central. Stored as one span because the run is one event; the dark nights inside it are the interesting part.',
   'concert listings roundup',
   'https://www.harpersbazaar.com.sg/lifestyle/upcoming-concerts-and-music-festivals-singapore-dates-and-tickets')
on conflict (name, start_date) do nothing;

-- ---------------------------------------------------------------------------
-- The F&B trade calendar that has already passed this year.
-- ---------------------------------------------------------------------------
--
-- SEEDED DESPITE BEING IN THE PAST, for two reasons. A planner asking "what did
-- last year's version do" needs the anchor to exist a year later, and these
-- recur -- the comparison window for a shared occasion is the previous
-- occurrence whatever the gap, and that only works if the occurrence is on
-- file. And they explain historical weeks that would otherwise read as
-- unexplained movement.
--
-- The 2027 editions are NOT here because they are not published yet. That is
-- the normal state for this table and the query tool says so rather than
-- letting an empty answer read as a quiet month.

insert into public.city_events
  (name, start_date, end_date, category, location, part_of,
   ticket_price_low, ticket_price_high, audience, effect_notes, source, source_url)
values
  ('World Class Cocktail Festival 2026', '2026-02-24', '2026-05-31', 'festival',
   'Across 21 bars citywide', null,
   null, null,
   'Cocktail and bar audience. The trade itself as much as the public.',
   'A long trail rather than an event: a cocktail passport across 21 bars over three months. The competing venues ARE the festival, so the question it raises is whether to be in it rather than whether it clashes.',
   'events roundup',
   'https://www.theurbanlist.com/singapore/a-list/world-class-cocktail-festival-2026-singapore'),

  ('Singapore Cocktail Crossover 2026', '2026-06-09', '2026-06-14', 'festival',
   'Heritage neighbourhoods, then METT Singapore', null,
   null, null,
   'Cocktail audience and the bar trade, including international bartenders in town for it.',
   'Six days, and the first four (9-12 June) are POP-UPS, GUEST SHIFTS AND BAR TAKEOVERS across the heritage neighbourhoods — which is Telok Ayer and Craig Road. That is the single most directly competitive thing on this list for a bar-led venue, and the answer is almost certainly to participate rather than to avoid it.',
   'sgcx.sg via events roundup',
   'https://www.sgcx.sg/'),

  ('MICHELIN Guide Singapore 2026 ceremony', '2026-08-04', '2026-08-04', 'other',
   'Raffles Sentosa Singapore', null,
   null, null,
   'The trade, invite-only. The wider effect is on dining bookings in the weeks that follow rather than on the night.',
   'Invite-only, so not a clash. Its effect is the selection announcement on the same day and the Bib Gourmand list a week earlier — newly starred restaurants absorb dining demand for weeks afterwards.',
   'guide.michelin.com',
   'https://guide.michelin.com/sg/en/event/save-the-date-michelin-guide-singapore-2026'),

  ('Singapore Food Festival 2026', '2026-09-04', '2026-09-24', 'festival',
   'Hawker centres, heritage districts and dining venues citywide', null,
   null, null,
   'Broad and food-led, locals and visitors.',
   'Three weeks across September, which overlaps the Term 3 school break. A venue not participating is competing with three weeks of programmed food events; one participating gets the reach. Worth checking against September trade in any year-on-year read.',
   'events roundup',
   'https://www.singaporetravelhub.com/events/singapore-food-festival/')
on conflict (name, start_date) do nothing;
