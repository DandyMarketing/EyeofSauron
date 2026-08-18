/**
 * What a post is ABOUT -- the vocabulary, in one place.
 *
 * Single source of truth for three things that must never drift apart: the
 * prompt the classifier is given, the values the database will accept, and the
 * options the model sees on the query tool. Two copies of a taxonomy is two
 * taxonomies.
 *
 * The categories came from Khai, not from me, and the wording is his. That is
 * deliberate: a taxonomy invented by a model would be subtly wrong for three
 * brands it has never stood inside, and "activation" is what this business
 * calls the thing, so it is what the schema calls it too.
 */

export interface Category {
  key: string;
  label: string;
  /** Goes into the classifier prompt verbatim. Boundaries matter more than names. */
  definition: string;
}

/**
 * Nine, and the number is a judgement rather than a taste.
 *
 * Around 330 posts per venue over two years. Nine categories averages ~37 each,
 * comfortably above the five-post floor where a group starts meaning something.
 * Past a dozen the cells go thin and every answer becomes a hedge; below about
 * six the categories stop distinguishing anything worth acting on.
 */
export const POST_CATEGORIES: Category[] = [
  {
    key: 'dish',
    label: 'Dish',
    definition:
      'A plate of food, a food close-up, or a dish being made or explained. If a team member is showing how a dish is made, this is Dish rather than Team — the food is the subject.',
  },
  {
    key: 'drink',
    label: 'Drink',
    definition:
      'A cocktail, wine, or the bar. Same rule as Dish: a bartender explaining a build is Drink, not Team.',
  },
  {
    key: 'room',
    label: 'Room',
    definition:
      'The space itself — interior, atmosphere, the room empty or dressed. About the venue as a place rather than about the people in it.',
  },
  {
    key: 'lifestyle',
    label: 'Lifestyle',
    definition:
      'A lifestyle shot. People, mood, the feeling of being there, styled or candid — where the point is the vibe rather than a specific dish, drink or room.',
  },
  {
    key: 'team',
    label: 'Team',
    definition:
      'A team member talking or being introduced, WITH NO DISH OR DRINK INVOLVED. This boundary is strict and it is the one that keeps the category meaningful: if they are making, holding or explaining food or a drink, classify it as Dish or Drink instead.',
  },
  {
    key: 'promotion',
    label: 'Promotion',
    definition:
      'A promo — happy hour, a set menu, a discount, a price, a limited offer. Anything asking the reader to take up a deal.',
  },
  {
    key: 'activation',
    label: 'Activation',
    definition:
      'A one-off: a collaboration, a party, a guest shift, a festive night, a takeover. The business calls these activations.',
  },
  {
    key: 'news',
    label: 'News',
    definition:
      'An announcement — an award, press coverage, an opening, hiring, a milestone.',
  },
  {
    key: 'brand',
    label: 'Brand',
    definition:
      'Storytelling that is not selling anything. A concept piece, a narrative, a mood film — the shape of a brand advert that never mentions the product. Use this only when the post genuinely tells a story rather than showing something; do not use it as a bin for posts that were hard to classify.',
  },
];

export const CATEGORY_KEYS = POST_CATEGORIES.map(c => c.key);

export interface Flag {
  key: string;
  label: string;
  definition: string;
  /**
   * Whether the model should be trusted on it. A flag it cannot reliably judge
   * is still worth capturing, but must be presented as a guess.
   */
  confidence: 'reliable' | 'low';
}

/**
 * Flags cut ACROSS categories, which is why they are not categories.
 *
 * A trending-audio reel of a cocktail is a Drink post wearing a trend format.
 * Making "trend" a tenth category would delete it from the subject analysis and
 * destroy the only question worth asking about it -- whether trend-format posts
 * beat straight ones with the subject held constant.
 */
export const POST_FLAGS: Flag[] = [
  {
    key: 'shows_people',
    label: 'Shows people',
    definition: 'A human face or figure is visible. Hands alone do not count.',
    confidence: 'reliable',
  },
  {
    key: 'has_call_to_action',
    label: 'Asks for something',
    definition: 'Asks the reader to book, buy, visit, or click. A hashtag is not a call to action.',
    confidence: 'reliable',
  },
  {
    key: 'is_repost',
    label: 'Reposted',
    definition: 'Content made by a guest, creator or press and reshared, rather than shot by the venue.',
    confidence: 'reliable',
  },
  {
    key: 'is_trend',
    label: 'Follows a trend format',
    definition:
      'Uses a recognisable internet trend format — trend-native caption language ("POV:", "tell me you are X without..."), a meme template, or a viral video structure. ' +
      'MARK THIS LOW AND SAY SO IF UNSURE. Trends live largely in audio, which is not visible here, and a trend that ran after the training cutoff cannot be recognised at all. ' +
      'A wrong yes is worse than a missed one, because the whole point is to test whether trend formats work.',
    confidence: 'low',
  },
];

export const FLAG_KEYS = POST_FLAGS.map(f => f.key);
