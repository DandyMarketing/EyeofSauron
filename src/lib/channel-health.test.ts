import { test } from 'node:test';
import assert from 'node:assert';
import {
  normaliseChannel,
  channelAlerts,
  describeAlert,
  lastCompleteMonth,
  MATERIAL_MONTHLY_BOOKINGS,
} from './channel-health.js';

/**
 * Neon Pigeon's real collapse. Google Reserve ran ~90 bookings a month, then
 * went to 5 and 1 for two months while the booking widget did the same thing.
 * Four months, several hundred lost bookings, and nothing reported it.
 */
const GOOGLE_HISTORY = [
  { month: '2024-09-01', channel: 'Google', bookings: 89 },
  { month: '2024-10-01', channel: 'Google', bookings: 101 },
  { month: '2024-11-01', channel: 'Google', bookings: 89 },
  { month: '2024-12-01', channel: 'Google', bookings: 86 },
  { month: '2025-01-01', channel: 'Google', bookings: 86 },
  { month: '2025-02-01', channel: 'Google', bookings: 43 },
  { month: '2025-03-01', channel: 'Google', bookings: 5 },
];

test('the real collapse is caught', () => {
  const [alert] = channelAlerts(GOOGLE_HISTORY, '2025-03-01');

  assert.equal(alert.channel, 'Google');
  assert.equal(alert.bookings, 5);
  assert.equal(alert.severity, 'collapsed');
  assert.ok(alert.drop_pct > 90);
});

test('it would have fired a month EARLIER, in February', () => {
  // 43 against a baseline of ~89 is already below half. Catching it in
  // February rather than June is most of the value.
  const [alert] = channelAlerts(GOOGLE_HISTORY.slice(0, 6), '2025-02-01');

  assert.equal(alert.severity, 'down');
  assert.ok(alert.drop_pct > 50);
});

test('a normal month raises nothing', () => {
  // The usual and correct outcome. A monitor that always has something to say
  // is one nobody believes.
  assert.deepEqual(channelAlerts(GOOGLE_HISTORY.slice(0, 5), '2025-01-01'), []);
});

test('the baseline is a MEDIAN, so one exceptional month cannot hide a drop', () => {
  // A festive December at triple volume would drag a mean upward and then make
  // an ordinary January look like a collapse.
  const rows = [
    { month: '2025-06-01', channel: 'Widget', bookings: 100 },
    { month: '2025-07-01', channel: 'Widget', bookings: 100 },
    { month: '2025-08-01', channel: 'Widget', bookings: 100 },
    { month: '2025-09-01', channel: 'Widget', bookings: 100 },
    { month: '2025-10-01', channel: 'Widget', bookings: 100 },
    { month: '2025-12-01', channel: 'Widget', bookings: 400 },   // the outlier
    { month: '2026-01-01', channel: 'Widget', bookings: 95 },
  ];

  // Mean baseline would be ~150, making a normal 95 look 37% down.
  assert.deepEqual(channelAlerts(rows, '2026-01-01'), []);
});

test('a small channel is ignored — alerting on it is noise', () => {
  const rows = ['2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01']
    .map(month => ({ month, channel: 'Trip Advisor', bookings: 8 }))
    .concat([{ month: '2025-12-01', channel: 'Trip Advisor', bookings: 0 }]);

  assert.deepEqual(channelAlerts(rows, '2025-12-01'), []);
  assert.ok(MATERIAL_MONTHLY_BOOKINGS > 8);
});

test('a NEW channel is not a broken one', () => {
  // Two months of history is not enough to say anything is abnormal.
  const rows = [
    { month: '2026-05-01', channel: 'Axify Integration', bookings: 46 },
    { month: '2026-06-01', channel: 'Axify Integration', bookings: 40 },
    { month: '2026-07-01', channel: 'Axify Integration', bookings: 2 },
  ];

  assert.deepEqual(channelAlerts(rows, '2026-07-01'), []);
});

test('collapses are ranked above declines, then by bookings lost', () => {
  const rows = [
    ...['2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01', '2025-11-01']
      .flatMap(month => [
        { month, channel: 'Google', bookings: 90 },
        { month, channel: 'Widget', bookings: 200 },
      ]),
    { month: '2025-12-01', channel: 'Google', bookings: 2 },    // collapsed, 88 lost
    { month: '2025-12-01', channel: 'Widget', bookings: 60 },   // down, 140 lost
  ];

  const alerts = channelAlerts(rows, '2025-12-01');
  assert.equal(alerts[0].channel, 'Google');       // collapse outranks a bigger decline
  assert.equal(alerts[1].channel, 'Widget');
});

// --- channel naming --------------------------------------------------------

test('a renamed channel is ONE channel', () => {
  // SevenRooms renamed "Google" to "Google Reserve Integration" mid-period.
  // Compared raw, the old label falls to nothing while a new one appears —
  // a channel being relabelled that reads exactly like a channel dying.
  assert.equal(normaliseChannel('Google', false), 'Google');
  assert.equal(normaliseChannel('Google Reserve Integration', false), 'Google');
});

test('widget and landing-page families fold together', () => {
  assert.equal(normaliseChannel('Booking Widget', false), 'Booking Widget');
  assert.equal(normaliseChannel('Booking widget', false), 'Booking Widget');
  assert.equal(
    normaliseChannel('Dinner at Neon Pigeon - Landing Page', false),
    'Landing Page',
  );
  assert.equal(normaliseChannel('Snack Attack - Landing Page', false), 'Landing Page');
});

test('walk-ins are decided by the flag, never by the label', () => {
  // is_walk_in is derived at ingest; the label has appeared as both
  // "Walk In" and blank.
  assert.equal(normaliseChannel('anything at all', true), 'Walk In');
  assert.equal(normaliseChannel(null, true), 'Walk In');
});

test('a staff name is left alone', () => {
  // Individually small, so the materiality floor removes them. Folding them
  // into "Staff" would need to guess what is a person, and a wrong guess
  // merges a real channel into noise.
  assert.equal(normaliseChannel('Sanaya Soonawalla', false), 'Sanaya Soonawalla');
});

test('an empty label is Unknown, not blank', () => {
  assert.equal(normaliseChannel(null, false), 'Unknown');
  assert.equal(normaliseChannel('   ', false), 'Unknown');
});

// --- month boundary --------------------------------------------------------

test('the current month is never the one checked', () => {
  // A part-month is always down on its own baseline, and an alarm that fires
  // on the 3rd of every month is dead by March.
  assert.equal(lastCompleteMonth('2026-08-26'), '2026-07-01');
  assert.equal(lastCompleteMonth('2026-08-01'), '2026-07-01');
  assert.equal(lastCompleteMonth('2026-01-15'), '2025-12-01');
});

test('a nonsense date is rejected', () => {
  assert.throws(() => lastCompleteMonth('not-a-date'));
});

// --- wording ---------------------------------------------------------------

test('a collapse points at the integration, not at the market', () => {
  const text = describeAlert({
    channel: 'Google', month: '2025-03-01', bookings: 5, baseline: 89,
    drop_pct: 94.4, severity: 'collapsed',
  });

  assert.match(text, /all but stopped/);
  assert.match(text, /integration that broke/);
  // The alternative this system has already been caught by once.
  assert.match(text, /renamed/);
});

test('a decline is reported without the integration theory', () => {
  const text = describeAlert({
    channel: 'Booking Widget', month: '2026-06-01', bookings: 60, baseline: 200,
    drop_pct: 70, severity: 'down',
  });

  assert.match(text, /down 70%/);
  assert.ok(!/integration that broke/.test(text));
});
