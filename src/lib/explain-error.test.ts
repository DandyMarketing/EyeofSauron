import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainIngestError, describeStatus } from './explain-error.js';

test('THE DISTINCTION THAT MATTERS: their outage vs our credentials', () => {
  /**
   * The reason this file exists. "SevenRooms auth failed: HTTP 503" and
   * "...HTTP 401" look nearly identical on screen and need opposite responses:
   * one is a thing to wait out, the other a thing to fix today. Somebody who
   * cannot tell them apart either escalates every blip or ignores a real
   * outage.
   */
  const outage = explainIngestError('SevenRooms auth failed: HTTP 503');
  assert.equal(outage?.action, 'wait');
  assert.match(outage!.plain, /their server, not our login/i);
  assert.match(outage!.plain, /SevenRooms/);

  const refused = explainIngestError('SevenRooms auth failed: HTTP 401');
  assert.equal(refused?.action, 'fix');
  assert.match(refused!.plain, /rejected our credentials/i);
  assert.match(refused!.plain, /does not fix itself/i);

  assert.notEqual(outage!.plain, refused!.plain);
});

test('a credentials failure names the cause that has actually happened here', () => {
  // A 401 from SevenRooms was once caused by a credential pasted with a newline
  // in the middle — 129 characters where 128 was expected. It presented as an
  // auth failure, which sends you looking at permissions rather than at the
  // string. BUILD_LOG keeps that as an onboarding gotcha; this puts it in front
  // of whoever is reading the error.
  const e = explainIngestError('StaffAny auth failed: HTTP 401');
  assert.match(e!.plain, /line break/i);
});

test('every 5xx and 429 reads as theirs to fix, not ours', () => {
  for (const status of [500, 502, 503, 504, 429]) {
    const e = explainIngestError(`SevenRooms auth failed: HTTP ${status}`);
    assert.ok(e, `HTTP ${status} produced no explanation`);
    assert.equal(e!.action, 'wait', `HTTP ${status} should be theirs to fix`);
  }
  // And a rate limit should not read as an outage — the cause differs.
  assert.match(explainIngestError('Metricool: HTTP 429')!.plain, /slow down/i);
});

test('the malformed CSV is explained in terms of the file, not the parser', () => {
  // The real message, from the admin console on 3 Oct 2026. "Quote Not Closed"
  // is parser vocabulary; what the reader needs is "re-send the file".
  const e = explainIngestError('Quote Not Closed: the parsing is finished with an opening quote at line 4');
  assert.equal(e?.action, 'fix');
  assert.match(e!.plain, /line 4/);
  assert.match(e!.plain, /sending again|re-?send/i);
  // And it must say nothing was loaded — a partial load would be the worse
  // outcome and the reader should know which happened.
  assert.match(e!.plain, /none of it was loaded/i);
});

test('the vendor is named when the message names one', () => {
  assert.match(explainIngestError('Xero request failed: HTTP 503')!.plain, /Xero/);
  assert.match(explainIngestError('StaffAny request failed: HTTP 503')!.plain, /StaffAny/);
  // And not invented when it does not.
  const anon = explainIngestError('request failed: HTTP 503');
  assert.match(anon!.plain, /The source system/);
});

test('a network failure is distinguished from a refusal', () => {
  for (const msg of ['fetch failed', 'ETIMEDOUT', 'ECONNRESET', 'socket hang up']) {
    const e = explainIngestError(msg);
    assert.ok(e, `${msg} produced no explanation`);
    assert.equal(e!.action, 'wait');
    assert.match(e!.plain, /could not reach/i);
  }
});

test('AN UNRECOGNISED ERROR SAYS NOTHING', () => {
  /**
   * The most important negative case. A wrong explanation is worse than none —
   * it would send somebody to check credentials that are fine. When this
   * returns null the console shows the raw message alone, which is all it ever
   * showed, so silence is never a regression.
   */
  assert.equal(explainIngestError('Something nobody has seen before'), null);
  assert.equal(explainIngestError(''), null);
  assert.equal(explainIngestError('Error: 42'), null);
});

test('no explanation is itself jargon', () => {
  // The whole point is that an operator can act on these. If one contains a
  // status code or a parser term, it has failed at its job.
  const samples = [
    'SevenRooms auth failed: HTTP 503',
    'SevenRooms auth failed: HTTP 401',
    'Quote Not Closed: the parsing is finished with an opening quote at line 4',
    'fetch failed',
  ];
  for (const msg of samples) {
    const plain = explainIngestError(msg)!.plain;
    for (const jargon of ['HTTP', 'ETIMEDOUT', 'ECONNRESET', '503', '401', 'parser', 'null', 'undefined']) {
      assert.ok(
        !plain.includes(jargon),
        `the explanation for "${msg}" contains "${jargon}" — that belongs in the raw line beside it, not here`,
      );
    }
  }
});

test('the status is said in words, and the raw value is not lost', () => {
  // `ingestion_error` is our own vocabulary, printed first on every row where
  // it is the first thing read. The plain label replaces it in the heading; the
  // raw value moves to the technical line, so nothing becomes unsearchable.
  assert.equal(describeStatus('ingestion_error'), 'Could not fetch');
  assert.equal(describeStatus('parse_error'), 'Could not read the file');
  // An unknown status is returned unchanged rather than guessed at.
  assert.equal(describeStatus('something_new'), 'something_new');
  // And no plain label is itself jargon.
  for (const s of ['ingestion_error', 'parse_error', 'validation_error', 'partial']) {
    assert.ok(!describeStatus(s).includes('_'), `${s} still reads as a code name`);
  }
});
