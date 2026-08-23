import { test } from 'node:test';
import assert from 'node:assert';
import { fatalApiReason, fatalRunSummary } from './api-fatal.js';

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
