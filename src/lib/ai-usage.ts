/**
 * Who asked, and what each call to the AI cost them (migration 065, Khai,
 * 22 Oct 2026). One row per CALL, written where the call is made, so nothing
 * is costed from memory afterwards and nothing goes uncounted: the engine's
 * rounds, the planner's passes, conversation titles and the scheduled jobs.
 *
 * WHO comes from a per-request scope rather than a parameter on every function
 * on the way down. The server opens a scope for each request; requireAuth
 * writes the signed-in user into it; whatever the request goes on to call reads
 * it back. A call with no scope -- the weekly recommendations, the post
 * classifier -- belongs to nobody and is reported as System.
 *
 * NEVER IN THE WAY OF AN ANSWER. Recording is fire-and-forget and a failure is
 * logged once, not thrown: losing a usage row costs a line on the admin page,
 * losing the answer would cost the person their question. Before migration 065
 * is applied every insert fails, which is the same case.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { callCost, featureOf, passOf, type CallUsage, type Feature } from './ai-pricing.js';

interface Caller { userId: string | null; feature: Feature | null }

const scope = new AsyncLocalStorage<Caller>();

/** Run a request inside its own scope. Registered once, as server middleware. */
export function withUsageScope<T>(fn: () => T): T {
  return scope.run({ userId: null, feature: null }, fn);
}

/** The signed-in user, once known. A mutation of the request's own scope. */
export function setCaller(userId: string): void {
  const s = scope.getStore();
  if (s) s.userId = userId;
}

/** Query or Plan, set by the route: the engine serves both. */
export function setFeature(feature: Feature): void {
  const s = scope.getStore();
  if (s) s.feature = feature;
}

export function newRunId(): string { return randomUUID(); }

let warned = false;

export interface UsageEntry extends CallUsage {
  purpose: string;
  model: string;
  ms?: number | null;
  /** Groups the calls of one answer, so "questions" can be counted. */
  run_id?: string | null;
}

export function recordUsage(e: UsageEntry): void {
  const s = scope.getStore() ?? null;
  const userId = s?.userId ?? null;
  const row = {
    user_id: userId,
    feature: featureOf(userId, e.purpose, s?.feature ?? null),
    purpose: e.purpose,
    model: e.model,
    input_tokens: e.input_tokens ?? 0,
    output_tokens: e.output_tokens ?? 0,
    cache_read: e.cache_read ?? 0,
    cache_write: e.cache_write ?? 0,
    web_searches: e.web_searches ?? 0,
    cost_usd: callCost(e.model, e),
    ms: e.ms ?? null,
    run_id: e.run_id ?? null,
  };
  if (row.cost_usd === null) console.warn(`[usage] no price for model ${e.model}; recorded without a cost`);
  void (async () => {
    try {
      const { supabaseAdmin } = await import('../auth/session.js');
      const { error } = await supabaseAdmin.from('ai_usage').insert(row);
      if (error) throw new Error(error.message);
    } catch (err: any) {
      if (!warned) {
        warned = true;
        console.warn(`[usage] could not record AI usage (is migration 065 applied?): ${err?.message ?? err}`);
      }
    }
  })();
}

/** The usage fields of an API response, as recorded. */
export function usageOf(r: any): CallUsage {
  const u = r?.usage ?? {};
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    web_searches: u.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * The same client, with every create and stream recorded. For the call sites
 * that are not the engine (which records its own rounds, knowing its purpose):
 * the planner's passes, titles, and the scheduled jobs. The pass is named by
 * its forced tool, or by `fallback` when it has none.
 */
export function metered<C extends { messages: any }>(client: C, fallback: string): C {
  const messages = client.messages;
  const wrapped = Object.create(messages);
  wrapped.create = async (params: any, opts?: any) => {
    const t0 = Date.now();
    const res = await messages.create(params, opts);
    if (res && !params?.stream) {
      recordUsage({ purpose: passOf(params, fallback), model: res.model ?? params.model, ms: Date.now() - t0, ...usageOf(res) });
    }
    return res;
  };
  wrapped.stream = (params: any, opts?: any) => {
    const t0 = Date.now();
    const s = messages.stream(params, opts);
    s.on('finalMessage', (m: any) =>
      recordUsage({ purpose: passOf(params, fallback), model: m?.model ?? params.model, ms: Date.now() - t0, ...usageOf(m) }));
    return s;
  };
  return new Proxy(client, { get: (t, k, r) => (k === 'messages' ? wrapped : Reflect.get(t, k, r)) });
}
