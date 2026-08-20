import { test } from 'node:test';
import assert from 'node:assert';
import {
  webSearchTool,
  extractSources,
  searchErrors,
  searchRequestCount,
  MAX_SEARCHES_PER_REQUEST,
  WEB_SEARCH_TOOL_TYPE,
} from './web-search.js';

/**
 * These test the reading of a response, not the searching.
 *
 * What can actually go wrong here is silent: a failed search returns HTTP 200,
 * and an answer with no citations looks exactly like an answer that needed
 * none. So the parts worth pinning are the ones that decide whether a human
 * ever finds out.
 */

const textWithCitations = (cites: any[]) => ({
  type: 'text' as const,
  text: 'Casual dining food cost sits near 30%.',
  citations: cites,
});

const webCite = (url: string, title: string | null, quote: string) => ({
  type: 'web_search_result_location',
  url,
  title,
  cited_text: quote,
  encrypted_index: 'abc123',
});

test('the tool is capped and localised to Singapore', () => {
  const tool = webSearchTool();
  assert.equal(tool.type, WEB_SEARCH_TOOL_TYPE);
  assert.equal(tool.max_uses, MAX_SEARCHES_PER_REQUEST);
  assert.equal(tool.user_location?.country, 'SG');
  assert.equal(tool.user_location?.timezone, 'Asia/Singapore');
});

test('allowed_domains is not set — it is the benchmarks guardrail, not this one', () => {
  // Setting it here would silently narrow every holiday and local-event
  // search, which is most of what this tool is for.
  assert.equal(webSearchTool().allowed_domains, undefined);
});

test('sources come from citations, with title and quote intact', () => {
  const sources = extractSources([
    textWithCitations([webCite('https://example.com/a', 'Survey 2026', 'food cost averaged 30.1%')]),
  ] as any);

  assert.deepEqual(sources, [{
    url: 'https://example.com/a',
    title: 'Survey 2026',
    quote: 'food cost averaged 30.1%',
  }]);
});

test('the same passage cited twice yields one source', () => {
  // The model cites the same sentence repeatedly across a paragraph. Six
  // identical links under an answer is noise that stops people reading any.
  const cite = webCite('https://example.com/a', 'Survey', 'averaged 30.1%');
  const sources = extractSources([
    textWithCitations([cite, cite]),
    textWithCitations([cite]),
  ] as any);

  assert.equal(sources.length, 1);
});

test('two quotes from one page are two sources', () => {
  // Same url, different claim. Collapsing these would attach one quote to a
  // second claim it does not support, which is worse than showing both.
  const sources = extractSources([
    textWithCitations([
      webCite('https://example.com/a', 'Survey', 'food cost averaged 30.1%'),
      webCite('https://example.com/a', 'Survey', 'labour cost averaged 28.4%'),
    ]),
  ] as any);

  assert.equal(sources.length, 2);
});

test('non-web citations are ignored', () => {
  const sources = extractSources([
    textWithCitations([{ type: 'char_location', document_index: 0, cited_text: 'x' }]),
  ] as any);
  assert.deepEqual(sources, []);
});

test('an answer that never searched has no sources and reports none', () => {
  assert.deepEqual(extractSources([{ type: 'text', text: 'Net sales were $5,974.' }] as any), []);
  assert.deepEqual(searchErrors([{ type: 'text', text: 'Net sales were $5,974.' }] as any), []);
});

test('a failed search is found even though the request succeeded', () => {
  const errors = searchErrors([
    { type: 'text', text: 'Let me check.' },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' },
    },
  ] as any);

  assert.deepEqual(errors, ['too_many_requests']);
});

test('a search nested inside code execution is still found', () => {
  // Dynamic filtering runs the search from inside code execution, so the
  // result block arrives nested. A scan of only the top level would report a
  // clean run while every search was failing.
  const errors = searchErrors([
    {
      type: 'code_execution_tool_result',
      content: [
        {
          type: 'web_search_tool_result',
          content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
        },
      ],
    },
  ] as any);

  assert.deepEqual(errors, ['max_uses_exceeded']);
});

test('a search that matched nothing is not an error', () => {
  // An empty result list means the search ran and found nothing. Treating it
  // as a failure would cry wolf on every obscure query.
  const errors = searchErrors([
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
  ] as any);

  assert.deepEqual(errors, []);
});

test('search count reads what was billed, and is zero when absent', () => {
  assert.equal(searchRequestCount({ server_tool_use: { web_search_requests: 3 } } as any), 3);
  assert.equal(searchRequestCount({} as any), 0);
  assert.equal(searchRequestCount(undefined), 0);
});
