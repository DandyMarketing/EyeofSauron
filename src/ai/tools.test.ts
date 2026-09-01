import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { queryTools } from './tools.js';
import { domainOf } from './data-domains.js';

/**
 * A tool offered to the model with no handler behind it fails at RUNTIME, in
 * front of a user, having already spent a model round deciding to call it --
 * and nothing catches it before then. The two files are edited separately and
 * there was no check that they agree.
 *
 * The dispatch is read out of the source rather than exercised, because
 * `handleToolCall` needs a database and the thing worth testing is that the two
 * lists match, not that Supabase works.
 */
const HANDLER_SOURCE = readFileSync(new URL('./tool-handlers.ts', import.meta.url), 'utf8');
const DISPATCHED = new Set(
  [...HANDLER_SOURCE.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]),
);

describe('every tool the model is offered can actually be called', () => {
  test('each tool name has a case in the dispatch switch', () => {
    const missing = queryTools.map(t => t.name).filter(name => !DISPATCHED.has(name));
    assert.deepEqual(missing, [], `offered to the model with no handler: ${missing.join(', ')}`);
  });

  test('no tool is named twice', () => {
    // Two definitions with one name means the second is unreachable, and which
    // schema the model sees depends on array order.
    const names = queryTools.map(t => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('every tool declares its required inputs', () => {
    // A tool with no schema is one the model fills in freehand, and the
    // handler then reports a missing field as if the user had erred.
    for (const tool of queryTools) {
      assert.ok(tool.input_schema, `${tool.name} has no input schema`);
      assert.equal((tool.input_schema as any).type, 'object', `${tool.name} schema is not an object`);
    }
  });

  test('every tool has a description long enough to choose it by', () => {
    // The descriptions carry the caveats that keep answers honest. A short one
    // is a tool the model will reach for in the wrong situation.
    for (const tool of queryTools) {
      assert.ok((tool.description ?? '').length > 80, `${tool.name} is barely described`);
    }
  });

  test('every tool resolves to a data domain', () => {
    // Unmapped falls back to `operations`, the least guarded domain. That is
    // the intended default and this pins it: a financial tool added without a
    // TOOL_DOMAINS entry would silently be readable by staff.
    for (const tool of queryTools) {
      assert.ok(domainOf(tool.name), `${tool.name} has no domain`);
    }
  });
});

describe('query_visit_distribution is wired', () => {
  test('it exists, and steers the model off the per-month loop', () => {
    // It was added because looping query_guest_retention once per month blew
    // the tool-round ceiling and timed the request out. The description has to
    // say so, or the model will do it again.
    const tool = queryTools.find(t => t.name === 'query_visit_distribution');
    assert.ok(tool, 'query_visit_distribution is not registered');

    assert.match(tool!.description!, /once per month, stop/);
    assert.match(tool!.description!, /VISITS, NOT GUESTS/);
    assert.match(tool!.description!, /left_censored/);
  });

  test('it needs a period and nothing else', () => {
    const tool = queryTools.find(t => t.name === 'query_visit_distribution')!;
    assert.deepEqual((tool.input_schema as any).required, ['start_date', 'end_date']);
  });
});
