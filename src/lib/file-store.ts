/**
 * Uploaded documents: read, kept as text with the conversation for 30 days,
 * and handed to the engine (Khai, 13 Nov 2026; migration 069).
 *
 * The OWNER is the control on every read and write here -- `.eq('user_id')` on
 * each query -- because the table holds whatever people upload, which can be
 * personal data, and it is read with the service role. Expiry is enforced on
 * read too, so an expired file is never used even if the purge is late.
 *
 * Before migration 069 runs, an upload fails with a sentence saying so, and a
 * question simply carries no documents: the chat never breaks over it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../auth/session.js';
import { extractText, kindOf, MAX_FILE_BYTES, MAX_TEXT_CHARS, type Extracted } from './file-extract.js';
import { metered } from './ai-usage.js';
import { modelFor } from '../ai/model-policy.js';
import type { UploadedDocument } from '../ai/documents.js';

export const MAX_FILES_PER_CONVERSATION = 5;
/** All of a conversation's documents together: about 75,000 tokens a question. */
export const MAX_DOCUMENT_CHARS = 300_000;
/** A scan is read by Claude page by page; past this it costs too much to be casual. */
export const MAX_VISION_PAGES = 30;

const COLUMNS = 'id, filename, kind, summary, truncated, notes, read_by, size_bytes, created_at, expires_at, conversation_id';

export interface StoredFileInfo {
  id: string; filename: string; kind: string; summary: string; truncated: boolean;
  notes: string[]; read_by: string; size_bytes: number; created_at: string; expires_at: string;
  conversation_id: string | null;
}

const missingTable = (msg: string) => /conversation_files/.test(msg) && /does not exist|schema cache|relation/i.test(msg);
const nowIso = () => new Date().toISOString();

let client: Anthropic | null = null;
const anthropic = () => (client ??= metered(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), 'file_read'));

/**
 * A scanned PDF has no text to extract, so Claude reads the pages once, at
 * upload, and the transcription is what is kept. Told to copy, not summarise:
 * every figure and every table row, in order.
 */
async function transcribeScan(buf: Buffer, pages: number): Promise<{ text: string; truncated: boolean }> {
  const policy = modelFor('lookup', process.env);
  const r = await anthropic().messages.create({
    model: policy.model,
    max_tokens: 16_000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
        { type: 'text', text:
          `Transcribe this ${pages}-page document exactly, page by page, starting each page with "--- Page N ---". ` +
          'Copy every word and figure as printed; write tables as markdown tables, one row per line, keeping every row. ' +
          'Do not summarise, explain, correct or add anything. Where something cannot be read, write [illegible].' },
      ],
    }],
  } as any);
  const text = (r.content as any[]).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, truncated: r.stop_reason === 'max_tokens' };
}

/** Does this conversation belong to this person? */
async function ownsConversation(userId: string, conversationId: string): Promise<boolean> {
  // row-cap: one conversation by id.
  const { data } = await supabaseAdmin.from('conversations').select('id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
  return !!data;
}

export async function saveUpload(
  userId: string,
  file: { name: string; bytes: Buffer },
  conversationId?: string | null,
): Promise<{ ok: true; file: StoredFileInfo } | { ok: false; error: string; status?: number }> {
  const name = file.name.replace(/[\\/]/g, '_').slice(0, 200) || 'upload';
  const kind = kindOf(name);
  if (typeof kind !== 'string') return { ok: false, error: kind.error };
  if (file.bytes.length === 0) return { ok: false, error: 'That file is empty.' };
  if (file.bytes.length > MAX_FILE_BYTES) {
    return { ok: false, error: `That file is ${(file.bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB. For a big export, upload only the sheet or date range you need.` };
  }

  let cid: string | null = null;
  if (conversationId) {
    if (!(await ownsConversation(userId, conversationId))) return { ok: false, error: 'That conversation was not found.', status: 404 };
    cid = conversationId;
    // row-cap: a conversation holds at most MAX_FILES_PER_CONVERSATION files.
    const { count } = await supabaseAdmin.from('conversation_files').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('conversation_id', cid).gt('expires_at', nowIso());
    if ((count ?? 0) >= MAX_FILES_PER_CONVERSATION) {
      return { ok: false, error: `A conversation can hold ${MAX_FILES_PER_CONVERSATION} files. Remove one first, or start a new conversation.` };
    }
  }

  let x: Extracted;
  try {
    x = await extractText(file.bytes, name);
  } catch (e: any) {
    console.error(`[files] could not read ${name} for ${userId}: ${e?.message ?? e}`);
    return { ok: false, error: `Sauron could not read that file (${String(e?.message ?? e).slice(0, 160)}). If it opens normally on your computer, try saving it again as ${kind === 'spreadsheet' ? '.xlsx' : kind === 'docx' ? '.docx' : 'PDF'}.` };
  }

  let readBy: 'text' | 'vision' = 'text';
  if (x.needsVision) {
    if ((x.pages ?? 0) > MAX_VISION_PAGES) {
      return { ok: false, error: `That PDF is a scan of ${x.pages} pages; Sauron reads scans up to ${MAX_VISION_PAGES} pages. Upload only the pages you need.` };
    }
    try {
      const t = await transcribeScan(file.bytes, x.pages ?? 1);
      x = { ...x, text: t.text.slice(0, MAX_TEXT_CHARS), truncated: t.truncated || t.text.length > MAX_TEXT_CHARS,
        notes: t.truncated ? ['The scan was longer than Sauron could transcribe in one go; the last pages may be missing.'] : [] };
      readBy = 'vision';
    } catch (e: any) {
      console.error(`[files] could not transcribe the scan ${name}: ${e?.message ?? e}`);
      return { ok: false, error: 'That PDF is a scan (pictures of pages, no text), and reading it failed. Please try again in a minute.' };
    }
  }
  if (!x.text.trim()) return { ok: false, error: 'There is no text in that file for Sauron to read.' };

  const { data, error } = await supabaseAdmin.from('conversation_files').insert({
    user_id: userId,
    conversation_id: cid,
    filename: name,
    kind: x.kind,
    size_bytes: file.bytes.length,
    summary: x.summary,
    content: x.text,
    truncated: x.truncated,
    notes: x.notes,
    read_by: readBy,
  }).select(COLUMNS).single();
  if (error) {
    console.error(`[files] could not save ${name}: ${error.message}`);
    return { ok: false, error: missingTable(error.message)
      ? 'File uploads are not switched on yet (migration 069 has not been run). Please tell an admin.'
      : 'Could not save the file. Please try again.' };
  }
  console.log(`[files] ${userId} uploaded ${name} (${x.kind}, ${x.summary}, ${readBy}, ${x.text.length} chars)`);
  return { ok: true, file: data as StoredFileInfo };
}

export async function listFiles(userId: string, conversationId: string): Promise<StoredFileInfo[]> {
  // row-cap: a conversation holds at most MAX_FILES_PER_CONVERSATION files.
  const { data, error } = await supabaseAdmin.from('conversation_files').select(COLUMNS)
    .eq('user_id', userId).eq('conversation_id', conversationId).gt('expires_at', nowIso())
    .order('created_at', { ascending: true }).limit(50);
  if (error) {
    if (!missingTable(error.message)) console.error(`[files] list failed: ${error.message}`);
    return [];
  }
  return (data ?? []) as StoredFileInfo[];
}

export async function deleteFile(userId: string, id: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from('conversation_files').delete().eq('id', id).eq('user_id', userId);
  if (error) { console.error(`[files] delete failed: ${error.message}`); return false; }
  return true;
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * The documents a question carries: the conversation's own, plus any uploaded
 * just now that are not yet attached. Oldest first, up to the size budget; a
 * file that does not fit is left out and NAMED in the last block's notes.
 */
export async function documentsFor(userId: string, conversationId: string | null | undefined, pendingIds: unknown): Promise<UploadedDocument[]> {
  const pending = Array.isArray(pendingIds) ? pendingIds.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, MAX_FILES_PER_CONVERSATION) : [];
  if (!conversationId && pending.length === 0) return [];
  const cols = 'id, filename, kind, summary, content, truncated, notes, read_by, created_at, conversation_id';
  const wanted: any[] = [];
  if (conversationId) {
    // row-cap: a conversation holds at most MAX_FILES_PER_CONVERSATION files.
    const { data, error } = await supabaseAdmin.from('conversation_files').select(cols)
      .eq('user_id', userId).eq('conversation_id', conversationId).gt('expires_at', nowIso()).limit(50);
    if (error) { if (!missingTable(error.message)) console.error(`[files] read failed: ${error.message}`); return []; }
    wanted.push(...(data ?? []));
  }
  if (pending.length) {
    // row-cap: at most MAX_FILES_PER_CONVERSATION ids are asked for.
    const { data, error } = await supabaseAdmin.from('conversation_files').select(cols)
      .eq('user_id', userId).in('id', pending).is('conversation_id', null).gt('expires_at', nowIso()).limit(50);
    if (error) { if (!missingTable(error.message)) console.error(`[files] read failed: ${error.message}`); }
    else wanted.push(...(data ?? []));
  }
  const rows = [...new Map(wanted.map(r => [r.id, r])).values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const out: UploadedDocument[] = [];
  const left: string[] = [];
  let used = 0;
  for (const r of rows) {
    if (used + r.content.length > MAX_DOCUMENT_CHARS) { left.push(r.filename); continue; }
    used += r.content.length;
    out.push({ id: r.id, filename: r.filename, kind: r.kind, summary: r.summary, content: r.content,
      truncated: r.truncated, notes: Array.isArray(r.notes) ? r.notes : [], read_by: r.read_by, uploaded_at: r.created_at });
  }
  if (left.length && out.length) {
    out[out.length - 1].notes = [...out[out.length - 1].notes,
      `NOT INCLUDED, too much text for one question: ${left.join(', ')}. Say so if the question needs them.`];
  }
  return out;
}

/** After the first question with them is saved: the uploads join that conversation. */
export async function attachFiles(userId: string, conversationId: string | null, pendingIds: unknown): Promise<void> {
  if (!conversationId || !Array.isArray(pendingIds) || pendingIds.length === 0) return;
  const ids = pendingIds.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, MAX_FILES_PER_CONVERSATION);
  if (!ids.length) return;
  const { error } = await supabaseAdmin.from('conversation_files').update({ conversation_id: conversationId })
    .eq('user_id', userId).in('id', ids).is('conversation_id', null);
  if (error && !missingTable(error.message)) console.error(`[files] attach failed: ${error.message}`);
}

/**
 * Delete what has expired: 30 days after upload, and uploads never attached to
 * a question after a day. Run on start and every six hours by the web server.
 */
export async function purgeExpiredFiles(): Promise<void> {
  const now = nowIso();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const a = await supabaseAdmin.from('conversation_files').delete({ count: 'exact' }).lt('expires_at', now);
  const b = await supabaseAdmin.from('conversation_files').delete({ count: 'exact' }).is('conversation_id', null).lt('created_at', dayAgo);
  const err = a.error ?? b.error;
  if (err) { if (!missingTable(err.message)) console.error(`[files] purge failed: ${err.message}`); return; }
  const n = (a.count ?? 0) + (b.count ?? 0);
  if (n) console.log(`[files] purged ${a.count ?? 0} expired and ${b.count ?? 0} never-attached file(s)`);
}
