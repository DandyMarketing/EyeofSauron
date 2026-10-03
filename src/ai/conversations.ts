/**
 * Saving, listing and reading back a person's own conversations.
 *
 * Everything here runs with the service role, so RLS is bypassed and
 * `user_id` is filtered explicitly on every query. That is the same shape as
 * the rest of the server and it carries the same obligation: the filter is the
 * control, and leaving it off is not a missing nicety but a data leak. The RLS
 * policy in migration 050 is the second line, for anything reaching the tables
 * with a user's own key.
 */

import { supabaseAdmin } from '../auth/session.js';
import { filterConversation, scopeOfTurn } from './conversation-scope.js';
import type { ReaderScope, ToolCallRecord } from './conversation-scope.js';

export interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

/**
 * A title from the first question, without calling a model.
 *
 * The cheap tier writes a better one and this is the fallback for when it
 * cannot — a conversation that exists with no name is harder to find than one
 * named after what was asked, and waiting on a model to create the row would
 * mean losing the row whenever the model fails.
 */
export function titleFromQuestion(question: string): string {
  const cleaned = (question ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New conversation';
  if (cleaned.length <= 60) return cleaned;
  // Cut at a word boundary rather than mid-word, which reads as corruption.
  const cut = cleaned.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
}

/** Start a thread. Returns its id. */
export async function createConversation(userId: string, firstQuestion: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('conversations')
    .insert({ user_id: userId, title: titleFromQuestion(firstQuestion) })
    .select('id')
    .single();

  if (error) {
    /**
     * A failure to SAVE must never fail the ANSWER.
     *
     * The person asked a question and it was answered; losing the transcript is
     * a smaller harm than losing the reply, and before migration 050 is run
     * these tables do not exist at all. Same rule as the terms gate and
     * warnSchema: a degraded feature beats a dead product.
     */
    console.error(`[conversations] could not create a thread: ${error.message}`);
    return null;
  }
  return data.id;
}

/**
 * Append one exchange — the question and the answer — to a thread.
 *
 * The turn's SCOPE is derived here from the tool calls the engine already
 * returned, and stored on the assistant message. It is what the re-check reads
 * when somebody opens this conversation later.
 */
export async function appendTurn(
  conversationId: string,
  question: string,
  answer: string,
  toolCalls: ToolCallRecord[],
  charts: unknown,
): Promise<void> {
  const scope = scopeOfTurn(toolCalls ?? []);

  const { error } = await supabaseAdmin.from('conversation_messages').insert([
    {
      conversation_id: conversationId,
      role: 'user',
      content: question,
      // A question carries no figures; the scope that matters is on the answer.
      venue_slugs: [],
      domains: [],
    },
    {
      conversation_id: conversationId,
      role: 'assistant',
      content: answer,
      charts: charts ?? null,
      venue_slugs: scope.venue_slugs,
      domains: scope.domains,
    },
  ]);

  if (error) {
    console.error(`[conversations] could not append to ${conversationId}: ${error.message}`);
    return;
  }

  // Retention measures the LAST message, so a thread somebody keeps returning
  // to keeps living. Failing this is harmless — it only ages the thread.
  const { error: touchError } = await supabaseAdmin
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (touchError) console.warn(`[conversations] could not touch ${conversationId}: ${touchError.message}`);
}

/** Somebody's own threads, newest first. */
export async function listConversations(userId: string, limit = 50): Promise<ConversationSummary[]> {
  const { data, error } = await supabaseAdmin
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`[conversations] could not list for ${userId}: ${error.message}`);
    return [];
  }
  return data ?? [];
}

/**
 * One thread, re-checked against who is asking RIGHT NOW.
 *
 * Returns null when the conversation is not this person's — not a 403 with a
 * different body, because "exists but is not yours" and "does not exist" should
 * be indistinguishable from outside. Otherwise a stranger could learn which
 * conversation ids are real.
 */
export async function readConversation(
  userId: string,
  conversationId: string,
  reader: ReaderScope,
): Promise<{ id: string; title: string | null; messages: unknown[]; withheld: number } | null> {
  const { data: convo, error } = await supabaseAdmin
    .from('conversations')
    .select('id, title, user_id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error(`[conversations] could not read ${conversationId}: ${error.message}`);
    return null;
  }
  if (!convo) return null;

  const { data: rows, error: msgError } = await supabaseAdmin
    .from('conversation_messages')
    .select('role, content, charts, venue_slugs, domains, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (msgError) {
    console.error(`[conversations] could not read messages of ${conversationId}: ${msgError.message}`);
    return null;
  }

  const { messages, withheld } = filterConversation((rows ?? []) as any[], reader);

  if (withheld > 0) {
    /**
     * Logged, because this is the security control doing its job and a control
     * nobody can see is indistinguishable from one that stopped working — the
     * same argument as the payroll exclusion counts on every ingest run.
     */
    console.log(`[conversations] withheld ${withheld} message(s) of ${conversationId} — reader's access has changed`);
  }

  return { id: convo.id, title: convo.title, messages, withheld };
}

export async function renameConversation(userId: string, id: string, title: string): Promise<boolean> {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) return false;

  const { error } = await supabaseAdmin
    .from('conversations')
    .update({ title: clean })
    .eq('id', id)
    .eq('user_id', userId);   // the filter IS the control; never drop it

  if (error) { console.error(`[conversations] rename failed: ${error.message}`); return false; }
  return true;
}

export async function deleteConversation(userId: string, id: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) { console.error(`[conversations] delete failed: ${error.message}`); return false; }
  return true;
}
