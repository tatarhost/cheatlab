/*
 * One visual ring challenge for login and registration.
 * The API returns { captcha: { token, rings, q } }; the answer is the sorted
 * indices of rings whose gap is zero. No second text CAPTCHA or POW worker.
 */
(() => {
  const meta = document.querySelector('meta[name="cheatlab-api"]');
  const API = ((meta && meta.content) || '').replace(/\/$/, '');
  const real = window.fetch.bind(window);
  const creds = (window.__cl = { session: '', client: '', api: API });

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };

  async function humanCheck(client) {
    let captcha;
    try {
      const response = await real(`${API}/api/hc/challenge`, {
        headers: client ? { 'x-cheatlab-client': client } : {},
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('challenge');
      const data = await response.json();
      captcha = data && data.captcha;
      if (!captcha || !captcha.token || !Array.isArray(captcha.rings) || captcha.rings.length !== 9) {
        throw new Error('bad challenge format');
      }
    } catch {
      return { error: 'Не удалось загрузить проверку. Обновите страницу и попробуйте ещё раз.' };
    }

    return new Promise((resolve) => {
      const selected = new Set();
      let clicks = 0;
      let finished = false;
      const style = el('style');
      style.textContent = `
        .hc-ring-grid{display:grid;grid-template-columns:repeat(3,minmax(64px,1fr));gap:12px;max-width:280px;margin:18px auto}
        .hc-ring{display:grid;place-items:center;aspect-ratio:1;border:1px solid var(--line,#333);border-radius:16px;background:var(--panel,#171717);cursor:pointer;touch-action:manipulation}
        .hc-ring[aria-pressed="true"]{border-color:var(--accent,#aaa);background:var(--hover,rgba(255,255,255,.1));box-shadow:0 0 0 2px rgba(160,160,160,.2)}
        .hc-ring svg{width:38px;height:38px;overflow:visible}
        .hc-ring circle{fill:none;stroke:currentColor;stroke-width:3.5;stroke-linecap:round}
        .hc-ring:focus-visible{outline:2px solid currentColor;outline-offset:3px}
      `;
      const status = el('p', { class: 'hint', role: 'status' }, 'Отметьте все кольца без разрыва.');
      const go = el('button', { class: 'btn btn-primary', type: 'button' }, 'Подтвердить');
      const no = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Отмена');
      const grid = el('div', { class: 'hc-ring-grid', role: 'group', 'aria-label': captcha.q });
      captcha.rings.forEach((ring, index) => {
        const button = el('button', { class: 'hc-ring', type: 'button', 'aria-label': `Кольцо ${index + 1}`, 'aria-pressed': 'false' });
        const circle = el('circle', { cx: '20', cy: '20', r: '15' });
        if (Number(ring.gap) > 0) {
          circle.setAttribute('stroke-dasharray', '78 16');
          circle.setAttribute('transform', `rotate(${Math.round(Number(ring.offset || 0) * 360)} 20 20)`);
        }
        button.append(el('svg', { viewBox: '0 0 40 40', 'aria-hidden': 'true' }, circle));
        button.addEventListener('click', () => {
          if (finished) return;
          clicks++;
          if (selected.has(index)) selected.delete(index); else selected.add(index);
          button.setAttribute('aria-pressed', selected.has(index) ? 'true' : 'false');
          status.textContent = `Выбрано: ${selected.size}. Отметьте все полностью замкнутые кольца.`;
        });
        grid.append(button);
      });

      const trap = el('input', {
        tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true',
        style: 'position:absolute;left:-9999px;opacity:0;height:0;width:0',
      });
      const card = el('div', { class: 'auth-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Проверка' },
        el('h1', {}, 'Вы не бот?'),
        el('p', { class: 'page-sub' }, captcha.q || 'Выберите все полностью замкнутые кольца.'),
        grid, trap, status,
        el('div', { class: 'field-row' }, go, no));
      const back = el('div', { class: 'modal-backdrop' }, card);
      document.head.append(style);
      document.body.append(back);

      const close = (value) => {
        if (finished) return;
        finished = true;
        back.remove();
        style.remove();
        resolve(value);
      };
      go.addEventListener('click', () => {
        if (finished) return;
        if (!selected.size) {
          status.textContent = 'Сначала выберите замкнутые кольца.';
          return;
        }
        go.disabled = true;
        status.textContent = 'Проверяем ответ…';
        close({
          hc: {
            ct: captcha.token,
            ca: JSON.stringify([...selected].sort((a, b) => a - b)),
            k: clicks,
          },
          hp: trap.value,
        });
      });
      no.addEventListener('click', () => close(null));
      back.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close(null);
      });
      go.focus();
    });
  }

  window.fetch = async function (input, init) {
    init = init || {};
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = isRequest ? input.url : String(input);
    const method = String(init.method || (isRequest ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init.headers || (isRequest ? input.headers : undefined));
    const session = headers.get('x-cheatlab-session');
    const client = headers.get('x-cheatlab-client');
    if (session) creds.session = session;
    if (client) creds.client = client;

    let path = '';
    try { path = new URL(url, location.href).pathname; } catch {}
    const login = method === 'POST' && /\/api\/auth\/login$/.test(path);
    const register = method === 'POST' && /\/api\/auth\/register$/.test(path);

    // Registration keeps its existing password-work step; both flows get one
    // and only one ring CAPTCHA immediately before the auth request.
    if ((login || (register && headers.get('x-cheatlab-pow-nonce'))) && typeof init.body === 'string') {
      const result = await humanCheck(client || creds.client);
      if (!result) return new Response(JSON.stringify({ error: 'Проверка отменена' }), { status: 400, headers: { 'content-type': 'application/json' } });
      if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: 503, headers: { 'content-type': 'application/json' } });
      let body = {};
      try { body = JSON.parse(init.body); } catch {}
      body.hc = result.hc;
      body.hp = result.hp;
      return real(input, { ...init, body: JSON.stringify(body) });
    }
    return real(input, init);
  };
})();
