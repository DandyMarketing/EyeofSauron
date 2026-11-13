/**
 * Attach a document to Query or Plan (Khai, 13 Nov 2026: "upload excels, pdf,
 * docx ... to compare with something"). One module for both pages.
 *
 * The file goes to POST /api/files the moment it is chosen and is READ there;
 * only its text is kept, with the conversation, for 30 days. The chip shows
 * what came back -- pages, sheets and rows -- so the person sees what Sauron
 * actually got before asking about it. A file chosen before the first question
 * is "pending": its id rides with the next question, and the server attaches
 * it to the conversation once that conversation exists.
 */

const ACCEPT = '.pdf,.xlsx,.xls,.xlsm,.csv,.docx';
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = { pdf: 'PDF', spreadsheet: 'XLS', docx: 'DOC' };

function injectStyles() {
  if (document.getElementById('attach-css')) return;
  const style = document.createElement('style');
  style.id = 'attach-css';
  style.textContent = `
    .attach-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 auto 8px; max-width: 860px; }
    .attach-row[hidden] { display: none; }
    .att-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; box-sizing: border-box;
      padding: 5px 6px 5px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface);
      color: var(--text); font-size: 13px; line-height: 1.3; }
    .att-chip .att-ico { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .03em; padding: 2px 4px; border-radius: 4px;
      background: var(--accent); color: var(--on-accent); }
    .att-chip .att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; font-weight: 600; }
    .att-chip .att-meta { color: var(--text-muted); white-space: nowrap; }
    .att-chip .att-x { flex: none; border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 16px; line-height: 1;
      padding: 2px 4px; border-radius: 6px; }
    .att-chip .att-x:hover { color: var(--text); background: var(--bg); }
    .att-chip.err { border-color: var(--error); color: var(--error); white-space: normal; }
    .att-chip.err .att-msg { max-width: 300px; }
    .att-chip.warn .att-meta { color: var(--warning, var(--text-muted)); }
    .att-chip .eye-busy { flex: none; }
    .att-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px;
      border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); cursor: pointer; padding: 0; }
    .att-btn:hover { color: var(--accent); border-color: var(--accent); }
    .att-btn:disabled { opacity: .5; cursor: default; }
    .att-btn svg { width: 20px; height: 20px; }
  `;
  document.head.appendChild(style);
}

const CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

/**
 * @param {{ token: () => string, conversationId: () => (string|null),
 *           button: HTMLElement, row: HTMLElement }} opts
 *   `button` is filled with the paperclip; `row` is where the chips go.
 */
export function createAttachments(opts) {
  injectStyles();
  /** @type {Array<{ key: string, id?: string, name: string, kind?: string, summary?: string, truncated?: boolean, read_by?: string, pending?: boolean, busy?: boolean, error?: string }>} */
  let files = [];
  let seq = 0;

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = ACCEPT;
  picker.multiple = true;
  picker.hidden = true;
  document.body.appendChild(picker);

  opts.button.classList.add('att-btn');
  opts.button.type = 'button';
  opts.button.innerHTML = CLIP;
  opts.button.title = 'Attach a PDF, Excel, CSV or Word file';
  opts.button.setAttribute('aria-label', 'Attach a file');
  opts.button.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const chosen = [...picker.files];
    picker.value = '';
    for (const f of chosen) upload(f);
  });

  function draw() {
    const live = files.filter(f => !f.error).length;
    opts.button.disabled = live >= MAX_FILES;
    opts.row.hidden = files.length === 0;
    opts.row.innerHTML = files.map(f => {
      if (f.error) {
        return '<span class="att-chip err" data-key="' + f.key + '"><span class="att-msg"><strong>' + esc(f.name) + '</strong>: ' + esc(f.error) + '</span>' +
          '<button class="att-x" type="button" aria-label="Dismiss">×</button></span>';
      }
      if (f.busy) {
        return '<span class="att-chip" data-key="' + f.key + '">' + (window.eyeBusy ? window.eyeBusy(18) : '') +
          '<span class="att-name">' + esc(f.name) + '</span><span class="att-meta">reading…</span></span>';
      }
      const meta = [f.summary, f.read_by === 'vision' ? 'scan, read by Claude' : '', f.truncated ? 'partly read' : ''].filter(Boolean).join(' · ');
      return '<span class="att-chip' + (f.truncated ? ' warn' : '') + '" data-key="' + f.key + '" title="' + esc(f.name) + (f.pending ? ' — goes with your next message' : ' — in this conversation for 30 days') + '">' +
        '<span class="att-ico">' + (ICON[f.kind] || 'FILE') + '</span><span class="att-name">' + esc(f.name) + '</span>' +
        '<span class="att-meta">' + esc(meta) + '</span>' +
        '<button class="att-x" type="button" aria-label="Remove ' + esc(f.name) + '">×</button></span>';
    }).join('');
    opts.row.querySelectorAll('.att-x').forEach(b => b.addEventListener('click', () => remove(b.closest('.att-chip').dataset.key)));
  }

  async function upload(file) {
    const key = 'k' + (++seq);
    if (files.filter(f => !f.error).length >= MAX_FILES) {
      files.push({ key, name: file.name, error: 'a conversation holds ' + MAX_FILES + ' files; remove one first.' });
      return draw();
    }
    if (file.size > MAX_BYTES) {
      files.push({ key, name: file.name, error: 'over the 10 MB limit. Upload only the sheet or pages you need.' });
      return draw();
    }
    files.push({ key, name: file.name, busy: true });
    draw();
    const form = new FormData();
    form.append('file', file);
    const cid = opts.conversationId();
    if (cid) form.append('conversation_id', cid);
    let out = {};
    let ok = false;
    try {
      const res = await fetch('/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + opts.token() }, body: form });
      out = await res.json().catch(() => ({}));
      ok = res.ok && out.file;
    } catch (e) {
      out = { error: 'the upload did not go through. Check the connection and try again.' };
    }
    const i = files.findIndex(f => f.key === key);
    if (i < 0) return;   // removed while it was reading
    files[i] = ok
      ? { key, id: out.file.id, name: out.file.filename, kind: out.file.kind, summary: out.file.summary, truncated: out.file.truncated, read_by: out.file.read_by, pending: !cid }
      : { key, name: file.name, error: out.error || 'it could not be read.' };
    draw();
  }

  async function remove(key) {
    const f = files.find(x => x.key === key);
    files = files.filter(x => x.key !== key);
    draw();
    if (f && f.id) {
      fetch('/api/files/' + f.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + opts.token() } }).catch(() => {});
    }
  }

  return {
    /** Ids to send with the next question: uploads not yet in a conversation. */
    pendingIds: () => files.filter(f => f.id && f.pending).map(f => f.id),
    /** Still reading a file: the page should wait before sending. */
    busy: () => files.some(f => f.busy),
    /** The question went through: pending uploads now belong to the conversation. */
    sent() {
      files = files.filter(f => !f.error).map(f => ({ ...f, pending: false }));
      draw();
    },
    /** A new, empty conversation. */
    reset() { files = []; draw(); },
    /** A reopened conversation: show the files it still holds. */
    async load(conversationId) {
      files = [];
      draw();
      try {
        const res = await fetch('/api/conversations/' + conversationId + '/files', { headers: { Authorization: 'Bearer ' + opts.token() } });
        if (!res.ok) return;
        const out = await res.json();
        if (opts.conversationId() !== conversationId) return;   // moved on meanwhile
        files = (out.files || []).map(f => ({ key: 'k' + (++seq), id: f.id, name: f.filename, kind: f.kind, summary: f.summary, truncated: f.truncated, read_by: f.read_by, pending: false }));
        draw();
      } catch { /* the conversation still opens without its chips */ }
    },
  };
}
