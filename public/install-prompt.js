/**
 * "Add Sauron to your home screen", offered the first time someone opens it on
 * a phone (Khai, 13 Oct 2026). Two platforms, two mechanisms:
 *
 *   ANDROID (Chrome, Edge, Samsung): the browser hands the page an install
 *   event, so the offer carries an Install button that opens the system's own
 *   box. Shown only once that event has arrived -- without it a button would
 *   do nothing.
 *
 *   IPHONE / IPAD: Safari gives a page no way to install itself, so the offer
 *   shows the two taps instead: Share, then Add to Home Screen.
 *
 * Never on a computer, never inside the installed app itself, once installed
 * never again, and "Not now" rests it for two weeks. The choice lives in this
 * browser (sauron.install), which is right: installing is per phone.
 */
(function () {
  var KEY = 'sauron.install';
  var REST_DAYS = 14;

  function get() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }

  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  var ua = navigator.userAgent || '';
  var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var state = get();
  if (standalone) { if (!state.installed) set({ installed: true }); return; }
  if (!touch || state.installed || (state.restUntil && Date.now() < state.restUntil)) return;

  /**
   * ONLY ONCE THE PAGE KNOWS WHO THIS IS (13 Oct 2026: Khai's phone showed the
   * offer for a moment and then lost it -- "not a pop up but just flashes").
   * A page that finds nobody signed in sends them to sign in, taking the offer
   * with it. So nothing shows until the page confirms the person
   * (setNavOwner(..., true) fires 'sauron:signed-in'), then two seconds more.
   */
  var signedIn = !!window.sauronSignedIn;
  var waiting = null;
  function when(kind) {
    waiting = kind;
    if (signedIn) setTimeout(function () { show(kind); }, 2000);
  }
  window.addEventListener('sauron:signed-in', function () {
    if (signedIn) return;
    signedIn = true;
    if (waiting) setTimeout(function () { show(waiting); }, 2000);
  });

  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          // hold the browser's own mini-bar; ours explains why
    deferred = e;
    when('android');
  });
  window.addEventListener('appinstalled', function () { set({ installed: true }); hide(); });

  if (ios) when('ios');

  var box = null;
  function hide() { if (box) { box.remove(); box = null; } }
  function rest() { set({ restUntil: Date.now() + REST_DAYS * 864e5 }); hide(); }

  function show(kind) {
    if (box) return;
    var share = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
    box = document.createElement('div');
    box.className = 'install-offer';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Add Sauron to your home screen');
    box.innerHTML =
      '<img src="/brand/app-192.png" alt="" width="44" height="44">' +
      '<div class="io-text"><strong>Add Sauron to your home screen</strong>' +
      (kind === 'ios'
        ? '<span>Tap ' + share + ' <b>Share</b>, then <b>Add to Home Screen</b>. It opens full screen, like an app.</span>'
        : '<span>One tap, and it opens full screen like an app.</span>') +
      '</div>' +
      '<div class="io-actions">' +
      (kind === 'android' ? '<button type="button" class="io-install">Install</button>' : '') +
      '<button type="button" class="io-later">Not now</button></div>';
    document.body.appendChild(box);
    box.querySelector('.io-later').addEventListener('click', rest);
    var install = box.querySelector('.io-install');
    if (install) install.addEventListener('click', function () {
      if (!deferred) return hide();
      deferred.prompt();
      deferred.userChoice.then(function (r) {
        if (r && r.outcome === 'accepted') set({ installed: true }); else rest();
        deferred = null; hide();
      });
    });
  }
})();
