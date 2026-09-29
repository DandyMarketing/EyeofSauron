# The Event Playbook — v2, from Khai's brief of 29 Sep 2026

**Status: restructured, not agreed.** v1 was twelve questions for a planner to
answer. This is a different thing: a surface that interrogates a concept and
then **produces an internal brief every stakeholder works from**. The questions
are now the means, not the product.

Two marked queries are in here where I could not make out a proper noun. They
are flagged inline rather than guessed at — see **Things I need you to confirm**.

---

## Where it lives and what it emits

**Its own tab, not the Sauron chat.** Sauron answers questions about what
happened. This drives a process toward a document with owners and dates in it,
and the two do not share a shape. It reads the same warehouse and obeys the same
anti-hallucination rule; it is not the same conversation.

**The output is a concept-mechanics brief.** One document, circulated, that the
kitchen, floor, marketing and finance all work from. Not notes, not a chat
transcript — a brief with a target, a budget, a content calendar and a name
against every task.

**And the event is stored.** Dates, concept, spend, targets, and the actual
commercial outcome, mapped to the posts that promoted it. That is what makes the
*next* concept answerable: what did the last three of these do, and what is the
realistic probability this one works. Without the store, every event is planned
from memory — which is the current state.

---

## The three rules that run through every row

**1. A target must be measurable, or it is not a target.**

This is the spine. "Revenue" is not an objective — it is a word. "Revenue"
becomes an objective at *"$28,000 net across two nights, against a median
Thursday-Friday pair of $19,400"*. If an answer cannot be checked afterwards by
somebody who was not in the room, the assistant does not accept it as a target.

**Creative is explicitly exempt.** Mood, look, the story, what the room should
feel like — these must NOT be forced into numbers, and an assistant that demands
a KPI for a creative direction is worse than useless. The rule applies to
targets and commitments. It does not apply to the idea.

**2. Every financial figure is checked against the POS, never against feel.**

A price, a spend-per-head target, a break-even — each is quoted next to what this
venue actually does, pulled live from the warehouse. A number that was never
compared to the venue's own history is a wish with a dollar sign in front of it.

**3. Averages are per type, never blended.**

Food average and beverage average, separately. A blended spend per head hides
the thing that decides whether a set menu prices correctly: a venue at $95 all-in
might be $62 food and $33 drink, and an event priced off the $95 without knowing
the split will get the drinks package wrong every time.

---

## Row shape

| Field | What it holds |
|---|---|
| `key` | Machine name — `campaign_length` |
| `decision` | What must be settled, in one line |
| `exists_because` | The failure it prevents |
| `ask` | The question, in your voice |
| `weak_answers` | What a bad answer sounds like, and the challenge to it |
| `must_be_measurable` | Whether the answer has to carry a checkable number |
| `sharpen_with` | Which tool makes it concrete, and what to look for |
| `feeds_brief` | Which section of the output document this becomes |
| `blocking` | Does "unsettled" mean the brief cannot be issued |
| `applies_when` | Scale or type — so a Tuesday tasting skips partner terms |
| `portability` | `universal` or `dandy_specific` |

---

## A. The point

**1. `objective` — what is this event for, in a number?** · blocking · measurable · universal

> *Ask:* If this goes perfectly, what is different the next morning — and what is
> the number that proves it?

*Weak:* "Awareness." "Revenue." "It'll be good for the brand."
*Challenge:* **Revenue is not an answer, it is a category.** Revenue of what,
over what period, against what this venue already does on that night? One word
cannot be checked afterwards, so it cannot be a target. Name the figure and the
baseline in the same breath, or this is a party and should be costed as one.

*Sharpen with:* the venue's own median for that weekday — `query_sales`,
`explain_revenue_change`.

---

**2. `target_demographic` — who exactly is this for?** · blocking · universal

> *Ask:* Who is the person you are selling this to? Not "foodies" — who?

*Weak:* "Everyone." "Our regulars." "People who like Indian food."
*Challenge:* Without a target market there is no way to choose a channel, a
price, a time or a message, and every later question becomes a guess. The more
specific the answer, the more channels become available — and some of them are
not channels you would have thought of. This question is what makes row 12
possible.

*Why it is here and not in the campaign section:* it is not a marketing
decision. It is the decision the concept is built on.

---

**3. `audience_motivation` — why would they actually come?** · blocking · universal

> *Ask:* Put yourself in that person's week. Why do they give up a Thursday for
> this? What do they want that they are not currently getting?

*Weak:* "Because it's a great chef." "Because the food is amazing."
*Challenge:* That is why *you* would come. The guest is choosing between this
and everything else on that night, most of it cheaper and closer to home. Name
what they get here that they cannot get elsewhere that week.

---

**4. `usp_and_differentiation` — what makes this one different?** · blocking · universal

> *Ask:* What is the single thing about this event that is not true of the last
> one we did, or of the one happening down the road the same week?

*Weak:* "It's a collab." "It's a five-course menu."
*Challenge:* We have done collabs and five-course menus. If the honest answer is
that it is the same shape with a different guest, say so — that is a legitimate
event, but it should be marketed and priced as a repeat rather than as news, and
the content plan changes accordingly.

*Sharpen with:* the events store — what were the last three, and what did each
claim as its hook.

---

## B. The shape

**5. `venue_fit` — why THIS venue?** · blocking · dandy_specific

> *Ask:* Why does this concept belong at this venue rather than one of the
> others? What is it about the room, the kitchen or the guest base that makes it
> land here?

*Weak:* "The date was free." "The chef knows the GM."
*Challenge:* Three venues with genuinely different rooms, price points and guest
bases. A concept that would work equally well at any of them is a concept that
has not been designed for any of them, and it will read that way to the guest.

---

**6. `date_and_why_that_date`** · blocking · universal

> *Ask:* Why that night? Are you filling a weak one or spending a strong one?

*Weak:* "It's when the chef was free."
*Challenge:* Understandable, and it changes the plan rather than ending it. On a
strong night you are displacing covers you would have had anyway, so the event
has to beat a normal night. On a weak night a smaller result is still a win.

*Sharpen with:* `query_sales` by weekday, `query_public_holidays`,
`query_school_calendar` — a term break empties the family trade and a long
weekend moves everything.

---

**7. `competing_events` — what else is on?** · blocking · universal

> *Ask:* What else is happening in Singapore that week, and in that month, that
> takes the same people?

*Weak:* Never checked.
*Challenge:* This is the row that requires the assistant to look **outside**.
F1 weekend, a major fixture, another venue's flagship dinner, a festival, a
long weekend — any of these can halve a book and none of them is in our
warehouse. If a clash is unavoidable, the answer is not to abandon the date; it
is to decide deliberately whether to run against it or to reposition around it.

*Sharpen with:* the events store for our own diary, `query_public_holidays`,
`query_school_calendar`, and a web search for the public calendar in that
window. **A searched fact is context, never a figure** — the same rule as
everywhere else, and the search must name what it found and where.

---

**8. `product_shape` — is it a walk-in product?** · blocking · universal

> *Ask:* Set menu or à la carte? Can somebody who wanders in at 8pm have it?

*Challenge:* A set collaboration menu is not a walk-in product. If it cannot be
sold at the door, every cover has to be booked in advance, and that decides the
campaign length, the channel and the outreach — not the other way round.

*This is the 16–17 September lesson in one line.*

---

**9. `partner_terms` — what does each side owe?** · blocking when there is a partner · dandy_specific

> *Ask:* What does the partner give, what do they get, and whose audience is
> doing the work?

*Weak:* Never written down. Assumed to be mutual.
*Challenge:* A guest chef, a brand, a DJ, a distillery — each arrives with an
audience, a cost and an expectation, and the three are rarely stated together.
If they are bringing the room, the terms should reflect it; if we are, the same.
Fee, covered costs, who posts what and when, and what happens if it
underperforms.

*This is the row you flagged as possibly the most important, and I had not
drafted it because I did not know how you think about it. Here is a first
attempt to argue with.*

---

## C. The money

**10. `price_and_basis` — priced against what?** · blocking · measurable · dandy_specific

> *Ask:* What is the ticket or set price, and how does it sit against this
> venue's food average and its beverage average — separately?

*Weak:* Pricing on what feels right for the guest chef's reputation. Comparing
to a single blended spend per head.
*Challenge:* **Never price off a blended average.** Food and beverage move
differently and a set menu with a pairing is two decisions, not one. A venue at
$95 a head might be $62 food and $33 drink; an event priced off the $95 gets the
drinks package wrong every time. Quote both, from the POS, for the last eight
weeks.

*Sharpen with:* `query_sales` — `food_sales`, `beverage_sales` and `food_pct`
are returned separately, on the food-and-beverage basis, never net sales.

---

**11. `cost_build_and_breakeven` — what does it cost, and at how many covers?** · blocking · measurable · universal

> *Ask:* List every cost, then tell me the cover count where this washes its
> face.

*Weak:* Food cost only. "We'll absorb the rest."
*Challenge:* **All costs go into the price**, or the event is a marketing spend
wearing a P&L's clothes. Ingredients, the partner's fee and travel, extra
labour, printing, décor, any comped covers, and the ad budget from row 12. Then
the break-even cover count, and how it compares to what the room actually seats.
An event that breaks even at 90% occupancy is a decision, not a plan.

---

**12. `ad_spend` — what is the paid budget?** · blocking · measurable · universal

> *Ask:* What are we spending on paid promotion, on what, and what do we expect
> back from it?

*Weak:* Nothing, which is the current state — paid promotion is not being
planned or costed at all.
*Challenge:* A budget with no number is not a budget, and paid reach with no
target is a donation. Name the amount, the platform, the audience it is aimed
at, the dates it runs, and what you expect it to produce. It is a line in row 11
and it must appear there.

---

## D. The campaign

**13. `campaign_length` — how many weeks, and what is each one doing?** · blocking · measurable · universal

> *Ask:* How long is the campaign, and what job does each week do?

*Weak:* "Three weeks", given without reference to how far ahead people book here.
*Challenge:* *Measured in August:* 23.5% of bookings were made same-day and a
further 32.3% within one to three days — so roughly half a typical midweek lands
in the final 72 hours. A campaign built as though people book three weeks out is
planning for a customer this business does not have. Be honest about which weeks
build recognition and which week books the room, and do not judge week one by
bookings.

*Sharpen with:* `query_booking_lead_time`.

---

**14. `channels_and_which_one_books`** · blocking · universal

> *Ask:* Which channels, in what order, and which one do you expect to produce a
> booking rather than a view?

*Weak:* "Instagram."
*Challenge:* Reach and bookings are different things. *Measured on the collab
week:* reach spiked to 11,301 from 1,905 and website clicks totalled 78 for the
week. Reach moved; intent did not follow.

*Sharpen with:* `check_booking_channels`, and the new booking-channel
composition chart for where this venue's bookings actually come from.

---

**15. `alternative_channels` — propose the impossible** · blocking · universal

> *Ask:* Forget Instagram, email and the phone. Who else can reach these people,
> and who already has their trust?

*Weak:* The same four channels every time.
*Challenge:* **This is the row where the assistant is supposed to be
uncomfortable.** Once row 2 has named a specific audience, channels open up that
nobody lists by default: community associations, cultural societies, diplomatic
missions, chambers of commerce, alumni networks, member clubs, corporate
partners, a hotel concierge desk, a specialist retailer's mailing list, KOLs
with genuine standing in that community rather than general food influencers.

*Khai's example, and the standard to aim at:* for the Firangi Superstar
**[VIKIBANI?]** event, the target was the **[SINDHI?]** community in Singapore —
so the approach was to go to the **[Sindhi Society?]** to help carry the
marketing, and to the **[High Commission of India?]** for support. That is not a
channel anybody arrives at from "which platform should we post on".

*KOLs are named explicitly*, and the test for one is standing with the target
demographic, not follower count.

---

**16. `content_plan` — how many posts, of what, on which dates?** · blocking · measurable · universal

> *Ask:* How many posts, in what format, showing what — and give me a date for
> each one, as T-minus days from the event.

*Weak:* One reminder image a few days out. A number of posts with no schedule.
*Challenge:* **A post without a date is not a plan, it is an intention.** Every
post gets a target date before anything else moves, because those dates are what
become deadlines for the people who have to make the assets. Justify the count
too: three posts and twelve posts are different campaigns and the difference
should be reasoned, not inherited.

*And format matters as much as count. Measured:* the collab reminder image
reached 481 with 14 interactions — weakest of nine recent posts — while dish
reels in the same period reached 3,654–3,666. If the food is the draw, show the
food being made. A poster announcing a dinner is not a picture of the dinner.

*Sharpen with:* `query_post_patterns` by `media_product_type` and by category.

*Feeds:* the content calendar in the brief — one row per post, with T-minus
date, format, subject, owner.

---

**17. `direct_outreach` — who gets a message, and when?** · blocking when the product is not walk-in · universal

> *Ask:* Who are you calling? And on which days — an early awareness pass, the
> final 72 hours, or both? What is the follow-up?

*Weak:* Nobody. Or a single undated "we'll reach out to VIPs".
*Challenge:* For a set-menu event the people most likely to come are the ones
who have already come. That is a list of names, not an audience, and somebody
has to work it. **Outreach gets the same scheduling discipline as content** —
first contact, the push inside the booking window, and the follow-up on
non-responders, each with a date and an owner.

*Sharpen with:* `query_reservations` for VIPs in the window,
`query_guest_retention` / `query_guest_cohorts` for returning guests.

*Why blocking:* on 16 September this is what the briefing ended up recommending
with 24 hours left, which is the most expensive time to think of it.

---

## E. The follow-through

**18. `owners_and_deadlines`** · blocking · universal

> *Ask:* Who does each item, and by when?

*Challenge:* Name a person per item. A plan with no owner is a wish, and the
items that get dropped are always the ones nobody was named for.

*Where this goes:* eventually into monday.com — a board per event, a task per
content and outreach item, assigned. **Not in the first build.** For now the
brief carries the table and a person can move it across; the integration is a
later conversation once the shape has settled.

---

**19. `abort_condition`** · prompting · measurable · universal

> *Ask:* What does the book have to look like, on what date, for you to still be
> happy — and what do you do if it isn't there?

*Challenge:* Deciding this in advance turns a bad week into a decision instead
of a panic. The answer is rarely to cancel; it is usually to switch from
broadcast to phoning people, and that switch happens days earlier if it was
written down.

---

**20. `record_the_outcome`** · blocking at close-out · measurable · universal

> *Ask:* Once it has run — what did it actually do?

*This is no longer a nice-to-have. It is the row everything else depends on,*
because rows 1, 4 and 7 all ask the assistant to reference previous events, and
it cannot do that from nothing.

Stored per event: the concept, venue, dates, target demographic, price and its
basis, full cost build, ad spend, the targets set — and afterwards the covers,
the net sales, the spend per head split food and beverage, the channel mix that
produced the bookings, and **the posts associated with it**, so the socials can
be read against the commercial outcome rather than beside it.

That store is also what lets Sauron stop seeing an unusual Wednesday with no
idea a Michelin-starred guest chef was in the kitchen.

---

## What gets built, in what order

1. **The events table.** Everything above leans on it, and it is useful on its
   own the moment it has rows — the weekly briefing stops mistaking an event for
   a mystery.
2. **The playbook rows**, in the admin console, editable. Same shape as
   `revel_venue_keys` and `account_map`: judgement confirmed by a person.
3. **The tab** — the interrogation, and the brief it emits.
4. **monday.com**, later, once the brief's task table has proven itself.

---

## Things I need you to confirm

**Three proper nouns I could not make out**, and I would rather ask than put a
community's name in a document wrongly:

- The Firangi Superstar event name — I heard **"Vikibani"**. What is it?
- The target community — I heard **"Cindy"**. Did you mean the **Sindhi**
  community?
- **"High Council of India"** — did you mean the **High Commission of India**,
  the diplomatic mission?

**And four open decisions:**

- **Twenty rows is a lot**, and last time you asked whether twelve was too many.
  My answer is that it is only a problem if they are all asked every time —
  `applies_when` should gate them hard, so a Tuesday wine tasting sees maybe
  eight and a two-night partner collab sees all twenty. But it needs your eye.
- **Does the team bring you the brief, or does the assistant?** If a manager
  runs this and you never see it, the pushback must stand alone.
- **Who signs off the ad budget**, and is there a standing ceiling per event?
- **How far back should "previous events" reach** for the probability read —
  and is a comparable event one at the same venue, or the same *shape* anywhere
  in the group?
