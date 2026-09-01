import { test, describe } from 'node:test';
import assert from 'node:assert';
import { fingerprint, parseRecommendations, suppressRepeats, analysisBrief, recommendationTool, MAX_PER_RUN, RECOMMENDATION_DOMAINS, namesOtherVenues, lastCompleteWeek, unsettledWeekNote } from './recommendation.js';

const rec = (over: Partial<{ headline: string; body: string; domain: string; confidence: number }> = {}) => ({
  headline: over.headline ?? 'Move the Tuesday set menu to Wednesday',
  body: over.body ?? 'Covers on Tuesday ran at 41 against 78 on Wednesday over eight weeks.',
  domain: over.domain ?? 'covers',
  confidence: over.confidence ?? 0.8,
});

// --- fingerprint -----------------------------------------------------------

test('the same advice with a refreshed figure fingerprints the same', () => {
  // The reason numbers are stripped. Without this the engine says the same
  // thing every week, each time with a slightly different number, and the
  // suppression never fires.
  assert.equal(
    fingerprint('Beverage margin is down 4 points'),
    fingerprint('Beverage margin is down 6 points'),
  );
  assert.equal(
    fingerprint('Marketing spend rose to $26,034'),
    fingerprint('Marketing spend rose to $31,880'),
  );
});

test('word order is kept — two instructions are not one', () => {
  assert.notEqual(
    fingerprint('Move brunch to Sunday'),
    fingerprint('Move Sunday to brunch'),
  );
});

test('punctuation and casing do not create a new finding', () => {
  assert.equal(
    fingerprint('Cut the Monday roster.'),
    fingerprint('cut  the   monday roster'),
  );
});

test('different advice fingerprints differently', () => {
  assert.notEqual(
    fingerprint('Move the Tuesday set menu to Wednesday'),
    fingerprint('Raise the beverage price on the house pour'),
  );
});

// --- parseRecommendations --------------------------------------------------

test('an empty list is VALID — a quiet week is a real outcome', () => {
  const parsed = parseRecommendations({ recommendations: [] });
  assert.ok(parsed.ok);
  assert.deepEqual((parsed as any).value, []);
});

test('a well-formed recommendation parses', () => {
  const parsed = parseRecommendations({ recommendations: [rec()] });
  assert.ok(parsed.ok);
  assert.equal((parsed as any).value[0].domain, 'covers');
  assert.equal((parsed as any).value[0].confidence, 0.8);
});

test('an unknown domain is rejected, never mapped to a neighbour', () => {
  // Same rule as the post classifier: guessing which real domain "finance"
  // meant is the silent wrong answer.
  const parsed = parseRecommendations({ recommendations: [rec({ domain: 'finance' })] });
  assert.equal(parsed.ok, false);
  assert.match((parsed as any).reason, /finance/);
});

test('more than the cap is trimmed and the trim is reported', () => {
  // This asserted rejection until 1 Sep 2026, on the reasoning that silently
  // dropping ranked findings hides a model ignoring its own cap. The first
  // half was right and the remedy was wrong: Firangi Superstar returned six,
  // lost all six, and lost a twelve-minute Opus analysis with them. Keeping
  // the top three is what the cap is FOR, and `dropped` keeps the second half
  // of the original argument — the trim is still visible.
  const parsed = parseRecommendations({
    recommendations: Array.from({ length: MAX_PER_RUN + 1 }, (_, i) => rec({ headline: `Thing ${i}` })),
  });
  assert.equal(parsed.ok, true);
  assert.equal((parsed as any).value.length, MAX_PER_RUN);
  assert.equal((parsed as any).dropped, 1);
});

test('a headline with no body is rejected — advice without reasoning is a claim', () => {
  const parsed = parseRecommendations({ recommendations: [rec({ body: '   ' })] });
  assert.equal(parsed.ok, false);
  assert.match((parsed as any).reason, /has no body/);
});

test('confidence outside 0-1 is rejected', () => {
  assert.equal(parseRecommendations({ recommendations: [rec({ confidence: 1.4 })] }).ok, false);
  assert.equal(parseRecommendations({ recommendations: [rec({ confidence: -1 })] }).ok, false);
  assert.equal(parseRecommendations({ recommendations: [rec({ confidence: NaN })] }).ok, false);
});

test('a malformed response is rejected with a reason, not thrown', () => {
  assert.equal(parseRecommendations(null).ok, false);
  assert.equal(parseRecommendations({}).ok, false);
  assert.equal(parseRecommendations({ recommendations: 'none' }).ok, false);
});

// --- suppressRepeats -------------------------------------------------------

test('something said recently is suppressed even with a new number', () => {
  const { kept, suppressed } = suppressRepeats(
    [rec({ headline: 'Beverage margin is down 6 points' })],
    [fingerprint('Beverage margin is down 4 points')],
  );

  assert.equal(kept.length, 0);
  assert.equal(suppressed.length, 1);
});

test('genuinely new advice survives', () => {
  const { kept } = suppressRepeats(
    [rec({ headline: 'Raise the house pour price' })],
    [fingerprint('Beverage margin is down 4 points')],
  );
  assert.equal(kept.length, 1);
});

test('one run cannot say the same thing twice', () => {
  const { kept, suppressed } = suppressRepeats(
    [
      rec({ headline: 'Beverage margin is down 4 points' }),
      rec({ headline: 'Beverage margin is down 5 points' }),
    ],
    [],
  );

  assert.equal(kept.length, 1);
  assert.equal(suppressed.length, 1);
});

test('nothing is suppressed when there is no history', () => {
  const { kept } = suppressRepeats([rec(), rec({ headline: 'Something else entirely' })], []);
  assert.equal(kept.length, 2);
});

// --- lastCompleteWeek ------------------------------------------------------

test('run on a Monday, review the week just worked', () => {
  // 2026-08-24 is a Monday. The week that ended yesterday is 17-23 Aug.
  assert.deepEqual(lastCompleteWeek('2026-08-24'), { start: '2026-08-17', end: '2026-08-23' });
});

test('run mid-week, still review the last COMPLETE week', () => {
  // The reason it is not "the last seven days": a Wednesday run would compare
  // four trading days against seven and report a collapse every time.
  assert.deepEqual(lastCompleteWeek('2026-08-26'), { start: '2026-08-17', end: '2026-08-23' });
  assert.deepEqual(lastCompleteWeek('2026-08-23'), { start: '2026-08-10', end: '2026-08-16' });
});

test('the window is always exactly seven days, Monday to Sunday', () => {
  for (const day of ['2026-08-24', '2026-08-25', '2026-08-29', '2026-08-30', '2026-01-01', '2026-03-02']) {
    const { start, end } = lastCompleteWeek(day);
    const span = (Date.parse(end) - Date.parse(start)) / 86400000;
    assert.equal(span, 6, `${day} produced ${start}..${end}`);
    assert.equal(new Date(`${start}T00:00:00Z`).getUTCDay(), 1, `${start} should be a Monday`);
    assert.equal(new Date(`${end}T00:00:00Z`).getUTCDay(), 0, `${end} should be a Sunday`);
  }
});

test('a week spanning the new year is one week, not two part-weeks', () => {
  // 2026-01-05 is a Monday, so the week just worked ran 29 Dec to 4 Jan —
  // across the year boundary, and it must not be split or clipped at 1 Jan.
  assert.deepEqual(lastCompleteWeek('2026-01-05'), { start: '2025-12-29', end: '2026-01-04' });
});

test('a nonsense date is rejected rather than producing a nonsense week', () => {
  assert.throws(() => lastCompleteWeek('not-a-date'));
});

// --- namesOtherVenues ------------------------------------------------------

test('another venue named in the body is caught', () => {
  const found = namesOtherVenues(
    'Your food cost is 32% against Fat Prince at 28%.',
    ['Fat Prince', 'Firangi Superstar', 'Fat Prince Pte Ltd'],
  );
  assert.ok(found.includes('Fat Prince'));
});

test('a legal entity name counts as naming the venue', () => {
  // Two of the three entity names tell a reader nothing about the venue, so a
  // leak through "Potus" would not be spotted by eye.
  const found = namesOtherVenues(
    'Potus Pte Ltd is running a stronger beverage margin this quarter.',
    ['Potus Pte Ltd', '20 Craig Road Pte Ltd'],
  );
  assert.deepEqual(found, ['Potus Pte Ltd']);
});

test('an anonymised comparison passes — that is the whole point', () => {
  // CLAUDE.md's likely resolution: comparative figures yes, identity no.
  const found = namesOtherVenues(
    'Your food cost is 32%, four points above the group average and third of three.',
    ['Fat Prince', 'Firangi Superstar'],
  );
  assert.deepEqual(found, []);
});

test('matching is case-insensitive', () => {
  assert.deepEqual(
    namesOtherVenues('compared with FIRANGI SUPERSTAR', ['Firangi Superstar']),
    ['Firangi Superstar'],
  );
});

test('a very short term is ignored rather than matching everywhere', () => {
  // A two-letter venue name would otherwise match inside ordinary words and
  // suppress every recommendation ever written.
  assert.deepEqual(namesOtherVenues('the beverage margin improved', ['NP']), []);
});

// --- the brief -------------------------------------------------------------

test('the brief carries the venue, the period and permission to say nothing', () => {
  const brief = analysisBrief('Neon Pigeon', '2026-08-11', '2026-08-17', []);

  assert.match(brief, /Neon Pigeon/);
  assert.match(brief, /2026-08-11/);
  assert.match(brief, /2026-08-17/);
  // The single most important instruction in it.
  assert.match(brief, /NOTHING WORTH SAYING/);
});

test('the brief forbids naming another venue\'s figures', () => {
  // CLAUDE.md leaves open whether a manager sees other venues' numbers.
  // Comparative-only is the safe direction to be wrong in, and it has to be
  // stated in the prompt as well as enforced by the venue filter.
  const brief = analysisBrief('Fat Prince', '2026-08-11', '2026-08-17', []);
  assert.match(brief, /COMPARATIVE ONLY/);
  assert.match(brief, /may NOT name another venue's raw figures/);
});

test('what was already said is listed in the brief', () => {
  const brief = analysisBrief('Fat Prince', '2026-08-11', '2026-08-17', [
    'Move the Tuesday set menu to Wednesday',
  ]);
  assert.match(brief, /Move the Tuesday set menu to Wednesday/);
  assert.match(brief, /MATERIALLY changed/);
});

// --- the tool --------------------------------------------------------------

test('the tool enumerates exactly the defined domains', () => {
  const tool = recommendationTool() as any;
  const domains = tool.input_schema.properties.recommendations.items.properties.domain.enum;
  assert.deepEqual(domains, [...RECOMMENDATION_DOMAINS]);
});

test('the tool caps the array and permits an empty one', () => {
  const tool = recommendationTool() as any;
  const list = tool.input_schema.properties.recommendations;

  assert.equal(list.maxItems, MAX_PER_RUN);
  // No minItems: an empty list is the engine saying the week was quiet.
  assert.equal(list.minItems, undefined);
});

// --- settled figures -------------------------------------------------------

test('a settled week says nothing — no alerts, no note', () => {
  assert.equal(unsettledWeekNote([]), null);
});

test('an unsettled week names the days and the reason', () => {
  // The Tuesday schedule assumes Finance closed on Monday. This is the check
  // behind that assumption, and reconciliation_alerts has always had the data.
  const note = unsettledWeekNote([
    { alert_type: 'post_lock_change', business_date: '2026-08-19' },
    { alert_type: 'post_lock_change', business_date: '2026-08-19' },
    { alert_type: 'mismatch', business_date: '2026-08-22' },
  ])!;

  assert.match(note, /HAVE NOT SETTLED/);
  assert.match(note, /3 unresolved/);
  assert.match(note, /2 day\(s\)/);          // deduplicated: 19th twice is one day
  assert.match(note, /2026-08-19, 2026-08-22/);
  assert.match(note, /post-lock change/);
});

test('a mismatch alone does not claim a post-lock change', () => {
  const note = unsettledWeekNote([{ alert_type: 'mismatch', business_date: '2026-08-20' }])!;
  assert.ok(!/post-lock change/.test(note));
});

test('the brief states which P&L month is settled', () => {
  // The first real run quoted July's operating profit as fact and was right
  // only because it fell after 15 August.
  const brief = analysisBrief('Neon Pigeon', '2026-08-17', '2026-08-23', [], {
    latestClosedMonth: '2026-07-01',
  });

  assert.match(brief, /LATEST SETTLED P&L MONTH IS 2026-07-01/);
  assert.match(brief, /PROVISIONAL/);
});

test('warnings reach the brief', () => {
  const brief = analysisBrief('Fat Prince', '2026-08-17', '2026-08-23', [], {
    warnings: ['THE FIGURES FOR THIS WEEK HAVE NOT SETTLED.'],
  });
  assert.match(brief, /HAVE NOT SETTLED/);
});

test('with no options the brief is unchanged — neither section appears', () => {
  const brief = analysisBrief('Fat Prince', '2026-08-17', '2026-08-23', []);
  assert.ok(!/SETTLED P&L MONTH/.test(brief));
  assert.ok(!/HAVE NOT SETTLED/.test(brief));
});

test('what was already said still reaches the brief alongside the new sections', () => {
  // Regression: the sections were appended where alreadySaid used to be.
  const brief = analysisBrief('Fat Prince', '2026-08-17', '2026-08-23', ['Cut the Monday roster'], {
    latestClosedMonth: '2026-07-01',
  });

  assert.match(brief, /Cut the Monday roster/);
  assert.match(brief, /LATEST SETTLED P&L MONTH/);
});

describe('the cap trims rather than discards', () => {
  const rec = (n: number) => ({
    headline: `Do thing ${n}`,
    body: `Because of figure ${n}.`,
    domain: 'sales',
    confidence: 0.6,
  });

  test('six against a cap of three keeps the top three', () => {
    // Firangi Superstar returned six on 1 Sep 2026 and lost all six, along
    // with a twelve-minute Opus analysis. The tool says "most important
    // first", so the top three is what the cap was always for.
    const parsed = parseRecommendations({ recommendations: [1, 2, 3, 4, 5, 6].map(rec) });

    assert.ok(parsed.ok);
    assert.equal(parsed.value.length, MAX_PER_RUN);
    assert.deepEqual(parsed.value.map(r => r.headline), ['Do thing 1', 'Do thing 2', 'Do thing 3']);
  });

  test('the trim is reported, never silent', () => {
    // A silent trim makes a model that ignores its own maxItems look identical
    // to one that obeys it.
    const parsed = parseRecommendations({ recommendations: [1, 2, 3, 4, 5, 6].map(rec) });
    assert.ok(parsed.ok);
    assert.equal(parsed.dropped, 3);
  });

  test('a list within the cap reports no drop at all', () => {
    const parsed = parseRecommendations({ recommendations: [rec(1), rec(2)] });
    assert.ok(parsed.ok);
    assert.equal(parsed.dropped, undefined);
  });

  test('an empty list is still valid and still not a drop', () => {
    // A quiet week is a real outcome, not a failure.
    const parsed = parseRecommendations({ recommendations: [] });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value, []);
    assert.equal(parsed.dropped, undefined);
  });

  test('trimming does not rescue a malformed entry inside the kept three', () => {
    // The cap is the ONLY thing repaired. A recommendation with no headline is
    // still a rejection, because that would be guessing at meaning.
    const parsed = parseRecommendations({
      recommendations: [rec(1), { ...rec(2), headline: '' }, rec(3), rec(4)],
    });
    assert.equal(parsed.ok, false);
  });
});
