/**
 * "Report this issue" (Khai, 13 Oct 2026, with Sauron in daily use by the
 * team): one window, shared by the chat and the planner, that sends the answer
 * and the whole conversation to the admins.
 *
 * The person says what kind of problem it was and, in a few words, what went
 * wrong -- required (Khai, 13 Oct 2026: "ask the guys to briefly describe the
 * error"). The server snapshots the SAVED conversation with each answer's tool
 * trace; this page also sends the WHOLE conversation as it is on screen,
 * because what failed is often what was never saved -- an answer that errored,
 * or a chat whose first answer never came back. Nothing comes back but a
 * thank-you: the review is for the admins (decided with Khai).
 */

const KINDS = [
  ['wrong', 'It answered incorrectly'],
  ['cannot_answer', 'It could not answer'],
  ['error', 'It showed an error'],
  ['other', 'Something else'],
];

/** Where each page keeps its messages, and which of them are the person's own. */
const THREADS = {
  chat: { items: '#chat > .message', isUser: el => el.classList.contains('user') },
  plan: { items: '#thread > .msg', isUser: el => el.classList.contains('planner') },
};

/**
 * A message as plain text: tables kept as rows, buttons and spinners left out.
 * Read from a copy, so nothing on the page changes.
 */
function textOf(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('button, .teach-bar, .thinking, .report-link, script, style, svg').forEach(n => n.remove());
  c.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
  c.querySelectorAll('tr').forEach(tr => { tr.textContent = [...tr.children].map(td => td.textContent.trim()).join(' | ') + '\n'; });
  c.querySelectorAll('p, li, h1, h2, h3, h4, pre, div, table').forEach(n => n.append('\n'));
  return c.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The conversation as the person sees it, oldest first. */
export function screenTranscript(page) {
  const t = THREADS[page];
  if (!t) return [];
  const out = [];
  for (const el of document.querySelectorAll(t.items)) {
    const chart = el.querySelector('.chart-card');
    const bubble = el.querySelector('.bubble');
    const content = chart && !bubble ? '[Chart: ' + (chart.title || 'untitled') + ']' : textOf(bubble || el);
    if (content) out.push({ role: t.isUser(el) ? 'user' : 'assistant', content });
  }
  return out.slice(-300);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function injectStyles() {
  if (document.getElementById('report-issue-css')) return;
  const style = document.createElement('style');
  style.id = 'report-issue-css';
  style.textContent = `
    #ri-overlay { position: fixed; inset: 0; z-index: 90; background: var(--scrim); }
    #ri-sheet { position: fixed; z-index: 91; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow-y: auto; scrollbar-width: none;
      background: var(--surface); color: var(--text); border: 1px solid var(--border);
      border-radius: 12px; padding: 18px; box-shadow: 0 10px 30px rgba(46,42,37,0.15); font-size: 15px; }
    #ri-sheet::-webkit-scrollbar { display: none; }
    #ri-sheet h3 { font-size: 17px; margin: 0 0 4px; }
    #ri-sheet .ri-sub { color: var(--text-muted); font-size: 13px; margin-bottom: 12px; line-height: 1.5; }
    #ri-sheet label.ri-kind { display: flex; gap: 8px; align-items: center; padding: 8px 10px; margin-bottom: 6px;
      border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
    #ri-sheet label.ri-kind:has(input:checked) { border-color: var(--accent); background: rgba(176,96,42,.1); }
    #ri-sheet input[type=radio] { accent-color: var(--accent); margin: 0; }
    #ri-sheet .ri-label { display: block; font-weight: 600; margin-top: 12px; }
    #ri-sheet textarea { width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 84px; resize: vertical;
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 14px; }
    #ri-sheet textarea:focus { outline: none; border-color: var(--accent); }
    #ri-sheet .ri-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    #ri-sheet button { border-radius: 8px; padding: 8px 14px; font: inherit; font-size: 14px; cursor: pointer; border: 1px solid var(--border);
      background: transparent; color: var(--text); }
    #ri-sheet button.ri-send { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
    #ri-sheet button:disabled { opacity: .85; cursor: default; }
    #ri-sheet button .eye-busy { margin-right: 4px; vertical-align: -3px; }
    #ri-sheet .ri-msg { font-size: 13px; margin-top: 8px; color: var(--error); }
    #ri-sheet .ri-done { color: var(--success); font-size: 15px; line-height: 1.5; }
  `;
  document.head.appendChild(style);
}

/**
 * Open the report window.
 * @param {{ token: string, page: 'chat'|'plan', conversationId?: string|null,
 *           question?: string, answer?: string, error?: string, model?: string }} ctx
 */
export function openReport(ctx) {
  injectStyles();
  document.getElementById('ri-overlay')?.remove();
  document.getElementById('ri-sheet')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ri-overlay';
  const sheet = document.createElement('div');
  sheet.id = 'ri-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Report this issue');
  const preset = ctx.error ? 'error' : 'wrong';
  sheet.innerHTML =
    '<h3>Report this to the admins</h3>' +
    '<div class="ri-sub">The whole conversation on this screen goes with it, so the admins can see exactly what happened and fix the cause.</div>' +
    KINDS.map(([v, l]) => '<label class="ri-kind"><input type="radio" name="ri-kind" value="' + v + '"' + (v === preset ? ' checked' : '') + '>' + esc(l) + '</label>').join('') +
    '<label class="ri-label" for="ri-comment">Briefly, what went wrong?</label>' +
    '<textarea id="ri-comment" class="ri-comment" maxlength="4000" required placeholder="e.g. It said 41 brunch bookings, but the book showed 55 covers"></textarea>' +
    '<div class="ri-msg" hidden></div>' +
    '<div class="ri-row"><button type="button" class="ri-cancel">Cancel</button><button type="button" class="ri-send">Send report</button></div>';
  document.body.appendChild(overlay);
  document.body.appendChild(sheet);

  const close = () => { overlay.remove(); sheet.remove(); };
  overlay.addEventListener('click', close);
  sheet.querySelector('.ri-cancel').addEventListener('click', close);
  sheet.querySelector('.ri-send').addEventListener('click', async () => {
    const btn = sheet.querySelector('.ri-send');
    const msg = sheet.querySelector('.ri-msg');
    const box = sheet.querySelector('.ri-comment');
    if (box.value.trim().length < 3) {
      msg.textContent = 'Please describe the problem in a few words, so the admins know what to look for.';
      msg.hidden = false; box.focus();
      return;
    }
    btn.disabled = true; btn.innerHTML = (window.eyeBusy ? window.eyeBusy(18) + ' ' : '') + 'Sending…'; msg.hidden = true;
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.token },
        body: JSON.stringify({
          kind: sheet.querySelector('input[name=ri-kind]:checked')?.value || 'other',
          page: ctx.page,
          comment: sheet.querySelector('.ri-comment').value,
          conversation_id: ctx.conversationId || null,
          question: ctx.question || null,
          answer: ctx.answer || null,
          error: ctx.error || null,
          screen: screenTranscript(ctx.page),
          context: { model: ctx.model || undefined, user_agent: navigator.userAgent, url: location.pathname },
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.error) throw new Error(out.error || 'Could not send the report.');
      sheet.innerHTML = '<div class="ri-done"><strong>Thanks — sent to the admins.</strong><br>They will look at it with the whole conversation.</div>' +
        '<div class="ri-row"><button type="button" class="ri-close">Close</button></div>';
      sheet.querySelector('.ri-close').addEventListener('click', close);
    } catch (e) {
      msg.textContent = String(e.message || e); msg.hidden = false;
      btn.disabled = false; btn.textContent = 'Send report';
    }
  });
}
