# The Event Playbook — draft for Khai to argue with

**Status: a straw man.** None of this is agreed. It exists so there is something
to disagree with rather than a blank page. Every question below is my guess at
what you would ask; the ones that are wrong are the useful part.

**What this becomes.** Not a document the team reads — a table the planning
assistant reads, one row per decision, editable in the admin console. Same shape
as `revel_venue_keys`, `account_map` and the BOH/FOH mapping: judgement
confirmed by a person, never inferred. It is drafted as markdown because you
need to edit the *content*, and nobody edits content comfortably in TypeScript.

---

## The rule that makes this not a template

A fixed list of twelve questions asked in a fixed order is a form with a chat
interface, and it will be abandoned in a month.

So the playbook is **not a script**. It is a set of decisions that must be
settled, each carrying what a weak answer sounds like and what to say to it. The
assistant chooses what to ask next from what is still unsettled and what the
last answer revealed. A Tuesday wine tasting and a two-night Michelin collab do
not get the same interrogation.

Four behaviours, which matter more than the question list:

1. **One question at a time.** A director does not hand you a form. Firing six
   questions at once turns this straight back into the thing it replaces.
2. **Push back on weak answers.** This is the whole product. An assistant that
   accepts "we'll post about it" has added nothing.
3. **Permission to say the plan is not ready.** Same rule as the recommendation
   engine's permission to say nothing. One that approves every plan is wallpaper.
4. **Questions and challenges come from here; every FIGURE comes from a tool.**
   This is the first surface where the model's judgement is the product rather
   than the warehouse's data, and that is exactly where an invented lead time
   would slip in. The playbook says *check the lead time*; the number comes from
   `query_booking_lead_time` or it is not said.

---

## Row shape

| Field | What it holds |
|---|---|
| `key` | Machine name — `campaign_length` |
| `decision` | What must be settled, in one line |
| `exists_because` | The failure it prevents. Written from a real one where possible |
| `ask` | The question, in your voice |
| `weak_answers` | What a bad answer sounds like, and the challenge to it |
| `sharpen_with` | Which tool makes it concrete, and what to look for |
| `blocking` | Does "unsettled" mean the plan is not ready, or is this a prompt |
| `applies_when` | Scale or type this is relevant to — so a wine tasting skips it |
| `portability` | `universal` or `dandy_specific`, tagged from row one |

---

## The decisions

Grouped into four. Roughly the order a plan firms up, though the assistant
chooses at runtime.

### A. The point

**1. `objective` — what is this event actually for?** · blocking · universal

> *Ask:* If this goes perfectly, what is different the next morning? Pick one:
> covers on a dead night, spend per head, new guests through the door, press and
> positioning, the partner relationship, or clearing something.

*Weak:* "Awareness." "It'll be good for the brand."
*Challenge:* Awareness of what, measured how? If you cannot name the thing that
moves, this is a party and should be costed as one. Pick the one that matters
most — an event optimised for press and an event optimised for covers are
planned differently and priced differently.

*Why it is first:* Every later question is unanswerable without it. A campaign
length, a channel and a price are all downstream of what you are buying.

---

**2. `success_measure` — what number, by when, against what?** · blocking · universal

> *Ask:* What number tells you this worked, and what is the ordinary version of
> that number here?

*Weak:* "A full room." "Good engagement."
*Challenge:* Full compared to what? An ordinary Wednesday at this venue is a
known figure — name the one you are trying to beat, or you will call any outcome
a success afterwards.

*Sharpen with:* `query_daily_operations` / `query_reservations` for the venue's
own median for that weekday. The comparison is always against the venue's own
history, never another venue's.

*Measured, as an example of what this prevents:* the 16–17 September collab was
92 covers across two nights against a recent median midweek pair of around 166.
Nobody had written down what 166 was, so "92 booked" did not read as a problem
until somebody went looking 24 hours out.

---

### B. The shape

**3. `date_and_why_that_date`** · blocking · universal

> *Ask:* Why that night? Are you filling a weak one or spending a strong one?

*Weak:* "It's when the chef was free."
*Challenge:* Understandable, and it changes the plan rather than ending it. On a
strong night you are displacing covers you would have had anyway, so the event
has to beat a normal night, not fill an empty room. On a weak night a smaller
result is still a win. Which is it?

*Sharpen with:* `query_daily_operations` grouped by weekday. Also
`query_public_holidays` — a long weekend moves everything.

---

**4. `product_shape` — what is being sold, and is it a walk-in product?** · blocking · universal

> *Ask:* Set menu or à la carte? Can somebody who wanders in at 8pm have it?

*Weak:* Treating a set collaboration menu as though walk-ins will fill the gap.
*Challenge:* A two-night collaboration menu is not a walk-in product. If it
cannot be sold to somebody at the door, every cover has to be booked in advance,
and that decides the campaign length, the channel and the outreach — not the
other way round.

*This is the 16–17 September lesson in one line,* and the reason it sits above
the campaign questions rather than below them.

---

**5. `price_and_who_pays_for_it`** · blocking · dandy_specific

> *Ask:* What is spend per head meant to be, against this venue's normal? And
> where does the partner's cost sit — in the price, in marketing, or absorbed?

*Weak:* Setting the price on what feels right for the guest chef's reputation.
*Challenge:* Your three venues sit at genuinely different spend per head. An
event priced above the venue's normal has to justify it to a guest who has been
before. An event priced at cost with a partner fee on top is a marketing spend,
so say so and judge it as one.

*Sharpen with:* `query_daily_operations` for the venue's own spend per head over
the last eight weeks. Note the basis — food and beverage sales, not net sales.

---

### C. The campaign

**6. `campaign_length` — how many weeks, starting when?** · blocking · universal

> *Ask:* How long is the campaign, and what is each week doing?

*Weak:* "Three weeks." Any number given without reference to how far ahead
people actually book here.
*Challenge:* This is the question people answer with a round number and never
check. If most of your bookings arrive inside 72 hours, then the last week is
the one that books the room and the earlier weeks are building recognition — so
be honest about which weeks are doing which job, and do not judge week one by
bookings. If a run is long, it needs something new to say in each week, or it is
one message repeated until people stop seeing it.

*Sharpen with:* `query_booking_lead_time` for this venue. *Measured in August:*
23.5% of bookings were made same-day and a further 32.3% within one to three
days — so roughly half a typical midweek lands in the final 72 hours. A campaign
built as though people book three weeks out is planning for a customer this
business does not have.

---

**7. `channels_and_which_one_books`** · blocking · universal

> *Ask:* Which channels, in what order, and which one do you expect to actually
> produce a booking rather than a view?

*Weak:* "Instagram."
*Challenge:* Reach and bookings are different things and one does not imply the
other. Name the channel you expect to convert — the widget, a direct message, a
phone call, the partner's own audience — and say what you expect from each.

*Sharpen with:* `check_booking_channels` for where this venue's bookings
actually come from. *Measured on the collab week:* account reach spiked to
11,301 from 1,905 the week before and website clicks totalled 78 for the week.
Reach moved; intent did not follow. That is correlation, not proof — but it is
the shape to look for.

---

**8. `content_plan` — how many posts, of what?** · prompting · universal

> *Ask:* How many posts, in what format, showing what — and who is in them?

*Weak:* One reminder image a few days out.
*Challenge:* Format and subject both move reach here, and a promotional graphic
is the weakest combination of both. *Measured:* the collab reminder image
reached 481 people with 14 interactions — the weakest of nine recent posts —
while dish reels in the same period reached 3,654–3,666. If the food is the
draw, show the food, moving, being made. A poster announcing a dinner is not a
picture of the dinner.

*Sharpen with:* `query_post_patterns` grouped by `media_product_type` and by
category for this venue. Reels against images, dish against promotion.

---

**9. `direct_outreach` — who gets a message rather than a post?** · blocking when the product is not walk-in · universal

> *Ask:* Who are you calling? Not posting to — calling, or messaging by name.

*Weak:* Nobody. Relying entirely on broadcast.
*Challenge:* For a set-menu event the people most likely to come are the ones
who have already come: VIPs in the same week's window, guests who booked the
equivalent event last time, people who booked the peak weeks. That is a list of
names, not an audience, and somebody has to work it.

*Sharpen with:* `query_reservations` for VIP counts in the window;
`query_guest_retention` / `query_guest_cohorts` for returning guests.

*Why blocking:* on 16 September this is what the briefing ended up recommending
with 24 hours left, which is the most expensive time to think of it.

---

### D. The follow-through

**10. `owner_and_dates`** · blocking · universal

> *Ask:* Who does each of these, and by when?

*Weak:* "The team will handle it."
*Challenge:* Name a person per item. A plan with no owner is a wish, and the
items that get dropped are always the ones nobody was named for.

---

**11. `abort_condition` — what would make you pull it, and when do you look?** · prompting · universal

> *Ask:* What does the book have to look like, on what date, for you to still be
> happy? And what would you do if it isn't there?

*Weak:* Never considered.
*Challenge:* Deciding this in advance is what turns a bad week into a decision
instead of a panic. Set the date you check and the number you need by then. The
answer is rarely to cancel — it is usually to switch from broadcast to phoning
people — but that switch happens days earlier if it was written down.

---

**12. `what_gets_recorded`** · prompting · universal

> *Ask:* What do we write down afterwards so the next one is better?

*Weak:* Nothing, which is the current state.
*Challenge:* Right now an event is invisible to this system — there is no events
table, so Sauron sees an unusual Wednesday and no idea a Michelin-starred guest
chef was in the kitchen. Until that exists, every event is planned from memory.

*This is the hook for phase two:* the plan becomes the row, and the next
planning session opens with what the last three actually did.

---

## What I think is missing, and want your view on

- **Does the team bring you the plan, or does the assistant?** If a manager
  plans through this and you never see it, the pushback has to be good enough to
  stand alone. If it produces something you review, it can be lighter and the
  last question becomes "what will Khai ask about this?"
- **Is there a decision about the PARTNER?** Guest chefs, brands, DJs — what
  they owe you, what you owe them, whose audience does the work. I have not
  drafted it because I do not know how you think about it, and it may be the
  most important row here.
- **Is twelve too many?** I would rather cut three than have it feel like a
  form. My candidates for cutting are 11 and 12 — both are real, neither is
  planning.
- **Which of these are actually `dandy_specific`?** I tagged one. My instinct is
  that nearly all of the *questions* are universal and nearly all of the
  *challenges* are yours, which would be a good thing for the sell phase — but
  that is a guess.
