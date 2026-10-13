import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftStage } from './draft-stages.js';

test('the stage is the part of the brief being written now, with a count where it moves', () => {
  assert.equal(draftStage(null), null);
  assert.equal(draftStage({}), null);
  assert.equal(draftStage({ name: 'NYE' })!.label, 'Naming the event, its dates and venues');
  assert.equal(draftStage({ name: 'NYE', concept: 'A bloc party' })!.label, 'Writing the concept');
  assert.equal(draftStage({ name: 'x', target_net_sales: 30000 })!.label, 'Setting the target against a normal night');
  assert.equal(draftStage({ name: 'x', tasks: [{}, {}, {}] })!.label, 'Listing the tasks (3 so far)');
  assert.equal(draftStage({ pnl: { programming: [{}, {}], costs: [{}] } })!.label, 'Laying out the P&L (3 lines so far)');
  assert.equal(draftStage({ brief: 'word '.repeat(240) })!.label, 'Writing the brief itself (about 250 words)');
  assert.equal(draftStage({ brief: 'a b c' })!.label, 'Writing the brief itself (about 3 words)');
  assert.equal(draftStage({ something_new: 1 })!.label, 'Putting the brief together');
});
