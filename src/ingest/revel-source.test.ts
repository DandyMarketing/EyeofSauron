import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceAfterRevel } from './revel-source.js';

test('a late Revel file joins a Monday-board day rather than being overwritten by it', () => {
  // BUILD_LOG 6.4: left as 'monday', the next board sync puts the board's
  // sales back over Revel's.
  assert.equal(sourceAfterRevel('monday'), 'both');
  assert.equal(sourceAfterRevel('both'), 'both');
  assert.equal(sourceAfterRevel('revel'), 'revel');
  assert.equal(sourceAfterRevel(null), 'revel', 'a new day');
  assert.equal(sourceAfterRevel(undefined), 'revel');
});
