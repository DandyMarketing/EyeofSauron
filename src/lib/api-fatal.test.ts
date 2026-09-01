import { test, describe } from 'node:test';
import assert from 'node:assert';
import { fatalApiReason, fatalRunSummary, isTransientCapacityError, transientReason, humanApiError } from './api-fatal.js';

/**
 * The case this exists for, copied from the run that produced it: the
 * classifier called the API 289 more times after the account had run dry, and
 * printed 289 identical lines about it.
 */
const CREDIT_ERROR = new Error(
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
);

test('an exhausted balance stops the run', () => {
  const reason = fatalApiReason(CREDIT_ERROR);
  assert.ok(reason, 'a credit error must be recognised as account-level');
  assert.match(reason!, /out of credit/i);
});

test('the message is read even when the status is not on the error', () => {
  // A caught-and-stringified error keeps only the message. That is exactly what
  // reached the classifier's problem list, so matching on text is the path that
  // has to work.
  assert.ok(fatalApiReason({ message: CREDIT_ERROR.message }));
});

test('a rejected key stops the run, by status or by message', () => {
  assert.ok(fatalApiReason({ status: 401, message: 'unauthorized' }));
  assert.ok(fatalApiReason(new Error('authentication_error: invalid x-api-key')));
});

test('a model the key may not use stops the run', () => {
  assert.ok(fatalApiReason({ status: 403, message: 'forbidden' }));
  assert.match(
    fatalApiReason(new Error('permission_error: not allowed to use claude-opus-5'))!,
    /not permitted/i,
  );
});

/**
 * The half that keeps this from being worse than the bug. Aborting a
 * thousand-post run on a transient failure trades a loud problem for a
 * needless one.
 */
test('a rate limit is NOT fatal — it recovers on the next call', () => {
  assert.equal(fatalApiReason({ status: 429, message: 'rate_limit_error: too many requests' }), null);
});

test('an overloaded API is NOT fatal', () => {
  assert.equal(fatalApiReason({ status: 529, message: 'overloaded_error' }), null);
});

test('a problem with one item is NOT fatal', () => {
  // Every one of these is about a single post, and the next post may be fine.
  assert.equal(fatalApiReason(new Error('This URL is disallowed by the website\'s robots.txt file')), null);
  assert.equal(fatalApiReason(new Error('category "cocktail" is not one of the 9 defined keys')), null);
  assert.equal(fatalApiReason(new Error('image is 6144KB, over the 4MB ceiling')), null);
  assert.equal(fatalApiReason(null), null);
  assert.equal(fatalApiReason(undefined), null);
});

test('a 400 that is not an account problem stays a per-item skip', () => {
  // 400 is the status the credit error arrives with, so status alone must not
  // be the test — or every malformed request would end the run.
  assert.equal(fatalApiReason({ status: 400, message: 'messages.0.content: field required' }), null);
});

test('the summary says what survived, what is left, and how to resume', () => {
  const text = fatalRunSummary('The Anthropic account is out of credit.', 711, 289, 'npm run classify:posts');

  assert.match(text, /711 item\(s\) were completed/);
  assert.match(text, /289 were not attempted/);
  assert.match(text, /npm run classify:posts/);
  // The reflex on a failed job is to assume the finished part must be redone.
  assert.match(text, /Nothing needs redoing/);
});

describe('transient capacity failures — the half that recovers', () => {
  /** As it actually arrived on 1 Sep 2026, raised from Stream.iterator. */
  const OVERLOADED = new Error(
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CecahFk1FfxfFLw1ja8sL"}',
  );

  test('an overload delivered inside a stream is recognised', () => {
    // The SDK cannot retry this one: shouldRetry() inspects the HTTP response,
    // and an overload raised mid-stream arrives inside a 200.
    assert.equal(isTransientCapacityError(OVERLOADED), true);
    assert.match(transientReason(OVERLOADED)!, /overloaded/i);
  });

  test('a rate limit is transient, and says which it was', () => {
    // Both recover, but only one of them means we are asking too often.
    const limited = new Error('rate_limit_error: too many requests');
    assert.match(transientReason(limited)!, /rate limited/);
  });

  test('529 and 429 by status, not only by message', () => {
    assert.equal(isTransientCapacityError({ status: 529, message: 'nope' }), true);
    assert.equal(isTransientCapacityError({ status: 429, message: 'nope' }), true);
  });

  test('an ACCOUNT problem is never treated as transient', () => {
    // Retrying an exhausted balance is a loop, not a recovery — and it would
    // undo the whole point of fatalApiReason().
    const broke = new Error('400 invalid_request_error: Your credit balance is too low');
    assert.equal(isTransientCapacityError(broke), false);
    assert.equal(transientReason(broke), null);
  });

  test('an ordinary bug is not retried', () => {
    assert.equal(isTransientCapacityError(new Error('Cannot read properties of undefined')), false);
  });

  test('the two classifications never both claim the same error', () => {
    for (const err of [OVERLOADED, new Error('credit balance is too low'), new Error('boom')]) {
      assert.ok(
        !(fatalApiReason(err) !== null && transientReason(err) !== null),
        'an error was classed as both fatal and transient',
      );
    }
  });
});

describe('humanApiError', () => {
  test('an overload becomes a sentence, not a request_id', () => {
    // What went in front of a venue manager was the raw JSON body. That tells
    // them nothing and reads as a broken product rather than a busy minute.
    const message = humanApiError(new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cec"}'));

    assert.doesNotMatch(message, /request_id|req_011|\{/);
    assert.match(message, /ask again in a moment/);
    assert.match(message, /not your question/);
  });

  test('an account problem keeps its actionable explanation', () => {
    // "Try again in a moment" would be actively wrong here.
    const message = humanApiError(new Error('credit balance is too low'));
    assert.match(message, /out of credit/);
    assert.doesNotMatch(message, /ask again in a moment/);
  });

  test('anything else passes through rather than being swallowed', () => {
    assert.match(humanApiError(new Error('some unexpected fault')), /some unexpected fault/);
  });
});
