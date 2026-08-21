import { test } from 'node:test';
import assert from 'node:assert';
import {
  webSearchTool,
  extractSources,
  searchErrors,
  searchRequestCount,
  MAX_SEARCHES_PER_REQUEST,
  WEB_SEARCH_TOOL_TYPE,
  EXTERNAL_CONTEXT_FRAMING,
  isWebSearchConfigError,
  joinText,
  mergeSources,
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
  assert.equal(tool.user_location?.timezone, 'Asia/Singapore');
});

test('allowed_domains is not set — it is the benchmarks guardrail, not this one', () => {
  // Setting it here would silently narrow every holiday and local-event
  // search, which is most of what this tool is for.
  assert.equal(webSearchTool().allowed_domains, undefined);
});

test('the framing REQUIRES a search, it does not merely permit one', () => {
  // The first version described what web search was for and never said when it
  // must be used. Asked for Singapore's 2026 public holidays, the model
  // answered from memory and got the two moon-sighting dates wrong while
  // citing MOM in prose it had never read. Anthropic's guidance is that search
  // triggering has to be instructed explicitly on these models.
  assert.match(EXTERNAL_CONTEXT_FRAMING, /MUST SEARCH THE WEB BEFORE STATING ANY FACT/);
  assert.match(EXTERNAL_CONTEXT_FRAMING, /not answer such a question from memory/);
  assert.match(EXTERNAL_CONTEXT_FRAMING, /unverified/);
});

test('the framing still forbids mixing external and warehouse figures', () => {
  assert.match(EXTERNAL_CONTEXT_FRAMING, /Never do arithmetic that mixes the two/);
  assert.match(EXTERNAL_CONTEXT_FRAMING, /EXTERNAL context only/);
});

test('sources come from citations, with title and quote intact', () => {
  const sources = extractSources([
    textWithCitations([webCite('https://example.com/a', 'Survey 2026', 'food cost averaged 30.1%')]),
  ] as any);

  assert.deepEqual(sources, [{
    url: 'https://example.com/a',
    title: 'Survey 2026',
    quotes: ['food cost averaged 30.1%'],
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
  assert.deepEqual(sources[0].quotes, ['averaged 30.1%']);
});

test('two quotes from one page are ONE source with two quotes', () => {
  // The link collapses, the evidence does not. A weather answer cited the same
  // government forecast seven times and rendered the link seven times -- but
  // merging the quotes as well would leave one passage standing behind a claim
  // it does not support.
  const sources = extractSources([
    textWithCitations([
      webCite('https://example.com/a', 'Survey', 'food cost averaged 30.1%'),
      webCite('https://example.com/a', 'Survey', 'labour cost averaged 28.4%'),
    ]),
  ] as any);

  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].quotes, ['food cost averaged 30.1%', 'labour cost averaged 28.4%']);
});

test('two different pages stay two sources', () => {
  const sources = extractSources([
    textWithCitations([
      webCite('https://example.com/a', 'A', 'one'),
      webCite('https://example.com/b', 'B', 'two'),
    ]),
  ] as any);
  assert.equal(sources.length, 2);
});

test('mergeSources folds the same page across separate responses', () => {
  // Each tool round is its own response, and the model commonly cites the same
  // page in several of them.
  const merged = mergeSources([
    { url: 'https://example.com/a', title: 'A', quotes: ['one'] },
    { url: 'https://example.com/a', title: 'A', quotes: ['two', 'one'] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].quotes, ['one', 'two']);
});

test('a page cited once without a title keeps the title it had elsewhere', () => {
  const merged = mergeSources([
    { url: 'https://example.com/a', title: null, quotes: ['one'] },
    { url: 'https://example.com/a', title: 'The Real Title', quotes: ['two'] },
  ]);
  assert.equal(merged[0].title, 'The Real Title');
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

test('a 400 naming web_search is recognised as a tool-config error', () => {
  // The real one. country: 'SG' is a valid ISO code and was refused anyway,
  // and because the tool ships on every request it took down every question —
  // including ones that never touch the web.
  const err: any = new Error(
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.12.web_search_20260209: Country code SG is not supported."}}',
  );
  err.status = 400;
  assert.equal(isWebSearchConfigError(err), true);
});

test('a 400 about our own messages is NOT swallowed as a search problem', () => {
  // Retrying without the search tool would hide a bug of ours. Narrow on
  // purpose.
  const err: any = new Error('400 messages.3: tool_use ids were found without tool_result blocks');
  err.status = 400;
  assert.equal(isWebSearchConfigError(err), false);
});

test('a 500 or a rate limit is not a config error', () => {
  // Transient. Dropping web search for the rest of the request would turn a
  // retryable blip into a silently degraded answer.
  const overloaded: any = new Error('529 overloaded_error web_search');
  overloaded.status = 529;
  assert.equal(isWebSearchConfigError(overloaded), false);

  const rate: any = new Error('429 rate_limit_error');
  rate.status = 429;
  assert.equal(isWebSearchConfigError(rate), false);
});

test('the error object is read as well as the message', () => {
  const err: any = new Error('Request failed');
  err.status = 400;
  err.error = { error: { message: 'tools.12.web_search_20260209: Country code XX is not supported.' } };
  assert.equal(isWebSearchConfigError(err), true);
});

test('user_location carries no country code', () => {
  // 'SG' is a valid ISO 3166-1 alpha-2 code and the API refuses it. Anthropic
  // supports a subset and does not publish which, so this must not be
  // reintroduced from the spec alone.
  const loc = webSearchTool().user_location as any;
  assert.equal(loc.country, undefined);
  assert.equal(loc.city, 'Singapore');
  assert.equal(loc.timezone, 'Asia/Singapore');
});

test('citation-split blocks rejoin into continuous prose', () => {
  // The real shape. A cited span arrives as its own text block, so one
  // sentence spans three blocks. Joining with "\n" broke sentences mid-clause
  // and stranded the punctuation after a citation on its own line.
  const answer = joinText([
    { type: 'text', text: 'The one day-specific forecast I found ' },
    { type: 'text', text: 'put 20 August at a high around 31°C', citations: [] },
    { type: 'text', text: '. Broader seasonal context follows.' },
  ] as any);

  assert.equal(answer, 'The one day-specific forecast I found put 20 August at a high around 31°C. Broader seasonal context follows.');
  assert.ok(!answer.includes('\n. '), 'punctuation must not be stranded on its own line');
});

test('the model\'s own newlines survive', () => {
  // Blocks are fragments of one message; any real paragraph break is already
  // inside the text.
  assert.equal(
    joinText([{ type: 'text', text: 'Line one.\n\nLine two.' }] as any),
    'Line one.\n\nLine two.',
  );
});

test('non-text blocks are dropped from the answer', () => {
  assert.equal(
    joinText([
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
      { type: 'text', text: 'Answer.' },
    ] as any),
    'Answer.',
  );
});
