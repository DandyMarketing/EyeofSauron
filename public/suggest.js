/**
 * The suggested next message (Khai, 23 Nov 2026: "suggest answers in the chat
 * like how claude does it now ... then pressing tab fills in"). One module for
 * Query and Plan.
 *
 * After an answer, POST /api/suggest returns one line. On a computer it shows
 * as the empty box's grey placeholder, and Tab puts it in. On a phone, which
 * has no Tab key, it shows as one chip above the box, and a tap puts it in.
 * Either way it only FILLS the box -- it is never sent without the person
 * pressing Send, and it disappears the moment they start the next message.
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function injectStyles() {
  if (document.getElementById('suggest-css')) return;
  const style = document.createElement('style');
  style.id = 'suggest-css';
  style.textContent = `
    .sg-chip { display: flex; align-items: flex-start; gap: 6px; width: 100%; min-width: 0; box-sizing: border-box; margin: 0 0 8px;
      padding: 7px 12px; border-radius: 12px; border: 1px dashed var(--border); background: var(--surface);
      color: var(--text-muted); font: inherit; font-size: 14px; font-weight: 400; line-height: 1.4; text-align: left;
      white-space: normal; height: auto; cursor: pointer; }
    .sg-chip[hidden] { display: none; }
    .sg-chip .sg-arrow { flex: none; color: var(--accent); }
    .sg-chip .sg-text { overflow-wrap: anywhere; }
  `;
  document.head.appendChild(style);
}

/**
 * @param {{ input: HTMLTextAreaElement, page: 'chat'|'plan', token: () => string, before: Element }} opts
 *   `before` is the element the phone chip is placed in front of (the input row).
 */
export function createSuggest(opts) {
  injectStyles();
  const input = opts.input;
  const defaultPlaceholder = input.placeholder;
  const touch = window.matchMedia('(hover: none)').matches;
  let current = null;
  let seq = 0;

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'sg-chip';
  chip.hidden = true;
  chip.setAttribute('aria-label', 'Use the suggested message');
  opts.before.parentNode.insertBefore(chip, opts.before);

  function show(text) {
    current = text;
    if (touch) {
      chip.innerHTML = '<span class="sg-arrow">↳</span><span class="sg-text">' + esc(text) + '</span>';
      chip.hidden = !!input.value.trim();
    } else {
      // The hint goes FIRST: a long suggestion is cut with "…" and a hint at
      // the end would be the part cut.
      input.placeholder = 'Tab ⇥  ' + text;
    }
  }

  function clear() {
    seq++;
    current = null;
    input.placeholder = defaultPlaceholder;
    chip.hidden = true;
  }

  function fill() {
    if (!current) return;
    const text = current;
    clear();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));   // the box grows to fit
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && current && !input.value.trim()) {
      e.preventDefault();
      fill();
    }
  });
  // Typing the next message makes the chip irrelevant; clearing the box brings it back.
  input.addEventListener('input', () => { if (touch && current) chip.hidden = !!input.value.trim(); });
  chip.addEventListener('click', fill);

  return {
    /** After an answer is on screen: fetch and show one suggestion. */
    async after(question, answer) {
      const mine = ++seq;
      try {
        const res = await fetch('/api/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.token() },
          body: JSON.stringify({ page: opts.page, question, answer }),
        });
        if (!res.ok) return;
        const out = await res.json();
        if (mine !== seq || !out.suggestion) return;   // a newer message moved on
        show(out.suggestion);
      } catch { /* no suggestion; the page is unaffected */ }
    },
    /** A message is being sent, or the conversation changed. */
    clear,
  };
}
