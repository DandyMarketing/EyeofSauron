/**
 * The event playbook, as data the planning agent works from.
 *
 * NOT A SCRIPT, AND THAT IS THE WHOLE DESIGN. A fixed list of questions asked
 * in a fixed order is a form with a chat interface and will be abandoned in a
 * month. These are DECISIONS that have to be settled, each carrying what a weak
 * answer sounds like and what to say to it; the agent picks what to raise next
 * from what is still open and what the last answer revealed. A Tuesday wine
 * tasting and a two-night partner collab do not get the same interrogation.
 *
 * WHY IN CODE RATHER THAN A TABLE, for now. CLAUDE.md puts judgement confirmed
 * by a person into tables -- revel_venue_keys, account_map, the BOH/FOH
 * mapping -- and this will end up there. But those are data that moves with the
 * business: a new venue, a renamed account. These are product design, closer to
 * the system prompt than to a mapping, and they will be rewritten many times
 * before they are right. Versioned and reviewable beats editable while the
 * wording is still being argued over. It moves to a table when the challenges
 * stop changing every week.
 *
 * THE MEASURABILITY RULE IS THE SPINE. A target that cannot be checked
 * afterwards by somebody who was not in the room is not a target. "Revenue" is
 * a category; it becomes an objective at "$28,000 net across two nights against
 * a median Thursday-Friday pair of $19,400". But CREATIVE IS EXEMPT and the
 * flag says so per row: mood, look, the story, why it belongs in this room must
 * never be forced into a number, and an agent that demands a KPI for a creative
 * direction is worse than no agent.
 */

export type Stage = 'point' | 'shape' | 'money' | 'campaign' | 'follow_through';

export interface PlaybookRow {
  key: string;
  stage: Stage;
  /** What must be settled, in one line. */
  decision: string;
  /** The question, in Khai's voice. */
  ask: string;
  /** What a bad answer sounds like. */
  weak: string;
  /** What to say to it. This is the product. */
  challenge: string;
  /**
   * Whether the answer must carry a checkable number. False does NOT mean
   * "vague is fine" -- it means this row is creative or descriptive and forcing
   * arithmetic onto it would destroy the answer.
   */
  measurable: boolean;
  /** Query tools that make this concrete. Every FIGURE comes from one of them. */
  sharpen_with: string[];
  /** A brief cannot issue while a blocking row is unsettled. */
  blocking: boolean;
  /** When blocking is conditional, the condition in plain words. */
  blocking_when?: string;
  /**
   * When this row is worth raising at all. The agent reads it and decides --
   * a fixed subset would be another form. Absent means always.
   */
  applies_when?: string;
}

export const PLAYBOOK: PlaybookRow[] = [
  // --- A. The point -------------------------------------------------------
  {
    key: 'objective',
    stage: 'point',
    decision: 'What this event is for, expressed as a number against a baseline.',
    ask: 'If this goes perfectly, what is different the next morning — and what is the number that proves it?',
    weak: '"Awareness." "Revenue." "It will be good for the brand."',
    challenge:
      'REVENUE IS NOT AN ANSWER, IT IS A CATEGORY. Revenue of what, over what period, against what this venue already does on that night? One word cannot be checked afterwards, so it cannot be a target. Name the figure and the baseline in the same breath, or this is a party and should be costed as one.',
    measurable: true,
    sharpen_with: ['query_sales', 'explain_revenue_change'],
    blocking: true,
  },
  {
    key: 'target_demographic',
    stage: 'point',
    decision: 'Exactly who this is for.',
    ask: 'Who is the person you are selling this to? Not "foodies" — who?',
    weak: '"Everyone." "Our regulars." "People who like Indian food."',
    challenge:
      'Without a target market there is no way to choose a channel, a price, a time or a message, and every later question becomes a guess. The more specific the answer, the more channels open up — some of them ones you would never list by default. This is the question the alternative-channels answer is built on.',
    measurable: false,
    sharpen_with: ['query_guest_cohorts', 'query_visit_distribution'],
    blocking: true,
  },
  {
    key: 'audience_motivation',
    stage: 'point',
    decision: 'Why that person gives up an evening for this.',
    ask: 'Put yourself in that person\'s week. Why do they give up a Thursday for this? What do they want that they are not getting?',
    weak: '"Because it is a great chef." "Because the food is amazing."',
    challenge:
      'That is why YOU would come. The guest is choosing between this and everything else on that night, most of it cheaper and closer to home. Name what they get here that they cannot get elsewhere that week.',
    measurable: false,
    sharpen_with: [],
    blocking: true,
  },
  {
    key: 'usp_and_differentiation',
    stage: 'point',
    decision: 'What makes this one different from the last one.',
    ask: 'What is the single thing about this that is not true of the last one we did, or of the one down the road the same week?',
    weak: '"It is a collab." "It is a five-course menu."',
    challenge:
      'We have done collabs and five-course menus. If the honest answer is that it is the same shape with a different guest, say so — that is a legitimate event, but it should be marketed and priced as a repeat rather than as news, and the content plan changes accordingly.',
    measurable: false,
    sharpen_with: ['query_events'],
    blocking: true,
  },

  // --- B. The shape -------------------------------------------------------
  {
    key: 'venue_fit',
    stage: 'shape',
    decision: 'Why this concept belongs at this venue rather than another.',
    ask: 'Why does this belong here rather than at one of the others? What is it about the room, the kitchen or the guest base that makes it land?',
    weak: '"The date was free." "The chef knows the GM."',
    challenge:
      'Three venues with genuinely different rooms, price points and guest bases. A concept that would work equally well at any of them has not been designed for any of them, and it will read that way to the guest.',
    measurable: false,
    sharpen_with: [],
    blocking: true,
  },
  {
    key: 'scope',
    stage: 'shape',
    decision: 'Whether this is one event across venues or several events sharing a date.',
    ask: 'If one venue pulled out tomorrow, would the others still work?',
    weak: '"It is Valentine\'s, so it is a group event."',
    challenge:
      'THE TEST IS WHETHER THE MECHANIC BREAKS. A passport across all three, a shared voucher, a group membership launch — pull one venue and the thing stops working. That is one event. A SHARED OCCASION IS NOT A SHARED EVENT: Valentine\'s at all three is three events, a Japanese one, a Middle Eastern one and an Indian one, and forcing them into one row buries three concepts, three prices and three results under one heading. Nothing is lost by splitting them — they share the occasion, so the comparison already treats them as related.',
    measurable: false,
    sharpen_with: [],
    blocking: true,
    blocking_when: 'more than one venue is named',
    applies_when: 'more than one venue has been mentioned',
  },
  {
    key: 'date_and_why',
    stage: 'shape',
    decision: 'The date, and whether it is filling a weak night or spending a strong one.',
    ask: 'Why that night? Are you filling a weak one or spending a strong one?',
    weak: '"It is when the chef was free."',
    challenge:
      'Understandable, and it changes the plan rather than ending it. On a strong night you are displacing covers you would have had anyway, so the event has to beat a normal night. On a weak night a smaller result is still a win. Which is it?',
    measurable: true,
    sharpen_with: ['query_sales', 'query_public_holidays', 'query_school_calendar'],
    blocking: true,
  },
  {
    key: 'competing_events',
    stage: 'shape',
    decision: 'What else takes the same people that week.',
    ask: 'What else is happening in Singapore that week, and that month, that takes the same people?',
    weak: 'Never checked.',
    challenge:
      'THIS IS THE ROW THAT REQUIRES LOOKING OUTSIDE. A race weekend, a major fixture, a festival, another venue\'s flagship dinner, a long weekend — any of these can halve a book and none of them is in our warehouse. If a clash is unavoidable the answer is not to abandon the date, it is to decide deliberately whether to run against it or reposition around it.',
    measurable: false,
    sharpen_with: ['query_events', 'query_public_holidays', 'query_school_calendar'],
    blocking: true,
  },
  {
    key: 'product_shape',
    stage: 'shape',
    decision: 'Whether somebody who walks in at 8pm can buy it.',
    ask: 'Set menu or à la carte? Can somebody who wanders in at 8pm have it?',
    weak: 'Treating a set collaboration menu as though walk-ins will fill the gap.',
    challenge:
      'A set collaboration menu is not a walk-in product. If it cannot be sold at the door then every cover has to be booked in advance, and that decides the campaign length, the channel and the outreach — not the other way round. This is the 16–17 September lesson in one line.',
    measurable: false,
    sharpen_with: ['query_reservations'],
    blocking: true,
  },
  {
    key: 'partner_terms',
    stage: 'shape',
    decision: 'What each side gives, gets, and owes.',
    ask: 'What does the partner give, what do they get, and whose audience is doing the work?',
    weak: 'Never written down. Assumed to be mutual.',
    challenge:
      'A guest chef, a brand, a DJ, a distillery — each arrives with an audience, a cost and an expectation, and the three are rarely stated together. If they are bringing the room the terms should reflect it; if we are, the same. Fee, covered costs, who posts what and when, and what happens if it underperforms.',
    measurable: false,
    sharpen_with: ['query_events'],
    blocking: true,
    blocking_when: 'there is a partner',
    applies_when: 'a guest chef, brand, DJ or other partner is involved',
  },

  // --- C. The money -------------------------------------------------------
  {
    key: 'price_and_basis',
    stage: 'money',
    decision: 'The price, against this venue\'s food and beverage averages separately.',
    ask: 'What is the price, and how does it sit against this venue\'s food average and its beverage average — separately?',
    weak: 'Pricing on what feels right for the guest chef\'s reputation. Comparing against a single blended spend per head.',
    challenge:
      'NEVER PRICE OFF A BLENDED AVERAGE. Food and beverage move differently and a set menu with a pairing is two decisions, not one. A venue at $95 a head might be $62 food and $33 drink; an event priced off the $95 gets the drinks package wrong every time. Quote both, from the POS, for the last eight weeks.',
    measurable: true,
    sharpen_with: ['query_sales'],
    blocking: true,
  },
  {
    key: 'cost_build_and_breakeven',
    stage: 'money',
    decision: 'Every cost, and the cover count where it washes its face.',
    ask: 'List every cost, then tell me the cover count where this washes its face.',
    weak: 'Food cost only. "We will absorb the rest."',
    challenge:
      'ALL COSTS GO INTO THE PRICE, or the event is a marketing spend wearing a P&L\'s clothes. Ingredients, the partner fee and travel, extra labour, printing, décor, comped covers, and the ad budget. Then the break-even cover count against what the room actually seats. An event that breaks even at 90% occupancy is a decision, not a plan.',
    measurable: true,
    sharpen_with: ['query_sales', 'query_labour'],
    blocking: true,
  },
  {
    key: 'ad_spend',
    stage: 'money',
    decision: 'The paid budget, what it buys, and who approved it.',
    ask: 'What are we spending on paid promotion, on what, and what do we expect back?',
    weak: 'Nothing, which is the current state — paid promotion is not being planned or costed at all.',
    challenge:
      'A budget with no number is not a budget, and paid reach with no target is a donation. Name the amount, the platform, the audience it is aimed at, the dates it runs and what you expect it to produce. It is a line in the cost build and it must appear there. Sign-off is the MARKETING MANAGER — every amount, no ceiling, so the control is that somebody owns the number.',
    measurable: true,
    sharpen_with: ['query_social_performance'],
    blocking: true,
  },

  // --- D. The campaign ----------------------------------------------------
  {
    key: 'campaign_length',
    stage: 'campaign',
    decision: 'How many weeks, and what job each one does.',
    ask: 'How long is the campaign, and what job does each week do?',
    weak: '"Three weeks", given without reference to how far ahead people book here.',
    challenge:
      'Measured in August: 23.5% of bookings were made same-day and a further 32.3% within one to three days — so roughly half a typical midweek lands in the final 72 hours. A campaign built as though people book three weeks out is planning for a customer this business does not have. Be honest about which weeks build recognition and which week books the room, and do not judge week one by bookings.',
    measurable: true,
    sharpen_with: ['query_booking_lead_time'],
    blocking: true,
  },
  {
    key: 'channels',
    stage: 'campaign',
    decision: 'Which channels, and which one is expected to produce a booking.',
    ask: 'Which channels, in what order, and which one do you expect to produce a booking rather than a view?',
    weak: '"Instagram."',
    challenge:
      'Reach and bookings are different things and one does not imply the other. Measured on the collab week: reach spiked to 11,301 from 1,905 and website clicks totalled 78 for the week. Reach moved; intent did not follow. Name the channel you expect to convert and say what you expect from each.',
    measurable: true,
    sharpen_with: ['check_booking_channels', 'create_composition_chart'],
    blocking: true,
  },
  {
    key: 'alternative_channels',
    stage: 'campaign',
    decision: 'Who else can reach this audience, beyond the usual four.',
    ask: 'Forget Instagram, email and the phone. Who else can reach these people, and who already has their trust?',
    weak: 'The same four channels every time.',
    challenge:
      'PROPOSE THE IMPOSSIBLE. This is the row where you are supposed to be uncomfortable. Once the audience is named specifically, channels open that nobody lists by default: community associations, cultural societies, diplomatic missions, chambers of commerce, alumni networks, member clubs, corporate partners, a hotel concierge desk, a specialist retailer\'s list, KOLs with genuine standing in that community rather than general food influencers. THE STANDARD TO AIM AT: for the Firangi Superstar Vicky Ratnani event the target was the Sindhi community in Singapore, so the approach was the Sindhi Society to carry the marketing and the High Commission of India for support. Nobody arrives there from "which platform should we post on".',
    measurable: false,
    sharpen_with: [],
    blocking: true,
  },
  {
    key: 'content_plan',
    stage: 'campaign',
    decision: 'How many posts, of what, each with a date.',
    ask: 'How many posts, in what format, showing what — and give me a date for each, as T-minus days from the event.',
    weak: 'One reminder image a few days out. A number of posts with no schedule.',
    challenge:
      'A POST WITHOUT A DATE IS AN INTENTION, NOT A PLAN. Every post gets a target date before anything else moves, because those dates become deadlines for the people making the assets. Justify the count too — three posts and twelve are different campaigns. And format matters as much: the collab reminder image reached 481 with 14 interactions, weakest of nine recent posts, while dish reels in the same period reached 3,654–3,666. If the food is the draw, show the food being made. A poster announcing a dinner is not a picture of the dinner.',
    measurable: true,
    sharpen_with: ['query_post_patterns', 'query_top_posts'],
    blocking: true,
  },
  {
    key: 'direct_outreach',
    stage: 'campaign',
    decision: 'Who gets a message rather than a post, and on which days.',
    ask: 'Who are you calling? And on which days — an early awareness pass, the final 72 hours, or both? What is the follow-up?',
    weak: 'Nobody. Or a single undated "we will reach out to VIPs".',
    challenge:
      'For a set-menu event the people most likely to come are the ones who have already come. That is a list of names, not an audience, and somebody has to work it. OUTREACH GETS THE SAME SCHEDULING DISCIPLINE AS CONTENT — first contact, the push inside the booking window, and the follow-up on non-responders, each with a date and an owner. On 16 September this is what the briefing ended up recommending with 24 hours left, which is the most expensive time to think of it.',
    measurable: true,
    sharpen_with: ['query_reservations', 'query_guest_retention', 'query_guest_cohorts'],
    blocking: true,
    blocking_when: 'the product is not a walk-in product',
  },

  // --- E. The follow-through ---------------------------------------------
  {
    key: 'owners_and_deadlines',
    stage: 'follow_through',
    decision: 'A name against every item.',
    ask: 'Who does each of these, and by when?',
    weak: '"The team will handle it."',
    challenge:
      'Name a person per item. A plan with no owner is a wish, and the items that get dropped are always the ones nobody was named for.',
    measurable: true,
    sharpen_with: [],
    blocking: true,
  },
  {
    key: 'abort_condition',
    stage: 'follow_through',
    decision: 'The book you need, by when, and what you do if it is not there.',
    ask: 'What does the book have to look like, on what date, for you to still be happy? And what would you do if it is not there?',
    weak: 'Never considered.',
    challenge:
      'Deciding this in advance turns a bad week into a decision instead of a panic. Set the date you check and the number you need by then. The answer is rarely to cancel — it is usually to switch from broadcast to phoning people — but that switch happens days earlier if it was written down.',
    measurable: true,
    sharpen_with: [],
    blocking: false,
  },
];

/** Rows that must be settled before a brief can issue, given what is known. */
export function blockingRows(rows: PlaybookRow[] = PLAYBOOK): PlaybookRow[] {
  return rows.filter(r => r.blocking);
}

/**
 * The playbook rendered for a system prompt.
 *
 * ORDERED BY STAGE, and the agent is told to treat that as a rough sequence
 * rather than a running order -- a plan firms up in roughly this order, but the
 * next question comes from what the last answer revealed. Rendering it as a
 * numbered list would produce a numbered interrogation.
 */
export function renderPlaybook(rows: PlaybookRow[] = PLAYBOOK): string {
  const STAGES: Array<[Stage, string]> = [
    ['point', 'THE POINT — what this is for and who for'],
    ['shape', 'THE SHAPE — what it is, where, when, with whom'],
    ['money', 'THE MONEY — price, cost, paid spend'],
    ['campaign', 'THE CAMPAIGN — how anybody hears about it'],
    ['follow_through', 'THE FOLLOW-THROUGH — owners, dates, the abort'],
  ];

  const out: string[] = [];

  for (const [stage, heading] of STAGES) {
    const inStage = rows.filter(r => r.stage === stage);
    if (inStage.length === 0) continue;

    out.push(`\n## ${heading}\n`);

    for (const r of inStage) {
      const flags = [
        r.blocking ? (r.blocking_when ? `BLOCKING when ${r.blocking_when}` : 'BLOCKING') : 'prompting',
        r.measurable ? 'answer must carry a NUMBER' : 'creative or descriptive — do NOT demand a number',
      ];

      out.push(
        `### ${r.key} — ${r.decision}\n` +
        `[${flags.join(' · ')}]\n` +
        (r.applies_when ? `Only raise this when: ${r.applies_when}\n` : '') +
        `ASK: ${r.ask}\n` +
        `WEAK ANSWER: ${r.weak}\n` +
        `CHALLENGE: ${r.challenge}\n` +
        (r.sharpen_with.length ? `GET THE FIGURES FROM: ${r.sharpen_with.join(', ')}\n` : ''),
      );
    }
  }

  return out.join('\n');
}
