/*
 * Design studio. Adds a "Дизайны" entry to the navigation and a panel with two
 * tabs: the gallery of designs other people published, and an editor where you
 * change colours, corners, textures and CSS, see it live, and publish it.
 *
 * It is a standalone script on purpose: it does not touch app.js. Session and
 * client id come from humancheck.js, which records them from the app's requests.
 *
 * The editor never applies raw CSS. Custom CSS goes through the Worker's
 * sanitiser first (/api/themes/sanitize), and the saved theme is the sanitised
 * result, so what runs on the page is always the allowlisted version.
 */
(() => {
  const KEY = 'cheatlab.userTheme';
  const cl = window.__cl || { session: '', client: '', api: '' };
  const ICON = (id) => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const VARS = [
    ['paper', 'Фон'], ['fog', 'Панели'], ['ink', 'Текст'], ['mute', 'Второй текст'],
    ['line', 'Линии'], ['accent', 'Акцент'], ['accent-ink', 'Текст на акценте'],
  ];
  const TEX = [
    ['Фон страницы', 'body{background-image:var(--tex-1);background-size:var(--tex-size,320px)}'],
    ['Боковая панель', '.rail{background-image:var(--tex-2);background-size:var(--tex-size,320px)}'],
    ['Карточки', '.row,.panel{background-image:var(--tex-3);background-size:var(--tex-size,320px)}'],
  ];

  /* ------------------------------------------------------------- applying */
  const sheet = () => {
    let s = document.getElementById('cl-user-theme');
    if (!s) { s = document.createElement('style'); s.id = 'cl-user-theme'; document.head.append(s); }
    return s;
  };
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const applySaved = () => { sheet().textContent = saved()?.css || ''; };
  const keep = (id, css) => { try { localStorage.setItem(KEY, JSON.stringify({ id, css })); } catch { /* private mode */ } applySaved(); };
  const reset = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } applySaved(); };

  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    if (cl.session) headers['x-cheatlab-session'] = cl.session;
    if (cl.client) headers['x-cheatlab-client'] = cl.client;
    const res = await fetch(cl.api + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((data.reasons && data.reasons.join(', ')) || data.error || 'Ошибка запроса'), { status: res.status });
    return data;
  }

  /* ---------------------------------------------------------------- state */
  const draft = () => ({ name: '', desc: '', vars: {}, radius: null, tex: ['', '', ''], css: '' });
  let st = { tab: 'gallery', themes: null, me: null, d: draft(), safeCustom: '', dropped: [], busy: false };
  let root, back, timer;

  const hexOf = (name) => {
    let v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map((c) => c + c).join('');
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
  };

  const texLocal = (d) => `:root{${d.tex.map((t, i) => (t ? `--tex-${i + 1}:url("${t}");` : '')).join('')}}`;
  const generated = (d) => {
    const set = VARS.filter(([k]) => d.vars[k]).map(([k]) => `--${k}:${d.vars[k]}`);
    if (d.radius !== null) set.push(`--r:${d.radius}px`);
    const head = set.length ? `:root,:root[data-theme="dark"],:root[data-theme="light"]{${set.join(';')}}` : '';
    return head + d.tex.map((t, i) => (t ? TEX[i][1] : '')).join('');
  };
  const preview = () => { sheet().textContent = texLocal(st.d) + generated(st.d) + st.safeCustom; };

  function sanitizeSoon() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await api('/api/themes/sanitize', { method: 'POST', body: JSON.stringify({ css: st.d.css }) });
        st.safeCustom = r.css; st.dropped = r.dropped || [];
      } catch { st.safeCustom = ''; }
      preview();
      const warn = root?.querySelector('[data-warn]');
      if (warn) { warn.hidden = !st.dropped.length; warn.textContent = `Убрано как небезопасное: ${st.dropped.join(', ')}`; }
    }, 450);
  }

  async function toTexture(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.7, 0.5, 0.35]) {
      const d = c.toDataURL('image/webp', q);
      if (d.length <= 170000) return d;
    }
    throw new Error('Текстура слишком тяжёлая. Возьмите меньшую или проще.');
  }

  /* --------------------------------------------------------------- views */
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.style.zIndex = 300; t.textContent = msg;
    document.body.append(t); setTimeout(() => t.remove(), 3400);
  }

  function shell() {
    return `<div class="st-head"><h2>Дизайны</h2>
      <div class="tabs" role="tablist" style="margin:0">
        <button class="tab" role="tab" data-tab="gallery" aria-selected="${st.tab === 'gallery'}">Галерея</button>
        <button class="tab" role="tab" data-tab="editor" aria-selected="${st.tab === 'editor'}">Редактор</button>
      </div>
      <button class="icon-btn" data-close aria-label="Закрыть">${ICON('i-back')}</button></div>
      <div class="st-body" data-body></div>`;
  }

  async function gallery(body) {
    body.innerHTML = '<p class="hint">Загрузка…</p>';
    try {
      if (!st.themes) st.themes = (await api('/api/themes')).themes;
      if (cl.session && !st.me) st.me = (await api('/api/auth/me')).user || null;
    } catch (e) { body.innerHTML = `<div class="empty"><h2>Галерея недоступна</h2><p>${esc(e.message)}</p></div>`; return; }
    const cur = saved()?.id;
    if (!st.themes.length) {
      body.innerHTML = `<div class="empty"><h2>Пока нет дизайнов</h2><p>Соберите свой в редакторе и опубликуйте. Он появится здесь.</p>
        <button class="btn btn-primary" data-tab="editor">Создать дизайн</button></div>`;
      return;
    }
    body.innerHTML = `<div class="st-grid">${st.themes.map((t) => `
      <article class="st-card${t.id === cur ? ' is-active' : ''}">
        <div class="st-swatch">${(t.palette.length ? t.palette : ['#222', '#555']).map((c) => `<i style="background:${esc(c)}"></i>`).join('')}</div>
        <div><h3>${esc(t.name)}</h3><p class="st-meta">${esc(t.author)}, применили ${t.installs}</p></div>
        ${t.description ? `<p class="st-note">${esc(t.description)}</p>` : ''}
        <div class="st-actions">
          <button class="btn btn-sm btn-primary" data-use="${t.id}">${t.id === cur ? 'Применён' : 'Применить'}</button>
          <button class="btn btn-sm" data-base="${t.id}">За основу</button>
          ${st.me && (st.me.id === t.authorId) ? `<button class="btn btn-sm btn-ghost" data-del="${t.id}">Удалить</button>` : ''}
        </div></article>`).join('')}</div>
      ${cur ? '<p style="margin-top:18px"><button class="btn btn-ghost" data-reset>Вернуть стандартный вид</button></p>' : ''}`;
  }

  function editor(body) {
    const d = st.d;
    const val = (k) => d.vars[k] || hexOf(k);
    body.innerHTML = `<div class="st-edit">
      <div class="st-col">
        <div class="field"><label class="label">Название</label><input class="input" data-f="name" maxlength="60" value="${esc(d.name)}" placeholder="Например, Графит"></div>
        <div class="field"><label class="label">Описание</label><input class="input" data-f="desc" maxlength="200" value="${esc(d.desc)}"></div>
        <div><p class="label" style="margin-bottom:8px">Цвета</p>
          <div class="st-colors">${VARS.map(([k, n]) => `<label class="st-color"><input type="color" data-var="${k}" value="${val(k)}">${n}</label>`).join('')}</div></div>
        <div class="field"><label class="label">Скругление углов: <span data-rv>${d.radius ?? 10}</span> px</label>
          <input type="range" min="0" max="24" value="${d.radius ?? 10}" data-radius></div>
        <div><p class="label" style="margin-bottom:8px">Текстуры</p>
          <div class="st-col" style="gap:8px">${TEX.map(([n], i) => `
            <div class="st-tex"><span class="st-tex-img" style="${d.tex[i] ? `background-image:url('${d.tex[i]}')` : ''}"></span>
              <span class="grow">${n}</span>
              <label class="btn btn-sm">Выбрать<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-tex="${i}" hidden></label>
              ${d.tex[i] ? `<button class="btn btn-sm btn-ghost" data-texoff="${i}">Убрать</button>` : ''}</div>`).join('')}</div>
          <p class="st-note" style="margin-top:8px">Картинки уменьшаются до 320 px и проверяются модерацией перед публикацией.</p></div>
      </div>
      <div class="st-col">
        <div class="field"><label class="label">Свой CSS</label>
          <textarea class="textarea" data-css spellcheck="false" placeholder=".row { border-radius: 4px; }">${esc(d.css)}</textarea></div>
        <p class="st-note">Можно: селекторы, переменные, анимации (@keyframes), @media. Нельзя: url(), @import, шрифты по ссылке, position: fixed. Такие строки удаляются.</p>
        <p class="st-warn" data-warn hidden></p>
        <div class="actions">
          <button class="btn btn-primary" data-keep>Применить у себя</button>
          <button class="btn" data-publish>Опубликовать</button>
          <button class="btn btn-ghost" data-clear>Сбросить</button>
        </div>
        <p class="st-note">Опубликованный дизайн попадает в галерею. Каждый дизайн и текстура проходят проверку модерации. Лимит: 5 дизайнов в сутки.</p>
      </div></div>`;
  }

  function paint() {
    root.innerHTML = shell();
    const body = root.querySelector('[data-body]');
    if (st.tab === 'gallery') gallery(body); else editor(body);
  }

  /* -------------------------------------------------------------- events */
  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.close !== undefined) return close();
    if (t.dataset.tab) { st.tab = t.dataset.tab; if (st.tab === 'gallery') { applySaved(); st.themes = null; } else preview(); return paint(); }
    try {
      if (t.dataset.use) {
        const { theme } = await api(`/api/themes/${t.dataset.use}`);
        keep(theme.id, theme.css); api(`/api/themes/${theme.id}/install`, { method: 'POST' }).catch(() => {});
        st.themes = null; toast('Дизайн применён'); return paint();
      }
      if (t.dataset.base) {
        const { theme } = await api(`/api/themes/${t.dataset.base}`);
        st.d = { ...draft(), name: `${theme.name} (копия)`, css: theme.css.replace(/^:root\{[^}]*\}\n?/, '') };
        st.tab = 'editor'; sanitizeSoon(); return paint();
      }
      if (t.dataset.del) { await api(`/api/themes/${t.dataset.del}`, { method: 'DELETE' }); st.themes = null; toast('Дизайн удалён'); return paint(); }
      if (t.dataset.reset !== undefined) { reset(); st.themes = null; toast('Стандартный вид'); return paint(); }
      if (t.dataset.texoff) { st.d.tex[+t.dataset.texoff] = ''; preview(); return paint(); }
      if (t.dataset.keep !== undefined) {
        const css = texLocal(st.d) + generated(st.d) + st.safeCustom;
        keep(null, css); toast('Применено'); return;
      }
      if (t.dataset.clear !== undefined) { st.d = draft(); st.safeCustom = ''; applySaved(); return paint(); }
      if (t.dataset.publish !== undefined) return publish(t);
    } catch (err) { toast(err.message); }
  }

  async function publish(btn) {
    if (!cl.session) return toast('Войдите в аккаунт, чтобы публиковать дизайны');
    const d = st.d;
    if (d.name.trim().length < 2) return toast('Введите название дизайна');
    btn.disabled = true;
    try {
      const css = generated(d) + '\n' + d.css;
      const r = await api('/api/themes', { method: 'POST', body: JSON.stringify({ name: d.name, description: d.desc, css, textures: d.tex }) });
      toast(r.moderation === 'ai' ? 'Опубликовано, модерация пройдена' : 'Опубликовано');
      st.d = draft(); st.themes = null; st.tab = 'gallery'; applySaved(); paint();
    } catch (err) { toast(err.status === 422 ? `Не опубликовано. ${err.message}` : err.message); }
    btn.disabled = false;
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.f) st.d[t.dataset.f === 'desc' ? 'desc' : 'name'] = t.value;
    else if (t.dataset.var) { st.d.vars[t.dataset.var] = t.value; preview(); }
    else if (t.dataset.radius !== undefined) { st.d.radius = +t.value; root.querySelector('[data-rv]').textContent = t.value; preview(); }
    else if (t.dataset.css !== undefined) { st.d.css = t.value; sanitizeSoon(); }
  }

  async function onChange(e) {
    const t = e.target;
    if (t.dataset.tex === undefined || !t.files[0]) return;
    try { st.d.tex[+t.dataset.tex] = await toTexture(t.files[0]); preview(); paint(); }
    catch (err) { toast(err.message || 'Не удалось прочитать картинку'); }
  }

  /* ------------------------------------------------------------ open/close */
  function open() {
    if (root) return;
    back = document.createElement('div'); back.className = 'st-back';
    root = document.createElement('div'); root.className = 'st'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Дизайны');
    document.body.append(back, root);
    back.addEventListener('click', close);
    root.addEventListener('click', onClick); root.addEventListener('input', onInput); root.addEventListener('change', onChange);
    document.addEventListener('keydown', onKey);
    paint();
  }
  function close() {
    applySaved();            // an unsaved preview never outlives the panel
    root?.remove(); back?.remove(); root = back = null;
    document.removeEventListener('keydown', onKey);
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  function mount() {
    const nav = document.querySelector('.nav');
    if (!nav || nav.querySelector('[data-studio]')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nav-link'; b.dataset.studio = '1';
    b.innerHTML = `${ICON('i-palette')}Дизайны`;
    b.addEventListener('click', open);
    const after = nav.querySelector('a[href="./chat"]');
    after ? after.after(b) : nav.append(b);

    // A tiny arrow sits inside the bottom navigation strip (not over page content).
    let hint = nav.querySelector('.nav-scroll-hint');
    if (!hint) {
      hint = document.createElement('span');
      hint.className = 'nav-scroll-hint';
      hint.textContent = '›';
      hint.setAttribute('aria-hidden', 'true');
      nav.append(hint);
    }
    const updateHint = () => {
      const maxScroll = nav.scrollWidth - nav.clientWidth;
      const canContinue = maxScroll > 4 && nav.scrollLeft < maxScroll - 8;
      hint.classList.toggle('is-hidden', !canContinue);
    };
    nav.addEventListener('scroll', updateHint, { passive: true });
    window.addEventListener('resize', updateHint, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(updateHint).observe(nav);
    updateHint();
  }

  applySaved();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
