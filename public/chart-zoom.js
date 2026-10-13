/*
 * Every chart opens full screen (Khai, 13 Oct 2026: "All charts need to be
 * expandable on mobile and computer because it's too small to see").
 *
 * One viewer for the dashboard, Weekly Recommends and Query; Query had its
 * own, which on a phone only re-fitted the chart to the same narrow screen.
 * The charts are SVGs drawn about 760 wide, so on a 390 px phone every label
 * is shrunk to half its size. The viewer therefore opens a chart at its OWN
 * width when the screen is narrower -- the labels at the size they were drawn,
 * scrolling sideways -- and fits it when the screen is wider. + and - zoom from
 * there, and pinch-zoom still works because the page never disables it.
 *
 * Tap or click a chart to open; the cross, Escape, or the phone's Back closes.
 */
(function () {
  // Containers that ARE a chart: Query's chart cards, the dashboard's sales
  // chart and its ask-bar charts, and any chart a recommendation carries.
  var ZOOMABLE = '.chart-card, .chart, .ask-chart, .zoom-chart';

  var view = null, scroller = null, content = null, fit = 0, natural = 0, width = 0, pushed = false;

  function build() {
    view = document.createElement('div');
    view.id = 'zoom-view';
    view.setAttribute('role', 'dialog');
    view.setAttribute('aria-modal', 'true');
    view.setAttribute('aria-label', 'Chart, full screen');
    view.hidden = true;
    view.innerHTML =
      '<div class="zv-bar">' +
        '<button type="button" class="zv-btn" data-zv="out" aria-label="Zoom out">−</button>' +
        '<button type="button" class="zv-btn zv-fit" data-zv="fit">Fit</button>' +
        '<button type="button" class="zv-btn" data-zv="in" aria-label="Zoom in">+</button>' +
        '<span class="zv-hint">Turn your phone sideways for a bigger view</span>' +
        '<button type="button" class="zv-btn zv-close" data-zv="close" aria-label="Close chart">×</button>' +
      '</div>' +
      '<div class="zv-scroll"><div class="zv-content"></div></div>';
    document.body.appendChild(view);
    scroller = view.querySelector('.zv-scroll');
    content = view.querySelector('.zv-content');
    view.addEventListener('click', function (e) {
      var b = e.target.closest('[data-zv]');
      if (!b) return;
      var act = b.getAttribute('data-zv');
      if (act === 'close') return close();
      if (act === 'fit') return size(fit);
      if (act === 'in') return size(width * 1.25);
      if (act === 'out') return size(width / 1.25);
    });
  }

  function size(w) {
    var max = Math.max(fit, natural) * 4;
    width = Math.round(Math.min(max, Math.max(fit, w)));
    content.style.width = width + 'px';
  }

  function open(el) {
    if (!view) build();
    // The whole card (heading, legend, chart) where it has one; a lone SVG
    // otherwise. A copy, so closing can never disturb the page's own chart.
    content.innerHTML = el.tagName.toLowerCase() === 'svg' ? el.outerHTML : el.innerHTML;
    content.querySelectorAll('button, .report-link').forEach(function (n) { n.remove(); });
    view.hidden = false;
    document.documentElement.classList.add('zv-open');

    var svg = content.querySelector('svg');
    var vb = svg && svg.viewBox && svg.viewBox.baseVal;
    natural = vb && vb.width ? vb.width : 0;
    fit = scroller.clientWidth - 32;
    // Narrower than the chart was drawn: open at its own width, so the labels
    // are their drawn size. Wider: fit the screen, which only enlarges them.
    size(natural > fit ? natural : fit);
    scroller.scrollLeft = 0; scroller.scrollTop = 0;

    // The phone's Back closes the chart rather than leaving the page.
    try { history.pushState({ zoomView: true }, ''); pushed = true; } catch (_) { pushed = false; }
    view.querySelector('.zv-close').focus({ preventScroll: true });
  }

  function close(fromBack) {
    if (!view || view.hidden) return;
    view.hidden = true;
    content.innerHTML = '';
    document.documentElement.classList.remove('zv-open');
    if (pushed && !fromBack) { pushed = false; try { history.back(); } catch (_) { /* ignore */ } }
    pushed = false;
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.target.closest('#zoom-view, a, button, input, select, textarea, summary')) return;
    var el = e.target.closest(ZOOMABLE);
    if (!el || !el.querySelector('svg')) return;
    e.preventDefault();
    open(el);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  window.addEventListener('popstate', function () { if (view && !view.hidden) close(true); });

  window.chartZoom = { open: open, close: close };
})();
