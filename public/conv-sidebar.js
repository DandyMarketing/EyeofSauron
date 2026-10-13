/**
 * The saved-conversations sidebar, shared by the chat and the planner.
 *
 * Khai, 12 Oct 2026: previous conversations "should live on the left side in a
 * tool bar that can minimise and expand", on both pages. It replaces the
 * dropdown under the header, which showed one title and hid the rest.
 *
 * ONE COPY FOR BOTH PAGES, the markdown.js rule: two copies of a list with
 * rename and delete in it is two places for a bug to be fixed once. A classic
 * script exposing one global, so either page's inline script can use it.
 *
 * THREE SHAPES, one element:
 *   - laptop, expanded:  a 280px column beside the conversation;
 *   - laptop, minimised: a 48px strip with "expand" and "new";
 *   - phone (< 900px):   hidden, opened from a ☰ button in the header, sliding
 *                        over the conversation; tap outside to close.
 * The minimised/expanded choice is remembered per browser. That is a
 * convenience, so a failure to read or write it just falls back to expanded.
 *
 * THE SERVER DECIDES WHAT IS LISTED AND WHAT A CONVERSATION SHOWS. This only
 * draws the list it is given; the re-check against the reader's current access
 * happens in /api/conversations/:id, as before.
 */
(function () {
  // A pushpin, drawn rather than an emoji so it looks the same everywhere.
  var PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/></svg>';
  const PHONE = '(max-width: 899px)';
  const STORE = 'sauron.sidebar.collapsed';

  const CSS = `
  #conv-sidebar {
    flex-shrink: 0; width: 280px; box-sizing: border-box;
    position: sticky; top: var(--hdr, 0px); align-self: flex-start;
    height: calc(100dvh - var(--hdr, 0px));
    background: var(--surface); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 12px; gap: 10px;
    z-index: 20;
  }
  #conv-sidebar .cs-top { display: flex; align-items: center; gap: 8px; }
  #conv-sidebar .cs-heading { flex: 1; font-size: 13px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; overflow: hidden; }
  #conv-sidebar .cs-icon {
    background: none; border: 1px solid var(--border); color: var(--text-muted);
    border-radius: 8px; width: 32px; height: 32px; padding: 0; cursor: pointer;
    font: inherit; font-size: 16px; line-height: 1; flex-shrink: 0;
  }
  #conv-sidebar .cs-icon:hover { color: var(--accent); border-color: var(--accent); }
  #conv-sidebar .cs-new {
    width: 100%; background: var(--accent); color: var(--on-accent); border: none; border-radius: 8px;
    padding: 9px; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  #conv-sidebar .cs-list { flex: 1; overflow-y: auto; min-height: 0; margin: 0 -4px; }
  #conv-sidebar .cs-item { display: flex; align-items: center; gap: 2px; border-radius: 8px; margin-bottom: 2px; }
  #conv-sidebar .cs-item:hover, #conv-sidebar .cs-item.current { background: var(--bg); }
  #conv-sidebar .cs-item.current .cs-title { color: var(--accent); }
  #conv-sidebar .cs-open {
    flex: 1; min-width: 0; text-align: left; background: none; border: none; color: var(--text);
    font: inherit; font-size: 14px; line-height: 1.35; padding: 8px; cursor: pointer;
  }
  #conv-sidebar .cs-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #conv-sidebar .cs-when { display: block; font-size: 13px; color: var(--text-muted); margin-top: 2px; }
  #conv-sidebar .cs-act {
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    font: inherit; font-size: 14px; min-width: 28px; min-height: 28px; padding: 4px;
  }
  #conv-sidebar .cs-act:hover { color: var(--accent); }
  #conv-sidebar .cs-act.cs-del:hover { color: var(--error); }
  #conv-sidebar .cs-section { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-muted); padding: 8px 8px 4px; }
  #conv-sidebar .cs-pin svg { width: 14px; height: 14px; vertical-align: middle; fill: none; stroke: currentColor; stroke-width: 1.8; }
  #conv-sidebar .cs-item:not(.pinned) .cs-pin { opacity: .45; }
  #conv-sidebar .cs-item:not(.pinned):hover .cs-pin { opacity: 1; }
  #conv-sidebar .cs-item.pinned .cs-pin { color: var(--accent); }
  #conv-sidebar .cs-item.pinned .cs-pin svg { fill: currentColor; }
  #conv-sidebar .cs-empty { color: var(--text-muted); font-size: 14px; padding: 8px 4px; line-height: 1.5; }
  #conv-sidebar .cs-note { font-size: 13px; color: var(--text-muted); border-top: 1px solid var(--border);
    padding-top: 8px; line-height: 1.5; }

  /* Minimised on a laptop: a strip with expand and new, nothing else. */
  #conv-sidebar.collapsed { width: 48px; padding: 12px 7px; align-items: center; }
  #conv-sidebar.collapsed .cs-heading, #conv-sidebar.collapsed .cs-list,
  #conv-sidebar.collapsed .cs-note, #conv-sidebar.collapsed .cs-new { display: none; }
  #conv-sidebar.collapsed .cs-top { flex-direction: column; }
  #conv-sidebar .cs-plus { display: none; }
  #conv-sidebar.collapsed .cs-plus { display: block; }

  #cs-menu, #cs-overlay { display: none; }

  @media ${PHONE} {
    #conv-sidebar, #conv-sidebar.collapsed {
      /* stretch, not flex-start: on a fixed box flex-start shrinks it to its
         content, and the slide-over stopped where the list did. */
      position: fixed; top: 0; bottom: 0; left: 0; height: auto; align-self: stretch;
      width: min(300px, 86vw); padding: 12px; align-items: stretch;
      /* No transition until mounted: otherwise every page load on a phone
         shows the list sliding away. Added by mount() a frame later. */
      transform: translateX(-102%);
      z-index: 60; box-shadow: 8px 0 30px rgba(46,42,37,0.15);
    }
    #conv-sidebar.collapsed .cs-heading, #conv-sidebar.collapsed .cs-list,
    #conv-sidebar.collapsed .cs-note, #conv-sidebar.collapsed .cs-new { display: revert; }
    #conv-sidebar.collapsed .cs-list { display: block; }
    #conv-sidebar.collapsed .cs-top { flex-direction: row; }
    #conv-sidebar .cs-plus, #conv-sidebar.collapsed .cs-plus { display: none; }
    #conv-sidebar.cs-ready { transition: transform .2s ease; }
    #conv-sidebar.phone-open { transform: none; }
    /*
     * The header on a phone. The menu button, logo, title and five links on one
     * row squeezed the title to a word a line (Khai's phone, 13 Oct 2026). The
     * links take their own row under the title; the subtitle goes.
     */
    header { flex-wrap: wrap; row-gap: 8px; }
    header > div:not(.logo) { flex: 1; min-width: 0; }
    header h1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    header .subtitle { display: none; }
    header nav {
      order: 3; flex-basis: 100%; margin-left: 0 !important; gap: 18px !important;
      overflow-x: auto; white-space: nowrap;
    }
    #cs-overlay.show { display: block; position: fixed; inset: 0; z-index: 55; background: var(--scrim); }
    #cs-menu {
      display: inline-flex; align-items: center; justify-content: center;
      background: none; border: 1px solid var(--border); color: var(--text);
      border-radius: 8px; width: 34px; height: 34px; padding: 0; margin-right: 2px;
      font: inherit; font-size: 18px; cursor: pointer; flex-shrink: 0;
    }
  }
  @media print { #conv-sidebar, #cs-menu, #cs-overlay { display: none !important; } }
  `;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function whenText(iso) {
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (!Number.isFinite(days)) return '';
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 30) return days + ' days ago';
    const months = Math.floor(days / 30);
    return months + (months === 1 ? ' month ago' : ' months ago');
  }

  function readCollapsed() {
    try { return localStorage.getItem(STORE) === '1'; } catch (e) { return false; }
  }
  function writeCollapsed(v) {
    try { localStorage.setItem(STORE, v ? '1' : '0'); } catch (e) { /* convenience only */ }
  }

  /**
   * Mount the sidebar into `opts.aside` (an empty <aside id="conv-sidebar">).
   *
   * opts: { aside, header, kind: 'chat'|'plan', noun: 'chat'|'plan',
   *         token(): string, currentId(): string|null,
   *         onOpen(id), onNew(), onDeletedCurrent() }
   *
   * Returns { refresh(), closePhone() }.
   */
  function mount(opts) {
    if (!document.getElementById('cs-style')) {
      const st = document.createElement('style');
      st.id = 'cs-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    const aside = opts.aside;
    const nouns = opts.noun + 's';
    const phone = window.matchMedia(PHONE);

    aside.setAttribute('aria-label', 'Your ' + nouns);
    aside.innerHTML =
      '<div class="cs-top">' +
        '<span class="cs-heading">Your ' + esc(nouns) + '</span>' +
        '<button class="cs-icon cs-toggle" type="button"></button>' +
        '<button class="cs-icon cs-plus" type="button" title="New ' + esc(opts.noun) + '">+</button>' +
      '</div>' +
      '<button class="cs-new" type="button">+ New ' + esc(opts.noun) + '</button>' +
      '<div class="cs-list"><div class="cs-empty">Loading&hellip;</div></div>' +
      '<div class="cs-note">Kept for a year. Only you can read these.</div>';

    const overlay = document.createElement('div');
    overlay.id = 'cs-overlay';
    document.body.appendChild(overlay);

    const menu = document.createElement('button');
    menu.id = 'cs-menu';
    menu.type = 'button';
    menu.title = 'Your ' + nouns;
    menu.setAttribute('aria-label', 'Your ' + nouns);
    menu.innerHTML = '&#9776;';
    if (opts.header) opts.header.insertBefore(menu, opts.header.firstChild);

    /** The header's height, so the sticky column starts beneath it. */
    function measure() {
      if (opts.header) document.documentElement.style.setProperty('--hdr', opts.header.offsetHeight + 'px');
    }
    measure();
    window.addEventListener('resize', measure);

    requestAnimationFrame(() => requestAnimationFrame(() => aside.classList.add('cs-ready')));

    const toggle = aside.querySelector('.cs-toggle');
    function setCollapsed(c) {
      aside.classList.toggle('collapsed', c);
      toggle.innerHTML = c ? '&raquo;' : '&laquo;';
      toggle.title = c ? 'Show your ' + nouns : 'Minimise';
      writeCollapsed(c);
    }
    setCollapsed(readCollapsed());

    function openPhone(open) {
      aside.classList.toggle('phone-open', open);
      overlay.classList.toggle('show', open);
      if (open) refresh();
    }

    toggle.addEventListener('click', () => {
      // On a phone this button closes the slide-over; on a laptop it minimises.
      if (phone.matches) openPhone(false);
      else { setCollapsed(!aside.classList.contains('collapsed')); if (!aside.classList.contains('collapsed')) refresh(); }
    });
    menu.addEventListener('click', () => openPhone(!aside.classList.contains('phone-open')));
    overlay.addEventListener('click', () => openPhone(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') openPhone(false); });
    const startNew = () => { openPhone(false); opts.onNew(); };
    aside.querySelector('.cs-new').addEventListener('click', startNew);
    aside.querySelector('.cs-plus').addEventListener('click', startNew);

    let seq = 0;
    async function refresh() {
      const list = aside.querySelector('.cs-list');
      const mine = ++seq;
      let data;
      try {
        const res = await fetch('/api/conversations?kind=' + encodeURIComponent(opts.kind), {
          headers: { Authorization: 'Bearer ' + opts.token() },
        });
        // A failure must not read as "nothing saved yet" -- that is a failure
        // disguised as good news.
        if (!res.ok) { if (mine === seq) list.innerHTML = '<div class="cs-empty">Could not load your ' + esc(nouns) + ' (' + res.status + ').</div>'; return; }
        data = await res.json();
      } catch (e) {
        if (mine === seq) list.innerHTML = '<div class="cs-empty">Could not load your ' + esc(nouns) + '.</div>';
        return;
      }
      if (mine !== seq) return;

      const items = (data && data.conversations) || [];
      if (items.length === 0) {
        list.innerHTML = '<div class="cs-empty">No saved ' + esc(nouns) + ' yet. Start one and it will appear here.</div>';
        return;
      }
      const current = opts.currentId();
      /**
       * Pinned first, under their own heading, then the recent ones (Khai,
       * 13 Oct 2026: "the ability to PIN events on the left column"). A pin is
       * saved on the server, so it is the same on a phone and a laptop.
       */
      const row = c =>
        '<div class="cs-item' + (c.id === current ? ' current' : '') + (c.pinned_at ? ' pinned' : '') + '" data-id="' + esc(c.id) + '">' +
          '<button class="cs-open" type="button"><span class="cs-title">' + esc(c.title || 'Untitled') + '</span>' +
            '<span class="cs-when">' + whenText(c.updated_at) + '</span></button>' +
          '<button class="cs-act cs-pin" type="button" data-pinned="' + (c.pinned_at ? '1' : '') + '" title="' + (c.pinned_at ? 'Unpin' : 'Pin to the top') + '" aria-label="' + (c.pinned_at ? 'Unpin' : 'Pin to the top') + '">' + PIN_SVG + '</button>' +
          '<button class="cs-act cs-rename" type="button" title="Rename">&#9998;</button>' +
          '<button class="cs-act cs-del" type="button" title="Delete">&times;</button>' +
        '</div>';
      const pins = items.filter(c => c.pinned_at);
      const rest = items.filter(c => !c.pinned_at);
      list.innerHTML =
        (pins.length ? '<div class="cs-section">Pinned</div>' + pins.map(row).join('') + (rest.length ? '<div class="cs-section">Recent</div>' : '') : '') +
        rest.map(row).join('');

      list.querySelectorAll('.cs-item').forEach(row => {
        const id = row.dataset.id;
        row.querySelector('.cs-open').addEventListener('click', () => { openPhone(false); opts.onOpen(id); });
        row.querySelector('.cs-pin').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          const res = await fetch('/api/conversations/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.token() },
            body: JSON.stringify({ pinned: !btn.dataset.pinned }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.error || 'Could not pin that ' + opts.noun + '.');
            btn.disabled = false;
            return;
          }
          refresh();
        });
        row.querySelector('.cs-rename').addEventListener('click', async () => {
          const next = prompt('Rename this ' + opts.noun, row.querySelector('.cs-title').textContent);
          if (next === null || !next.trim()) return;
          const res = await fetch('/api/conversations/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.token() },
            body: JSON.stringify({ title: next.trim() }),
          });
          if (!res.ok) { alert('Could not rename that ' + opts.noun + '.'); return; }
          refresh();
        });
        row.querySelector('.cs-del').addEventListener('click', async () => {
          if (!confirm('Delete "' + row.querySelector('.cs-title').textContent + '"? This cannot be undone.')) return;
          const res = await fetch('/api/conversations/' + id, {
            method: 'DELETE', headers: { Authorization: 'Bearer ' + opts.token() },
          });
          if (!res.ok) { alert('Could not delete that ' + opts.noun + '.'); return; }
          if (id === opts.currentId()) opts.onDeletedCurrent();
          refresh();
        });
      });
    }

    return { refresh, closePhone: () => openPhone(false) };
  }

  window.ConvSidebar = { mount };
})();
