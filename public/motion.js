/* CHEATLAB motion controller: one route-level entrance, no animated card cascade. */
(() => {
  const view = document.getElementById('view');
  if (!view) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let lastSurface = null;
  let clearTimer = 0;

  function enterCurrentSurface() {
    const surface = view.firstElementChild;
    if (!surface) {
      lastSurface = null;
      view.classList.remove('cl-view-enter');
      return;
    }

    // The router intentionally paints a temporary loading line before the page.
    // Wait for a real first surface so users do not see two consecutive entrances.
    if (surface.matches('.hint') && surface.textContent.trim() === 'Загрузка...') return;
    if (surface === lastSurface) return;

    lastSurface = surface;
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