/**
 * Queued questions (Khai, 23 Nov 2026: "the ability to queue the queries").
 * One module for Query and Plan.
 *
 * While an answer is being written, Send no longer refuses: the message joins
 * a queue shown above the box, each line with × to take it out, and the page
 * sends them one at a time as each answer finishes. Nothing goes that is not
 * on screen. An answer that ERRORS pauses the queue rather than firing the
 * rest into the same fault -- "Paused after an error" with Resume -- and a
 * change of conversation empties it, because a question queued for one chat
 * must never be sent into another.
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const MAX_QUEUED = 10;

function injectStyles() {
  if (document.getElementById('queue-css')) return;
  const style = document.createElement('style');
  style.id = 'queue-css';
  style.textContent = `
    .q-list { display: flex; flex-direction: column; gap: 4px; margin: 0 0 8px; min-width: 0; }
    .q-list[hidden] { display: none; }
    .q-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-muted); }
    .q-head.paused { color: var(--warn, #a15c00); }
    .q-head button { font: inherit; font-size: 13px; padding: 2px 10px; min-height: 0; height: auto; border-radius: 8px;
      border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
    .q-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 6px 6px 12px; border-radius: 10px;
      background: var(--surface); border: 1px solid var(--border); font-size: 14px; color: var(--text); min-width: 0; }
    .q-item .q-n { flex: none; color: var(--text-muted); font-size: 13px; line-height: 1.45; }
    .q-item .q-text { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.45;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .q-item .q-x { flex: none; width: 28px; height: 28px; min-height: 0; padding: 0; border: none; border-radius: 8px;
      background: transparent; color: var(--text-muted); font-size: 18px; line-height: 1; cursor: pointer; }
    .q-item .q-x:hover { background: var(--bg); color: var(--text); }
  `;
  document.head.appendChild(style);
}

/**
 * @param {{ before: Element, onResume: () => void }} opts
 *   `before` is the element the list is placed in front of (the input row);
 *   `onResume` is called when the person presses Resume on a paused queue.
 */
export function createQueue(opts) {
  injectStyles();
  let items = [];
  let paused = false;
  let nextId = 1;

  const box = document.createElement('div');
  box.className = 'q-list';
  box.hidden = true;
  box.setAttribute('aria-live', 'polite');
  opts.before.parentNode.insertBefore(box, opts.before);

  function render() {
    box.hidden = items.length === 0;
    if (!items.length) { box.innerHTML = ''; return; }
    const head = paused
      ? '<div class="q-head paused">Paused after an error <button type="button" class="q-resume">Resume</button></div>'
      : '<div class="q-head">Queued: each goes when the answer before it is done</div>';
    box.innerHTML = head + items.map((it, i) =>
      '<div class="q-item" data-id="' + it.id + '"><span class="q-n">' + (i + 1) + '.</span>' +
      '<span class="q-text">' + esc(it.text) + '</span>' +
      '<button type="button" class="q-x" aria-label="Remove from queue" title="Remove">×</button></div>').join('');
  }

  box.addEventListener('click', (e) => {
    const x = e.target.closest('.q-x');
    if (x) {
      const id = Number(x.closest('.q-item').dataset.id);
      items = items.filter(it => it.id !== id);
      if (!items.length) paused = false;
      render();
      return;
    }
    if (e.target.closest('.q-resume')) { paused = false; render(); opts.onResume(); }
  });

  return {
    /** Add a message; false when the queue is full. */
    add(text) {
      if (items.length >= MAX_QUEUED) return false;
      items.push({ id: nextId++, text });
      render();
      return true;
    },
    /** The next message to send, taken off the queue; null when there is none or it is paused. */
    next() {
      if (paused || !items.length) return null;
      const it = items.shift();
      render();
      return it.text;
    },
    size: () => items.length,
    isPaused: () => paused,
    pause() { if (items.length) { paused = true; render(); } },
    resume() { paused = false; render(); },
    /** The conversation changed: nothing queued for the old one may go to the new one. */
    clear() { items = []; paused = false; render(); },
  };
}
