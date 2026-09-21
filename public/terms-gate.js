/**
 * The blocking terms screen.
 *
 * ONE FILE, SHARED BY EVERY PAGE, rather than a copy in each. Three copies of a
 * gate is three places for it to drift, and the one that drifts is always the
 * page somebody added last — which would then be the way in.
 *
 * THIS IS THE EXPERIENCE, NOT THE CONTROL. /ask and /api/recommendations refuse
 * with a 403 when the terms are unaccepted, whatever the browser does. A person
 * who deleted this element from the DOM would face a blank app rather than a
 * free one. The split is deliberate and is the same one the AI tool list makes
 * against enforceDomainScope(): what we show is a hint, what we refuse is a
 * boundary.
 */
export async function enforceTerms(authToken) {
  let terms;
  try {
    const res = await fetch('/api/terms', { headers: { Authorization: 'Bearer ' + authToken } });
    if (!res.ok) return true;
    terms = await res.json();
  } catch (e) {
    /**
     * FAILS OPEN, and that is a deliberate choice rather than an oversight.
     *
     * The server refuses the data routes on its own, so a person who slips past
     * this because their connection dropped still cannot read anything. Failing
     * closed here would lock everybody out of a working app the moment one
     * endpoint wobbled — trading a real outage for a theoretical bypass that
     * the server already covers.
     */
    console.warn('[terms] could not check acceptance; the server still gates the data', e);
    return true;
  }

  if (terms.accepted) return true;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'terms-gate';
    overlay.innerHTML = `
      <style>
        #terms-gate {
          position: fixed; inset: 0; z-index: 9999;
          background: #0a0a0f; color: #e4e4ef;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex; align-items: center; justify-content: center; padding: 20px;
          overflow-y: auto;
        }
        #terms-gate .tg-card {
          background: #14141f; border: 1px solid #2a2a3a; border-radius: 14px;
          max-width: 640px; width: 100%; max-height: 92vh;
          display: flex; flex-direction: column;
        }
        #terms-gate .tg-head { padding: 22px 26px 12px; border-bottom: 1px solid #2a2a3a; }
        #terms-gate h2 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
        #terms-gate .tg-sub { font-size: 12px; color: #8888a0; }
        #terms-gate .tg-body {
          padding: 18px 26px; overflow-y: auto; font-size: 14px; line-height: 1.6;
          flex: 1;
        }
        #terms-gate .tg-body p { margin: 0 0 12px; }
        #terms-gate .tg-body strong { color: #e8933a; }
        #terms-gate .tg-foot {
          padding: 16px 26px 20px; border-top: 1px solid #2a2a3a;
        }
        #terms-gate label {
          display: flex; gap: 10px; align-items: flex-start;
          font-size: 13px; color: #e4e4ef; margin-bottom: 14px; cursor: pointer;
        }
        #terms-gate input[type=checkbox] { margin-top: 3px; width: 16px; height: 16px; flex-shrink: 0; }
        #terms-gate button {
          width: 100%; padding: 12px; border: none; border-radius: 8px;
          background: #e8933a; color: #14141f; font-size: 15px; font-weight: 600;
          cursor: pointer; font-family: inherit;
        }
        #terms-gate button:disabled { opacity: .4; cursor: not-allowed; }
        #terms-gate .tg-err { color: #e84040; font-size: 13px; margin-top: 10px; text-align: center; }
        #terms-gate .tg-out {
          display: block; text-align: center; margin-top: 12px;
          font-size: 12px; color: #8888a0; text-decoration: none;
        }
      </style>
      <div class="tg-card">
        <div class="tg-head">
          <h2></h2>
          <div class="tg-sub"></div>
        </div>
        <div class="tg-body"></div>
        <div class="tg-foot">
          <label>
            <input type="checkbox" id="tg-agree">
            <span>I have read and agree to the above, and I understand that my use of Sauron is recorded.</span>
          </label>
          <button id="tg-accept" disabled>Agree and continue</button>
          <div class="tg-err" id="tg-err"></div>
          <a class="tg-out" href="/login.html" id="tg-signout">Sign out instead</a>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    // Nothing behind the overlay should scroll, or a phone will drift the
    // underlying page around while somebody is trying to read.
    document.body.style.overflow = 'hidden';

    overlay.querySelector('h2').textContent = terms.title;
    overlay.querySelector('.tg-sub').textContent =
      `Version ${terms.version} — you need to accept this before Sauron will answer.`;

    /**
     * Rendered from the served text, escaped, with only **bold** honoured.
     *
     * The terms are the one thing on this page that must say exactly what
     * src/auth/terms.ts says. Running them through the chat's markdown renderer
     * would let a future edit introduce something that renders as markup, and
     * a document somebody is agreeing to is the worst possible place for a
     * surprise.
     */
    const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    overlay.querySelector('.tg-body').innerHTML = terms.body
      .split(/\n\s*\n/)
      .map(para => '<p>' + esc(para).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, ' ') + '</p>')
      .join('');

    const box = overlay.querySelector('#tg-agree');
    const btn = overlay.querySelector('#tg-accept');
    const err = overlay.querySelector('#tg-err');

    box.addEventListener('change', () => { btn.disabled = !box.checked; });

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Recording...';
      err.textContent = '';

      try {
        const res = await fetch('/api/terms/accept', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + authToken },
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not record your acceptance.');

        overlay.remove();
        document.body.style.overflow = '';
        resolve(true);
      } catch (e) {
        // Left on screen deliberately. If the acceptance was not recorded then
        // it did not happen, and letting somebody through on a failed write
        // would produce exactly the gap this whole feature exists to close.
        err.textContent = e.message + ' Please try again.';
        btn.disabled = false;
        btn.textContent = 'Agree and continue';
      }
    });
  });
}
