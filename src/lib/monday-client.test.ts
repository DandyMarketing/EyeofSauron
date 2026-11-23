import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupWithItems, MENTIONS_API, type BoardForPlan } from './monday-client.js';

/**
 * Monday, faked at fetch: the 23 Nov 2026 NYE send made every sub-item and
 * none of their notes, because create_update refused `mentions_list` under the
 * old API version. These pin the two repairs: the tagged note is asked for on
 * MENTIONS_API and falls back to an untagged note, and a repeat send posts the
 * note on a sub-item already there with NO update -- never on one that has one.
 */
function fakeMonday(opts: { refuseTags: boolean; updatesOn: Record<string, number> }) {
  const calls: Array<{ query: string; vars: any; version: string }> = [];
  let nextId = 1000;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    const version = init.headers['API-Version'];
    calls.push({ query, vars: variables, version });
    const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (/create_subitem/.test(query)) return reply({ data: { create_subitem: { id: String(nextId++) } } });
    if (/create_update/.test(query) && /mentions_list/.test(query)) {
      return opts.refuseTags
        ? reply({ errors: [{ message: 'Unknown argument "mentions_list" on field "Mutation.create_update".' }] })
        : reply({ data: { create_update: { id: 'u' + nextId++ } } });
    }
    if (/create_update/.test(query)) return reply({ data: { create_update: { id: 'u' + nextId++ } } });
    if (/updates\(limit: 1\)/.test(query)) {
      return reply({ data: { items: (variables.i as string[]).map(id => ({ id, updates: Array.from({ length: opts.updatesOn[id] ?? 0 }, (_, k) => ({ id: 'x' + k })) })) } });
    }
    return reply({ errors: [{ message: 'unexpected query: ' + query.slice(0, 60) }] });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const cols = { deadline: null, owner: null, assigned: null, status: null, statusLabel: null, doneLabels: [] } as any;
const board = {
  id: 'b1', name: 'NP activations', workspace_id: '5127390', columns: cols,
  groups: [], template: [], templateGroup: null, history: new Map(), subscribers: [], permissions: 'everyone',
  groupItems: new Map(), subBoardId: 'sb1', subColumns: cols,
} as unknown as BoardForPlan;

const existing = {
  groupId: 'g1', names: ['Marketing plan'], lastId: 'p1',
  items: [{ id: 'p1', name: 'Marketing plan', deadline: null, owner_ids: [], assigned_ids: [], status: null,
    subitems: [
      { id: 's-bare', name: 'Book the DJ', deadline: null, owner_ids: [], assigned_ids: [], status: null },
      { id: 's-noted', name: 'Print menus', deadline: null, owner_ids: [], assigned_ids: [], status: null },
    ] }],
};
const sub = (name: string) => ({ name, deadline: '2026-12-01', owner_ids: [7], assigned_ids: [8], parent: 'Marketing plan', detail: 'Full text of ' + name, aliases: [] });

test('a refused tag still posts the note, untagged, and says so once', async () => {
  process.env.MONDAY_API_TOKEN = 'test';
  const m = fakeMonday({ refuseTags: true, updatesOn: {} });
  try {
    const r = await createGroupWithItems(board, '26-1231 NYE', [sub('Request key visual'), sub('Book photographer')], existing);
    assert.equal(r.created, 2);
    const tagged = m.calls.filter(c => /mentions_list/.test(c.query));
    assert.equal(tagged.length, 1, 'tags are tried once, then not asked again');
    assert.equal(tagged[0]!.version, MENTIONS_API);
    const plain = m.calls.filter(c => /create_update/.test(c.query) && !/mentions_list/.test(c.query));
    assert.equal(plain.length, 2, 'both notes posted');
    assert.equal(r.notes.filter(n => /detail note was not posted/.test(n)).length, 0);
    assert.equal(r.notes.filter(n => /without tagging people/.test(n)).length, 1);
  } finally { m.restore(); }
});

test('accepted tags are sent on the newer API version', async () => {
  const m = fakeMonday({ refuseTags: false, updatesOn: {} });
  try {
    const r = await createGroupWithItems(board, '26-1231 NYE', [sub('Request key visual')], existing);
    const tagged = m.calls.filter(c => /mentions_list/.test(c.query));
    assert.equal(tagged.length, 1);
    assert.deepEqual(tagged[0]!.vars.m, [{ id: '7', type: 'User' }, { id: '8', type: 'User' }]);
    assert.equal(r.notes.length, 0);
  } finally { m.restore(); }
});

test('sending again posts the missing note on a bare sub-item, never on one with an update', async () => {
  const m = fakeMonday({ refuseTags: false, updatesOn: { 's-noted': 1 } });
  try {
    const r = await createGroupWithItems(board, '26-1231 NYE', [sub('Book the DJ'), sub('Print menus')], existing);
    assert.equal(r.created, 0);
    assert.equal(r.skipped, 2);
    const posted = m.calls.filter(c => /create_update/.test(c.query)).map(c => c.vars.i);
    assert.deepEqual(posted, ['s-bare']);
    assert.ok(r.notes.some(n => /1 task note an earlier send could not post was added/.test(n)));
  } finally { m.restore(); }
});
