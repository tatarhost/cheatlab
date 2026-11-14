/* CHEATLAB motion + SPA route accessibility.
   One page-level entrance per route; no repeated card choreography. */
(() => {
  const view = document.getElementById('view');
  if (!view) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let lastSurface = null;
  let hasRenderedInitialRoute = false;
  let clearTimer = 0;

  function syncRouteContext(surface, moveFocus) {
    const heading = surface.querySelector('h1');
    if (!heading) return;

    const label = heading.textContent.trim().replace(/\s+/g, ' ');
    if (label) document.title = label + ' — CHEATLAB';

    if (moveFocus) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }

  function enterCurrentSurface() {
    const surface = view.firstElementChild;
    if (!surface) {
      lastSurface = null;
      view.classList.remove('cl-view-enter');
      return;
    }

    // Ignore the router's temporary loading state; animate and announce only
    // the fully rendered view.
    if (surface.matches('.hint') && surface.textContent.trim() === 'Загрузка...') return;
    if (surface === lastSurface) return;

    const moveFocus = hasRenderedInitialRoute;
    hasRenderedInitialRoute = true;
    lastSurface = surface;
    syncRouteContext(surface, moveFocus);

    window.clearTimeout(clearTimer);
    view.classList.remove('cl-view-enter');
    if (reduceMotion.matches) return;

    window.requestAnimationFrame(() => {
      if (view.firstElementChild !== surface) return;
      view.classList.add('cl-view-enter');
      clearTimer = window.setTimeout(() => view.classList.remove('cl-view-enter'), 340);
    });
  }

  const observer = new MutationObserver(() => enterCurrentSurface());
  observer.observe(view, { childList: true });
  window.addEventListener('pageshow', enterCurrentSurface, { passive: true });
  reduceMotion.addEventListener?.('change', () => {
    if (reduceMotion.matches) view.classList.remove('cl-view-enter');
  });
})();