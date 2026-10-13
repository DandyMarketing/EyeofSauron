/*
 * Show / hide on every password box (Khai, 13 Oct 2026: "should be able to
 * reveal password when keying in"). One file for the sign-in, set-password
 * and reset-password pages, so the eye looks and behaves the same on each.
 *
 * The box is switched between type="password" and type="text", and marked
 * data-pw so a page's own styles keep applying while it shows the text.
 * Hidden again on submit, so a browser never saves it as a plain text field.
 */
(function () {
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function attach(input) {
    if (input.dataset.pw) return;
    input.dataset.pw = 'hidden';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    // The box's own space below moves to the wrapper, so the eye centres on
    // the box and not on the box plus its margin.
    const below = getComputedStyle(input).marginBottom;
    if (below && below !== '0px') { wrap.style.marginBottom = below; input.style.marginBottom = '0'; }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    const paint = () => {
      const shown = input.type === 'text';
      btn.innerHTML = shown ? EYE_OFF : EYE;
      btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
      btn.setAttribute('aria-pressed', String(shown));
      btn.title = shown ? 'Hide password' : 'Show password';
    };
    // Keep the keyboard up and the caret where it was on a phone.
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      const at = input.selectionStart;
      input.type = input.type === 'password' ? 'text' : 'password';
      input.dataset.pw = input.type === 'text' ? 'shown' : 'hidden';
      paint();
      input.focus();
      try { if (at !== null) input.setSelectionRange(at, at); } catch (_) { /* some types refuse */ }
    });
    paint();
    wrap.appendChild(btn);

    const form = input.form;
    if (form) form.addEventListener('submit', () => { input.type = 'password'; input.dataset.pw = 'hidden'; paint(); }, true);
  }

  function run() { document.querySelectorAll('input[type="password"]').forEach(attach); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
