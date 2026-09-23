import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseMoeCalendar,
  splitLevel,
  overlapDays,
  holidayCoverage,
  INGESTED_CATEGORIES,
  type CalendarEvent,
} from './school-calendar.js';

/**
 * The two things that can go wrong here are a parser that reads the page and
 * gets it subtly wrong, and a day count that double-counts a break MOE
 * publishes twice. Both produce a plausible number, which is why they are
 * tested rather than eyeballed.
 */

/** A row in the shape moe.gov.sg/calendar actually serves. */
const row = (start: string, end: string | null, title: string, type: string) =>
  `<tr class="fc-list-item event-class cal-#388cff id-class-${start}-${end}" data-start="${start}"` +
  (end ? ` data-end="${end}"` : '') +
  ` style="--event-color:#388cff"><style>.x{}</style>` +
  `<td class="fc-list-item-marker fc-widget-content"><span class="fc-event-dot"></span></td>` +
  `<h2 class="event-l-title">${title}</h2>` +
  `<p class="event-l-date">prose date that must be ignored</p>` +
  `<div class="eventWrapper"><div class="event-l-type" style="--event-color:#388cff">${type}</div>` +
  `<button class="data_download event-ics-btn" disabled=""> Save event</button></div></tr>`;

const PAGE =
  '<table class="fc-list-table"><tbody>' +
  row('2026-01-01', null, "New Year&#x27;s Day", 'Public holidays') +
  row('2026-01-02', '2026-03-13', 'Term 1 (MK, Primary &amp; Secondary)', 'School terms') +
  row('2026-03-14', '2026-03-22', 'Term 1 school holidays (MK, Primary &amp; Secondary)', 'School holidays') +
  row('2026-03-14', '2026-03-22', 'Term 1 school holidays (Post-secondary)', 'School holidays') +
  row('2026-07-06', null, 'School Holiday for Youth Day', 'School holidays') +
  row('2026-02-06', null, 'GIRO deduction - School bill', 'GIRO deductions') +
  row('2026-07-13', '2026-10-13', 'GCE N(A)- and N(T)&#8212;Oral, Listening Comprehension', 'National exams') +
  '</tbody></table>';

test('it reads the ISO attributes and never the prose date', () => {
  const { events } = parseMoeCalendar(PAGE);
  const term = events.find(e => e.name === 'Term 1')!;

  assert.equal(term.start_date, '2026-01-02');
  assert.equal(term.end_date, '2026-03-13');
  assert.equal(term.level, 'MK, Primary & Secondary');
  assert.equal(term.category, 'School terms');
});

test('a single-day event gets end == start, not a null', () => {
  // One shape for every consumer: an overlap test never special-cases.
  const { events } = parseMoeCalendar(PAGE);
  const youth = events.find(e => e.name === 'School Holiday for Youth Day')!;
  assert.equal(youth.start_date, '2026-07-06');
  assert.equal(youth.end_date, '2026-07-06');
  assert.equal(youth.level, null);
});

test('it returns the categories it did not want, so a filter cannot hide a broken parse', () => {
  // An empty list after filtering and a page that changed shape look identical
  // unless the parser says what it saw.
  const { events, categories } = parseMoeCalendar(PAGE);
  assert.equal(events.length, 7);
  assert.equal(categories['GIRO deductions'], 1);
  assert.equal(categories['Public holidays'], 1);
  assert.equal(categories['School holidays'], 3);
});

test('public holidays are NOT among the categories we ingest', () => {
  // public_holidays already holds these from MOM, the gazetting authority.
  // Two sources for one fact is the failure this codebase keeps finding.
  assert.ok(!INGESTED_CATEGORIES.includes('Public holidays'));
  assert.ok(!INGESTED_CATEGORIES.includes('GIRO deductions'));
  assert.ok(!INGESTED_CATEGORIES.includes('National exams'));
});

test('a parse of something that is not the calendar returns nothing rather than guessing', () => {
  const { events } = parseMoeCalendar('<html><body><p>Service unavailable</p></body></html>');
  assert.equal(events.length, 0);
});

test('only a TRAILING parenthetical is a level', () => {
  // "GCE N(A)- and N(T)" would otherwise yield a level of "A".
  assert.deepEqual(splitLevel('Term 1 (MK, Primary & Secondary)'), {
    name: 'Term 1', level: 'MK, Primary & Secondary',
  });
  assert.deepEqual(splitLevel("Teachers' Day"), { name: "Teachers' Day", level: null });
  assert.deepEqual(splitLevel('GCE N(A)- and N(T) orals'), {
    name: 'GCE N(A)- and N(T) orals', level: null,
  });
  // A title that is nothing but a bracket keeps its own text rather than
  // becoming an empty name.
  assert.deepEqual(splitLevel('(Post-secondary)'), { name: '(Post-secondary)', level: null });
});

const ev = (start: string, end: string, name = 'break', level: string | null = null): CalendarEvent =>
  ({ start_date: start, end_date: end, name, category: 'School holidays', level });

test('overlap is inclusive at both ends and zero when they miss', () => {
  assert.equal(overlapDays(ev('2026-03-14', '2026-03-22'), '2026-03-16', '2026-03-22'), 7);
  assert.equal(overlapDays(ev('2026-03-14', '2026-03-22'), '2026-03-22', '2026-03-28'), 1);
  assert.equal(overlapDays(ev('2026-03-14', '2026-03-22'), '2026-03-23', '2026-03-29'), 0);
  // A single day inside the window counts as one, not zero.
  assert.equal(overlapDays(ev('2026-07-06', '2026-07-06'), '2026-07-06', '2026-07-12'), 1);
});

test('a break published twice counts ONCE', () => {
  // The bug this guards is invisible: summing the two rows would report a
  // nine-day break as eighteen days inside a seven-day week, and eighteen
  // still looks like a number.
  const week = holidayCoverage(
    [
      ev('2026-03-14', '2026-03-22', 'Term 1 school holidays', 'MK, Primary & Secondary'),
      ev('2026-03-14', '2026-03-22', 'Term 1 school holidays', 'Post-secondary'),
    ],
    '2026-03-16',
    '2026-03-22',
  );

  assert.equal(week.period_days, 7);
  assert.equal(week.days, 7);
  assert.equal(week.pct, 100);
  assert.equal(week.whole_period, true);
  // Both rows are still listed — the reader should see the levels.
  assert.equal(week.overlapping.length, 2);
});

test('overlapping breaks on different dates union rather than add', () => {
  const c = holidayCoverage(
    [ev('2026-03-14', '2026-03-18'), ev('2026-03-16', '2026-03-20')],
    '2026-03-14',
    '2026-03-20',
  );
  assert.equal(c.days, 7);
  assert.equal(c.period_days, 7);
});

test('a week in term time is zero, not missing', () => {
  const c = holidayCoverage([ev('2026-03-14', '2026-03-22')], '2026-09-14', '2026-09-20');
  assert.equal(c.days, 0);
  assert.equal(c.pct, 0);
  assert.equal(c.whole_period, false);
  assert.deepEqual(c.overlapping, []);
});

test('school TERMS never count toward holiday coverage', () => {
  // The week of 14 Sep 2026 is Term 4. If terms counted, every trading week of
  // the year would read as 100% school holiday.
  const term: CalendarEvent = {
    start_date: '2026-09-14', end_date: '2026-11-20',
    name: 'Term 4', category: 'School terms', level: 'MK, Primary & Secondary',
  };
  const c = holidayCoverage([term], '2026-09-14', '2026-09-20');
  assert.equal(c.days, 0);
});

/**
 * The back years in migration 045 are typed by hand, so the one property that
 * can catch a typo is asserted here: MOE's vacations begin the day after a term
 * ends, every time, in both years. A mistyped digit breaks the chain.
 */
test('the seeded back years chain: each vacation starts the day after a term ends', () => {
  const chain: Array<[string, string]> = [
    // 2024 — term end, vacation start
    ['2024-03-08', '2024-03-09'],
    ['2024-05-24', '2024-05-25'],
    ['2024-08-30', '2024-08-31'],
    ['2024-11-15', '2024-11-16'],
    // 2025
    ['2025-03-14', '2025-03-15'],
    ['2025-05-30', '2025-05-31'],
    ['2025-09-05', '2025-09-06'],
    ['2025-11-21', '2025-11-22'],
  ];

  for (const [termEnd, vacationStart] of chain) {
    const next = new Date(Date.parse(`${termEnd}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(next, vacationStart, `${termEnd} should be followed by ${vacationStart}`);
  }
});

test('the seeded terms end on a Friday and the vacations start on a Saturday', () => {
  // MOE's own shape, and a second independent check on the transcription: a
  // digit typo would almost certainly land on the wrong weekday.
  const termEnds = ['2024-03-08', '2024-05-24', '2024-08-30', '2024-11-15',
                    '2025-03-14', '2025-05-30', '2025-09-05', '2025-11-21'];
  for (const d of termEnds) {
    assert.equal(new Date(`${d}T00:00:00Z`).getUTCDay(), 5, `${d} should be a Friday`);
  }
});
