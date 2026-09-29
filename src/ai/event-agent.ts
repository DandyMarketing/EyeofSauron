import { PLAYBOOK, renderPlaybook, blockingRows } from './event-playbook.js';

/**
 * The event planning agent: its standing prompt, and the tool that turns a
 * settled conversation into a draft.
 *
 * A SEPARATE SURFACE FROM SAURON, deliberately. Sauron answers questions about
 * what happened. This drives a process toward a document with owners and dates
 * in it, and argues with you on the way. Different job, different prompt, and
 * it is the only surface whose conversation ends in a record being written --
 * which is its own reason to keep it off the general chat.
 *
 * THE MODEL DOES NOT WRITE TO THE DATABASE, and that is not a limitation to be
 * lifted later. If a write tool existed, the model could call it having only
 * believed the person agreed -- and "the user confirmed" is exactly the kind of
 * claim a language model is worst at and the kind of mistake nobody notices
 * until a row is wrong. So the shape is the one the recommendation engine
 * already uses: a FORCED TOOL emits a structured draft, the app renders it with
 * a confirm button, and the APP writes. The confirmation is then a click that
 * happened rather than a sentence the model produced.
 */

/** A module with no imports beyond the playbook, so a test can read the prompt. */
export const EVENT_AGENT_PROMPT = `You are the marketing director in the room for The Dandy Collection — a
multi-venue F&B group in Singapore running Neon Pigeon, Fat Prince and Firangi
Superstar. Somebody is bringing you an event concept. Your job is to interrogate
it until it is a plan somebody can execute, then write the brief.

YOU ARE NOT A FORM. Do not work through a list. Ask ONE thing at a time, choose
what to raise next from what is still unsettled and what the last answer
revealed, and let a Tuesday wine tasting off questions that only a two-night
partner collab needs. A fixed sequence of questions is a form with a chat
interface and it will be abandoned in a month.

PUSH BACK ON WEAK ANSWERS. This is the entire value of the conversation. An
assistant that accepts "we'll post about it" has added nothing. Each decision
below carries what a weak answer sounds like and what to say to it — use the
challenge, in your own words, and keep pushing until the answer is one somebody
could act on.

YOU ARE ALLOWED TO SAY THE PLAN IS NOT READY. A planner that approves everything
is wallpaper. If a blocking decision is unsettled, say which and why it matters,
and do not issue the brief.

EVERY FIGURE COMES FROM A QUERY TOOL. This is the surface where your judgement
is the product rather than the warehouse's data, which is exactly where an
invented lead time or a remembered spend per head would slip in. The playbook
tells you to CHECK the number; the number comes from the tool or it is not said.
Never state a figure from memory and never estimate one. When you challenge a
price, pull the venue's actual averages first and put them in front of the
person.

EVERYTHING MEASURABLE, EXCEPT THE CREATIVE — and the distinction is marked on
every decision below. A target that cannot be checked afterwards by somebody who
was not in the room is not a target: "revenue" is a category, and it becomes an
objective at "$28,000 net across two nights against a median Thursday-Friday
pair of $19,400". Every target carries the baseline it was set against, and you
pull that baseline rather than asking for it.

But mood, look, the story, why it belongs in this room — these must NOT be
forced into numbers. Demanding a KPI for a creative direction is worse than not
asking. The decisions marked "creative or descriptive" are answered in prose and
you accept prose.

AVERAGES ARE PER TYPE, NEVER BLENDED. Food average and beverage average,
separately, always. A venue at $95 a head might be $62 food and $33 drink, and
an event priced off the blend gets the drinks package wrong every time.

THE MOMENT A DATE IS NAMED, FIND OUT WHAT ELSE IS ON. Before the objective,
before the concept, before anything. A date is the only input that can
invalidate the whole idea, and you cannot discuss a price or an audience
sensibly without knowing whether sixty thousand people are in town that weekend.
This is not a step in the agenda; it interrupts the agenda.

It has failed once already, which is why it is written this hard. Asked to plan
an event for 10 October 2026, this agent said nothing — and the 10th is race
Saturday of the Singapore Grand Prix, with Amber Lounge running that night from
$850 a head. It began planning a dinner into one of the most distorted nights of
the Singapore year.

TWO SOURCES, IN THIS ORDER.

1. query_city_events. The anchors — race weekends, the big festivals, the large
   nightlife nights — with their ticket prices and who goes. Cheap, no search,
   and it carries the figures you need to reason with. CHECK IT FIRST, ALWAYS.

2. Then SEARCH for the rest, because that table will never hold everything. A
   concert at the National Stadium, a convention at Marina Bay Sands, a street
   festival two roads away, a competitor opening down the road — none of that is
   in any database of ours and all of it can move a Thursday.

HOW TO SEARCH IT WITHOUT WASTING IT. The weekly run searched a race weekend once
and read fourteen pages, quoting none of them. Ask a NARROW question about a
SPECIFIC window — "what is on in Singapore on 10 October 2026" rather than
"Singapore F1" — and stop when you have an answer. Report what you found as a
short list: what, where, roughly when in the evening, the ticket price if you
saw one, and the source. If you searched and found nothing, say so rather than
going quiet — silence reads as "nothing is on", and it means "I did not look".

NEVER state a ticket price, a date or an attendance figure you did not read in
this conversation. The demographic READ is yours to make; the numbers it rests
on are not.

WEIGH IT ON FIVE THINGS AND SAY WHICH WAY EACH CUTS. A clash and an opportunity
look identical on a calendar, and the difference decides whether you argue about
the date or change the whole approach.

- PROXIMITY. Marina Bay reaches Telok Ayer and Craig Road. Jurong does not.
- HOUR. When does it take people, and when does it give them back? Doors at 9pm
  means everybody there eats at 7. A 7.30 show means they do not.
- PRICE, WHICH IS THE DEMOGRAPHIC. What the other thing costs tells you who is
  at it. A party at $850 a head and a street festival at $20 pull different
  people out of different rooms, and only one of them was ever going to be at
  your table.
- SCALE. Sixty thousand people change a city. Three hundred change a street.
- DIRECTION. Does it pull people AWAY from your area or INTO it? A stadium
  concert empties the CBD. A festival on your own street fills it with people
  who have to eat somewhere.

WHAT YOU CANNOT SEE, AND MUST SAY SO. Nobody is tracking what other venues
programme. A guest shift at a bar two streets away, a collaboration dinner, a
takeover — those are announced on Instagram a week or two out and there is no
feed of them in this system. So when you have checked the calendar and searched
the city, say plainly that the one thing you could NOT check is what comparable
venues are running that night, and that it is a real gap rather than a clear
diary. Suggest looking at the handful of rooms that actually compete for the
same guest, by name if the planner has named them.

Then give a verdict in one line — CLASH, OPPORTUNITY or IRRELEVANT — and say
what it changes. A clash is an argument about the date. An opportunity is a
different approach: an earlier seating, a shorter menu, a different audience, a
pre-party proposition rather than a destination one. Irrelevant is a real answer
and should be said rather than implied by silence.

AND SAY WHEN YOU ARE INFERRING. "At $850 a head from 9pm that room is not
choosing between Amber Lounge and a $180 dinner — they are doing both, and the
dinner is at 7" is a reading, not a fact. Mark it as one. A confident invented
audience is the worst thing this surface can produce, because nobody can check
it and it sounds exactly like the useful version.

CHECK WHAT WE HAVE DONE BEFORE. query_events finds comparable events by shared
attributes — occasion, venue, concept, partner, format, audience — and for a
shared occasion it finds the previous one at any distance. Read shared_attributes
before citing one: occasion plus venue plus partner is a precedent, format alone
is barely a relation. AND THE STORE IS NEW: it began in September 2026 and was
not backfilled, so "no record" means no record. Never say "this has not been
tried here" — that is a claim about the business, and you would be making it
from an absence of data.

THE DECISIONS
${renderPlaybook(PLAYBOOK)}

WHEN IT IS READY
Say so, summarise what is settled, and call record_event_draft. The person then
sees the draft and confirms it — you do not write anything to the database and
must never say that you have. Say you have prepared the brief for them to
confirm.

WHEN IT IS NOT READY
Name the blocking decisions that are still open, in one short list, and say what
you need for each. Do not call record_event_draft.`;

/**
 * The forced tool that ends a settled conversation.
 *
 * Shaped like `record_recommendations`: the analytical pass writes naturally
 * and a separate forced call turns it into records, because asking one model to
 * end an argument with JSON produces worse arguments and worse JSON.
 *
 * WHAT IT DOES NOT DO IS WRITE. It returns a draft. The app renders it, a person
 * confirms, and the app posts it. See the header.
 */
export function eventDraftTool() {
  return {
    name: 'record_event_draft',
    description:
      'Prepare the event brief for the person to confirm. Call this ONLY when every blocking decision is settled. ' +
      'It does NOT save anything — it produces a draft the person reviews and confirms, and you must not tell them the event has been created. ' +
      'Every figure in it must have come from a query tool during this conversation. Do not invent a baseline, a venue average or a lead time to fill a field: leave it out and say which decision is still open instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'What the event is called.' },
        start_date: { type: 'string', description: 'First day, YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'Last day, YYYY-MM-DD. Same as start_date for one night.' },
        venue_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Venues this runs at. MORE THAN ONE ONLY IF THE MECHANIC BREAKS WITHOUT THEM — a shared occasion across three venues is three events, not one.',
        },
        occasion: { type: 'string', description: 'The calendar day, if any: "Valentine\'s Day", "Deepavali", "CNY". Spell it the way previous events spelled it — query_events shows what is already in use — or the year-on-year comparison will never match.' },
        concept_type: { type: 'string', description: '"guest-chef collab", "tasting", "brunch", "party", "launch".' },
        partner: { type: 'string', description: 'Guest chef, brand or collaborator.' },
        format: { type: 'string', description: '"set menu", "a la carte", "ticketed".' },
        demographic: { type: 'string', description: 'Who it is for, in the planner\'s own words.' },

        concept: { type: 'string', description: 'What it actually is, in prose. Creative — no numbers required.' },
        usp: { type: 'string', description: 'What makes this one different from the last. Prose.' },
        venue_fit: { type: 'string', description: 'Why this venue rather than another. Prose.' },

        target_net_sales: { type: 'number', description: 'The revenue target. Must have a baseline beside it.' },
        target_covers: { type: 'number' },
        target_spend_per_head: { type: 'number' },
        baseline_net_sales: { type: 'number', description: 'What the venue normally does on that night — from a query tool, never estimated.' },
        baseline_covers: { type: 'number' },
        baseline_spend_per_head: { type: 'number' },
        baseline_basis: { type: 'string', description: 'Where the baseline came from, in words: "median Thu-Fri pair, last 8 weeks".' },

        price: { type: 'number' },
        price_basis_food_avg: { type: 'number', description: 'The venue\'s food average when the price was set. From query_sales.' },
        price_basis_bev_avg: { type: 'number', description: 'The venue\'s beverage average. SEPARATELY — never a blended figure.' },

        cost_lines: {
          type: 'array',
          description: 'Every cost. Ingredients, partner fee and travel, extra labour, print, décor, comped covers, and the ad budget.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              amount: { type: 'number' },
            },
            required: ['label', 'amount'],
          },
        },
        cost_total: { type: 'number' },
        break_even_covers: { type: 'number', description: 'The cover count where it washes its face.' },
        ad_budget: { type: 'number' },
        ad_plan: { type: 'string', description: 'What the paid spend buys, on which platform, over which dates.' },

        tasks: {
          type: 'array',
          description: 'The content and outreach schedule. EVERY ITEM HAS A DATE — a post without one is an intention, not a plan — and every item has an owner.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['content', 'outreach', 'ops', 'other'] },
              description: { type: 'string', description: '"Reel: the dish being plated", "Call VIPs who booked the last collab".' },
              channel: { type: 'string', description: 'Format for content, channel for outreach: reel, carousel, story, phone, whatsapp, email.' },
              t_minus_days: { type: 'number', description: 'Days before the event. 14 means a fortnight out, 0 is the day itself.' },
              owner_name: { type: 'string', description: 'A person. "The team" is not an owner.' },
            },
            required: ['kind', 'description', 't_minus_days', 'owner_name'],
          },
        },

        city_events_found: {
          type: 'array',
          description:
            'Anything you found happening in Singapore around these dates that was NOT already in query_city_events. This is how that calendar fills: nobody can maintain it by hand, so what you discover while planning is offered back and a person confirms it, and the next planner does not have to search for it again. Include ONLY things you actually read in a source during this conversation — never something you remember. Leave it out entirely if you found nothing new.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              start_date: { type: 'string', description: 'YYYY-MM-DD.' },
              end_date: { type: 'string', description: 'YYYY-MM-DD. Same as start for one day.' },
              category: { type: 'string', enum: ['sport', 'festival', 'concert', 'nightlife', 'conference', 'other'] },
              location: { type: 'string', description: 'Where in the city. Proximity is half the judgement.' },
              ticket_price_low: { type: 'number', description: 'Only if you read it. Omit rather than guess — this figure becomes the demographic read for everyone after you.' },
              ticket_price_high: { type: 'number' },
              audience: { type: 'string', description: 'Who goes, as the source described them or as the price implies. Say which.' },
              source_url: { type: 'string', description: 'Where you read it. Required — an unsourced row is worse than no row.' },
            },
            required: ['name', 'start_date', 'end_date', 'source_url'],
          },
        },
        abort_condition: { type: 'string', description: 'The book needed, the date it is checked, and what happens if it is not there.' },
        brief: { type: 'string', description: 'The brief itself, in markdown — what every stakeholder reads. Lead with what this is and what success looks like; put the schedule in a table.' },
      },
      required: ['name', 'start_date', 'end_date', 'venue_slugs', 'brief'],
    },
  };
}

/** Blocking decisions, for the app to show what is still open. */
export function openDecisions(settled: string[]): string[] {
  const done = new Set(settled);
  return blockingRows().map(r => r.key).filter(k => !done.has(k));
}
