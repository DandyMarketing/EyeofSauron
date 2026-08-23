import { POST_CATEGORIES, POST_FLAGS, CATEGORY_KEYS, FLAG_KEYS } from './post-taxonomy.js';

/**
 * Deciding what a post is ABOUT.
 *
 * The taxonomy has existed since the categories were agreed and nothing
 * consumed it. This is the half that turns it into data: a prompt built from
 * the same definitions the schema uses, and a validator that refuses anything
 * outside them.
 *
 * WHY A VALIDATOR AND NOT JUST TRUST. A model asked for one of nine keys will
 * occasionally return a tenth that sounds reasonable -- "food", "cocktail",
 * "event" -- and a tenth key stored once is a category that exists for one post
 * and splits every count thereafter. Rejected rather than coerced: a guess at
 * which real category "event" meant would be exactly the silent wrong answer
 * this codebase keeps finding.
 */

export interface Classification {
  category: string;
  category_confidence: number;
  shows_people: boolean;
  has_call_to_action: boolean;
  is_repost: boolean;
  is_trend: boolean;
}

/**
 * The classifier's instructions, generated from the taxonomy.
 *
 * Generated rather than written out, because two copies of a taxonomy is two
 * taxonomies -- and the one that drifts is always the prose one.
 */
export function classifierPrompt(): string {
  const categories = POST_CATEGORIES
    .map(c => `- ${c.key} (${c.label}): ${c.definition}`)
    .join('\n');

  const flags = POST_FLAGS
    .map(f => `- ${f.key} (${f.label}): ${f.definition}`)
    .join('\n');

  return `You classify Instagram posts for a Singapore restaurant group so its marketing team can see what kind of content works.

Assign EXACTLY ONE category. The categories:

${categories}

Then judge each flag independently. Flags cut ACROSS categories — a trending-audio reel of a cocktail is category "drink" with is_trend true.

${flags}

Rules:
- Exactly one category, from the keys above. Never invent one. If a post genuinely sits between two, pick the dominant subject and lower your confidence.
- category_confidence is 0 to 1, and it should actually vary. A clear plate of food is 0.95. A styled shot with a cocktail half in frame and three people laughing is closer to 0.5, and saying so is more useful than a confident guess.
- "brand" is not a bin for hard posts. Use it only when the post genuinely tells a story rather than showing something. If you are unsure, pick the closest concrete subject with low confidence instead.
- Judge only what you can actually see and read. Do not infer from the venue's name or from what a restaurant usually posts.`;
}

/**
 * Turn a model response into a row, or explain why it cannot be one.
 *
 * Returns `null` with a reason rather than throwing: one unparseable post in a
 * thousand must not end a batch, and the reason has to reach the run summary or
 * it is a silent skip.
 */
export function parseClassification(
  raw: unknown,
): { ok: true; value: Classification } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'response was not an object' };
  }

  const input = raw as Record<string, unknown>;
  const category = typeof input.category === 'string' ? input.category.trim().toLowerCase() : '';

  if (!category) return { ok: false, reason: 'no category returned' };
  if (!CATEGORY_KEYS.includes(category)) {
    // Rejected, never mapped to a neighbour. A tenth key stored once splits
    // every count that follows, and guessing which real category it meant is
    // the silent wrong answer.
    return { ok: false, reason: `category "${category}" is not one of the ${CATEGORY_KEYS.length} defined keys` };
  }

  const confidence = Number(input.category_confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: `category_confidence ${input.category_confidence} is not between 0 and 1` };
  }

  const flags: Record<string, boolean> = {};
  for (const key of FLAG_KEYS) {
    const value = input[key];
    if (typeof value !== 'boolean') {
      // Not defaulted to false. "Judged absent" and "never judged" are
      // different, and collapsing them is how a flag quietly becomes a
      // majority-false column that means nothing.
      return { ok: false, reason: `flag "${key}" was ${JSON.stringify(value)}, expected true or false` };
    }
    flags[key] = value;
  }

  return {
    ok: true,
    value: {
      category,
      category_confidence: Math.round(confidence * 100) / 100,
      shows_people: flags.shows_people,
      has_call_to_action: flags.has_call_to_action,
      is_repost: flags.is_repost,
      is_trend: flags.is_trend,
    },
  };
}

/**
 * The tool the model is forced to call.
 *
 * A forced tool call rather than "reply with JSON": the schema is enforced by
 * the API rather than by hoping, and there is no prose to strip before parsing.
 */
export function classificationTool() {
  const properties: Record<string, unknown> = {
    category: {
      type: 'string',
      enum: CATEGORY_KEYS,
      description: 'Exactly one. The post\'s dominant subject.',
    },
    category_confidence: {
      type: 'number',
      description: '0 to 1. Lower it when the post genuinely sits between two categories — an honest 0.5 is more useful than a confident guess.',
    },
  };

  for (const flag of POST_FLAGS) {
    properties[flag.key] = { type: 'boolean', description: flag.definition };
  }

  return {
    name: 'classify_post',
    description: 'Record the classification of one Instagram post.',
    input_schema: {
      type: 'object' as const,
      properties,
      required: ['category', 'category_confidence', ...FLAG_KEYS],
    },
  };
}
