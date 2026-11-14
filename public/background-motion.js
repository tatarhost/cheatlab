/* Controls the optional Frutiger Aero background video.
   It is decorative, never runs in the default monochrome theme, and can be paused. */
(() => {
  const video = document.getElementById('siteVideoBackground');
  if (!video) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const controls = [...document.querySelectorAll('.background-motion-toggle')];
  let pausedByUser = false;

  video.loop = true;
  video.muted = true;
  video.playsInline = true;

  function sync() {
    const themeAllowsMotion = document.documentElement.dataset.theme === 'aero';
    const shouldPlay = themeAllowsMotion && !reduced.matches && !pausedByUser && !document.hidden;

    if (shouldPlay) {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    } else {
      video.pause();
    }

    for (const button of controls) {
      button.setAttribute('aria-pressed', String(shouldPlay));
      button.setAttribute('aria-label', 'Анимация фонового видео');
      button.title = shouldPlay ? 'Остановить фоновую анимацию' : 'Включить фоновую анимацию';
      const label = button.querySelector('span');
      if (label) label.textContent = shouldPlay ? 'Фон: движется' : 'Фон: остановлен';
    }
  }

  for (const button of controls) {
    button.addEventListener('click', () => {
      pausedByUser = !pausedByUser;
      sync();
    });
  }

  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener?.('change', sync);
  sync();
})();