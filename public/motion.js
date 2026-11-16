/* CHEATLAB motion + SPA route accessibility.
   One page-level entrance per route; no repeated card choreography. */
(() => {
  const view = document.getElementById('view');
  if (!view) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.querySelectorAll('svg.i').forEach((node) => node.setAttribute('aria-hidden', 'true'));
  let lastSurface = null;
  let hasRenderedInitialRoute = false;
  let clearTimer = 0;

  function syncRouteContext(surface, moveFocus) {
    const heading = surface.querySelector('h1');
    if (!heading) {
      document.title = 'CHEATLAB';
      return;
    }

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

/*
 * Material motion engine.
 *
 * The app can replace the contents of #view at any moment, so pointer handling
 * is delegated from document. Every small hover response is still a real spring:
 * one accumulator, one fixed 60 Hz step, no CSS timer pretending to be physics.
 */
(() => {
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const controls = new Map();
  const STEP = 1 / 60;
  const CONTROL_SELECTOR = '.btn, .icon-btn, .nav-link, .tab, .mail-folder, .chat-attach, .chat-send, .theme-toggle-mobile, .rail-stat, .cl-publish-global';
  let reducedMotion = reduced.matches;
  let accumulator = 0;
  let lastTime = performance.now();
  let frameRunning = false;

  function makeNoise() {
    if (root.style.getPropertyValue('--noise-url')) return;
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    canvas.className = 'cl-noise-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.hidden = true;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    const image = context.createImageData(96, 96);
    let seed = 0x6d2b79f5;
    const random = () => {
      seed |= 0;
      seed = seed + 0x6D2B79F5 | 0;
      let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
      value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
    for (let i = 0; i < image.data.length; i += 4) {
      const shade = Math.floor(100 + random() * 110);
      image.data[i] = shade;
      image.data[i + 1] = shade;
      image.data[i + 2] = shade;
      image.data[i + 3] = Math.floor(12 + random() * 28);
    }
    context.putImageData(image, 0, 0);
    document.body.append(canvas);
    root.style.setProperty('--noise-url', `url("${canvas.toDataURL('image/png')}")`);
  }

  class Spring {
    constructor(value = 0, stiffness = 260, damping = 27) {
      this.value = value;
      this.target = value;
      this.velocity = 0;
      this.stiffness = stiffness;
      this.damping = damping;
    }
    setTarget(value) { this.target = value; }
    step(dt) {
      if (reducedMotion) {
        this.value = this.target;
        this.velocity = 0;
        return;
      }
      const acceleration = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += acceleration * dt;
      this.value += this.velocity * dt;
      if (Math.abs(this.target - this.value) < .001 && Math.abs(this.velocity) < .001) {
        this.value = this.target;
        this.velocity = 0;
      }
    }
  }

  function getControl(target) {
    const element = target instanceof Element ? target.closest(CONTROL_SELECTOR) : null;
    if (!element) return null;
    let state = controls.get(element);
    if (!state) {
      state = { element, x: new Spring(), y: new Spring(), hovered: false };
      controls.set(element, state);
      element.classList.add('cl-spring-target', 'cl-ripple-host');
      element.style.setProperty('--cl-mx', '0px');
      element.style.setProperty('--cl-my', '0px');
    }
    return state;
  }

  function startFrame() {
    if (frameRunning) return;
    frameRunning = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    frameRunning = false;
    const elapsed = Math.min(.1, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    accumulator += elapsed;
    while (accumulator >= STEP) {
      for (const [element, state] of controls) {
        if (!element.isConnected) { controls.delete(element); continue; }
        state.x.step(STEP);
        state.y.step(STEP);
      }
      accumulator -= STEP;
    }
    for (const state of controls.values()) {
      state.element.style.setProperty('--cl-mx', `${state.x.value.toFixed(2)}px`);
      state.element.style.setProperty('--cl-my', `${state.y.value.toFixed(2)}px`);
    }
    if (controls.size) startFrame();
  }

  function isFinePointer(event) {
    return event.pointerType === 'mouse' || event.pointerType === 'pen';
  }

  function isInside(element, related) {
    return related instanceof Node && element.contains(related);
  }

  document.addEventListener('pointerover', (event) => {
    if (!isFinePointer(event)) return;
    const state = getControl(event.target);
    if (!state || isInside(state.element, event.relatedTarget)) return;
    state.hovered = true;
    startFrame();
  }, { passive: true });

  document.addEventListener('pointermove', (event) => {
    if (!isFinePointer(event)) return;
    const state = getControl(event.target);
    if (!state) return;
    const rect = state.element.getBoundingClientRect();
    const dx = (event.clientX - (rect.left + rect.width / 2)) / Math.max(rect.width, 1);
    const dy = (event.clientY - (rect.top + rect.height / 2)) / Math.max(rect.height, 1);
    state.x.setTarget(Math.max(-3, Math.min(3, dx * 4)));
    state.y.setTarget(Math.max(-2, Math.min(2, dy * 3)));
    startFrame();
  }, { passive: true });

  document.addEventListener('pointerout', (event) => {
    if (!isFinePointer(event)) return;
    const state = getControl(event.target);
    if (!state || isInside(state.element, event.relatedTarget)) return;
    state.hovered = false;
    state.x.setTarget(0);
    state.y.setTarget(0);
    startFrame();
  }, { passive: true });

  document.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target.closest('.btn, .icon-btn, .chat-send, .chat-attach, .cl-publish-global') : null;
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    const ripple = document.createElement('span');
    const rect = target.getBoundingClientRect();
    ripple.className = 'cl-ripple';
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    target.append(ripple);
    window.setTimeout(() => ripple.remove(), 560);
  }, { passive: true });

  const refreshReducedMotion = () => {
    reducedMotion = reduced.matches;
    if (reducedMotion) {
      for (const state of controls.values()) {
        state.x.value = state.x.target;
        state.y.value = state.y.target;
        state.x.velocity = 0;
        state.y.velocity = 0;
      }
    }
  };
  if (reduced.addEventListener) reduced.addEventListener('change', refreshReducedMotion);
  else reduced.addListener(refreshReducedMotion);

  makeNoise();
  document.querySelectorAll(CONTROL_SELECTOR).forEach(getControl);
})();