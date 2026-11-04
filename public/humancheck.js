/*
 * Bot check for sign-in and registration. Loaded as a plain script before
 * app.js, so it wraps fetch without touching the app's own code.
 *
 * What it does on login and register:
 *   1. asks the Worker for a signed challenge,
 *   2. solves a small proof of work in a background thread,
 *   3. shows one question, and
 *   4. adds the result to the request body as `hc`.
 * The Worker (guard.js) verifies all of it before the request reaches the login
 * handler. It also remembers the session and client id the app sends, so the
 * design studio can call the API as the same person without reading app.js state.
 */
(() => {
  const meta = document.querySelector('meta[name="cheatlab-api"]');
  const API = ((meta && meta.content) || '').replace(/\/$/, '');
  const real = window.fetch.bind(window);
  const creds = (window.__cl = { session: '', client: '', api: API });

  const POW_WORKER = `onmessage = async (e) => {
    const { c, bits } = e.data, enc = new TextEncoder();
    for (let n = 0; ; n++) {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(c + '.' + n)));
      let z = 0;
      for (const b of d) { if (b === 0) { z += 8; continue; } z += Math.clz32(b) - 24; break; }
      if (z >= bits) { postMessage(String(n)); return; }
    }
  };`;

  function solve(challenge, bits) {
    const url = URL.createObjectURL(new Blob([POW_WORKER], { type: 'text/javascript' }));
    const w = new Worker(url);
    return {
      done: new Promise((res) => { w.onmessage = (e) => { res(e.data); w.terminate(); URL.revokeObjectURL(url); }; w.postMessage({ c: challenge, bits }); }),
      cancel() { w.terminate(); URL.revokeObjectURL(url); },
    };
  }

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };

  async function humanCheck(client) {
    let ch;
    try {
      const r = await real(`${API}/api/hc/challenge`, { headers: client ? { 'x-cheatlab-client': client } : {} });
      if (!r.ok) throw new Error('challenge');
      ch = await r.json();
    } catch { return { error: 'Проверка недоступна. Обновите страницу и попробуйте ещё раз.' }; }

    const job = solve(ch.challenge, ch.bits);
    return new Promise((resolve) => {
      const input = el('input', { class: 'input', inputmode: 'numeric', autocomplete: 'off', 'aria-label': 'Ответ' });
      // A field a person never sees and a script tends to fill.
      const trap = el('input', { tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-9999px;opacity:0;height:0;width:0' });
      const status = el('p', { class: 'hint' }, 'Идёт проверка браузера…');
      const go = el('button', { class: 'btn btn-primary', type: 'button' }, 'Подтвердить');
      const no = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Отмена');
      const card = el('div', { class: 'auth-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Проверка' },
        el('h1', {}, 'Вы не бот?'),
        el('p', { class: 'page-sub' }, 'Ответьте на вопрос, чтобы продолжить.'),
        el('div', { class: 'field' }, el('label', { class: 'label' }, ch.captcha.q), input, trap),
        status,
        el('div', { class: 'field-row' }, go, no));
      const back = el('div', { class: 'modal-backdrop' }, card);
      document.body.append(back);
      input.focus();

      const close = (v) => { job.cancel(); back.remove(); resolve(v); };
      const submit = async () => {
        if (!input.value.trim()) { input.focus(); return; }
        go.disabled = true; status.textContent = 'Проверяем…';
        const nonce = await job.done;
        close({ hc: { c: ch.challenge, n: nonce, ct: ch.captcha.token, ca: input.value.trim() }, hp: trap.value });
      };
      go.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      no.addEventListener('click', () => close(null));
      back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
      job.done.then(() => { if (!go.disabled) status.textContent = 'Браузер проверен.'; });
    });
  }

  window.fetch = async function (input, init) {
    init = init || {};
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const url = isReq ? input.url : String(input);
    const method = String(init.method || (isReq ? input.method : 'GET')).toUpperCase();
    const hs = new Headers(init.headers || (isReq ? input.headers : undefined));

    const s = hs.get('x-cheatlab-session');
    const c = hs.get('x-cheatlab-client');
    if (s) creds.session = s;
    if (c) creds.client = c;

    let path = '';
    try { path = new URL(url, location.href).pathname; } catch { /* relative oddity */ }
    const isLogin = method === 'POST' && /\/api\/auth\/login$/.test(path);
    const isRegister = method === 'POST' && /\/api\/auth\/register$/.test(path);

    // Registration already solves its own proof of work in app.js. The Worker only
    // checks the human challenge once that is present, so ask for it at that point.
    if ((isLogin || (isRegister && hs.get('x-cheatlab-pow-nonce'))) && typeof init.body === 'string') {
      const res = await humanCheck(c || creds.client);
      if (!res) return new Response(JSON.stringify({ error: 'Проверка отменена' }), { status: 400, headers: { 'content-type': 'application/json' } });
      if (res.error) return new Response(JSON.stringify({ error: res.error }), { status: 503, headers: { 'content-type': 'application/json' } });
      let body = {};
      try { body = JSON.parse(init.body); } catch { /* keep empty */ }
      body.hc = res.hc; body.hp = res.hp;
      return real(input, { ...init, body: JSON.stringify(body) });
    }
    return real(input, init);
  };
})();
