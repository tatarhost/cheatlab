const KEY_STORE = 'cheatlab.keys';
/**
 * Access keys for locked publications.
 *
 * Kept apart from the edit keys on purpose: the edit secret is a capability
 * that grants write access, while the access key is a shareable read password
 * that the author hands to readers. Mixing them in one blob would mean every
 * shared key also came with edit rights, so the export on "Мои загрузки" would
 * leak them together.
 */
const ACCESS_STORE = 'cheatlab.access';
const ID_STORE = 'cheatlab.client';

const TYPE_ICON = { script: 'code', app: 'box', paste: 'clip', image: 'image', video: 'video', file: 'file' };
const TYPE_LABEL = {
  script: 'Скрипт', app: 'Приложение', paste: 'Паста',
  image: 'Изображение', video: 'Видео', file: 'Файл',
};
const LANG_LABEL = {
  luau: 'Luau', lua: 'Lua', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
  csharp: 'C#', cpp: 'C++', c: 'C', java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  bash: 'Bash', powershell: 'PowerShell', html: 'HTML', css: 'CSS', json: 'JSON',
  yaml: 'YAML', sql: 'SQL', glsl: 'GLSL', text: 'Текст',
};

const $view = document.getElementById('view');
const $toast = document.getElementById('toast');
let config = { types: ['script', 'app', 'paste', 'image', 'video', 'file'], languages: ['text'], limits: { maxFileBytes: 25 * 1024 * 1024 } };

// ---------------------------------------------------------------- utilities

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'href') el.setAttribute('href', appPath(String(v)));
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const bytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

const when = (ts) => {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const ago = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  if (s < 2592000) return `${Math.floor(s / 86400)} дн назад`;
  return when(ts);
};

let toastTimer;
function toast(message, bad = false) {
  $toast.replaceChildren(icon(bad ? 'alert' : 'check', 'i i-sm'), h('span', { text: message }));
  $toast.classList.toggle('is-bad', bad);
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, bad ? 6000 : 2600);
}

function loadKeys() {
  try { return JSON.parse(localStorage.getItem(KEY_STORE) || '{}'); } catch { return {}; }
}
function saveKeys(keys) {
  localStorage.setItem(KEY_STORE, JSON.stringify(keys));
}
function keyFor(id) { return loadKeys()[id] || null; }
function rememberKey(id, secret) {
  const keys = loadKeys();
  keys[id] = secret;
  saveKeys(keys);
}

/** Access keys, shaped exactly like the edit keys: { itemId: key }. */
function loadAccess() {
  try { return JSON.parse(localStorage.getItem(ACCESS_STORE) || '{}'); } catch { return {}; }
}
function saveAccess(map) {
  try { localStorage.setItem(ACCESS_STORE, JSON.stringify(map || {})); } catch { /* private mode */ }
}
function accessFor(id) { return loadAccess()[id] || null; }
function rememberAccess(id, key) {
  const map = loadAccess();
  map[id] = key;
  saveAccess(map);
}
function forgetAccess(id) {
  const map = loadAccess();
  if (map[id]) { delete map[id]; saveAccess(map); }
}

/**
 * A stable per-browser id, used for quota accounting and to bind sessions to
 * this browser.
 *
 * Generated once and kept in localStorage. If storage is unavailable - private
 * mode, blocked cookies - the id falls back to memory for this page load, which
 * is worse for the user's quota but far better than throwing: this runs at module
 * scope, so an exception here would take the whole page down before it rendered.
 * Sessions need the same id, so a fallback id also means not being signed in
 * across reloads, which is the correct trade.
 */
function clientId() {
    let id = null;
    try {
      id = localStorage.getItem(ID_STORE);
      if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
        id = makeClientId();
        localStorage.setItem(ID_STORE, id);
      }
    } catch {
      id = makeClientId();
    }
    return id;
  }

  function makeClientId() {
    const bytesRaw = crypto.getRandomValues(new Uint8Array(24));
    // 24 bytes base64url-encoded: 32 characters, matching the server's
    // /^[A-Za-z0-9_-]{16,64}$/ requirement for a client id.
    return btoa(String.fromCharCode(...bytesRaw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
const CLIENT = clientId();

/* ------------------------------------------------------------------ session */

/**
 * Signed-in account state.
 *
 * The token is a bearer credential, so it is kept in localStorage like the edit
 * keys already are. That is a deliberate trade: it survives a reload and works
 * offline, but any script that can run on this origin can read it. The server
 * limits the damage by binding each session to the client id that created it,
 * so a stolen token is useless from another browser, and there is no password or
 * recovery question stored client-side to go with it.
 */
const SESSION_STORE = 'cheatlab.session';

let session = readSession();
let account = null; // populated by /api/auth/me on boot

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_STORE) || 'null');
    if (raw && typeof raw.token === 'string' && raw.token.length >= 20) return raw;
  } catch { /* corrupt or absent */ }
  return null;
}

function saveSession(next) {
  session = next && next.token ? next : null;
  try {
    if (session) localStorage.setItem(SESSION_STORE, JSON.stringify(session));
    else localStorage.removeItem(SESSION_STORE);
  } catch { /* private mode; the session simply will not persist */ }
  renderAccountChip();
}

const signedIn = () => Boolean(session);

/* -------------------------------------------------------------- proof of work */

/**
 * Solves the registration proof of work.
 *
 * The server wants a nonce where sha256(`${challenge}.${nonce}`) starts with
 * POW_BITS zero bits. This is a busy loop on purpose: it is the work the server
 * is charging for, and yielding every few thousand tries keeps the tab from
 * being declared unresponsive without meaningfully slowing it down.
 */
/**
 * Finds a nonce whose sha256(`${challenge}.${nonce}`) starts with `bits` zero
 * bits - the same definition the server checks, counted bit by bit.
 *
 * Kept deliberately readable: it is the piece of client code whose correctness
 * decides whether registration is possible at all, so it must match the server
 * exactly rather than approximately.
 */
async function solvePow(challenge, bits, onProgress) {
    const enc = new TextEncoder();
    let nonce = 0;
    for (;;) {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}.${nonce}`)),
      );
      let zeros = 0;
      for (let i = 0; i < digest.length && digest[i] === 0; i++) zeros += 8;
      if (zeros < digest.length * 8 && digest[zeros >> 3]) {
        zeros += Math.clz32(digest[zeros >> 3]) - 24;
      }
      if (zeros >= bits) return String(nonce);
      nonce++;
      if (onProgress && nonce % 20000 === 0) {
        onProgress(nonce);
        // Yield so paint and input still work while the loop runs.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

/**
 * API base URL.
 *
 * The site is static on GitHub Pages while the API is a Cloudflare Worker, so
 * requests need an absolute base. It is read from a meta tag so the same files
 * still work unchanged when both sit behind one origin.
 */
const API = ((document.querySelector('meta[name="cheatlab-api"]') || {}).content || '').replace(/\/+$/, '');

// The static host is not the API. When the meta tag is empty, relative requests
// leave the site, reach a host that has nothing at that path and come back as
// someone else's HTML error page. Detect that up front so the UI can say what
// is actually wrong instead of surfacing a confusing failed fetch.
const STATIC_HOSTS = /(\.|^)(github\.io|githubusercontent\.com|pages\.dev|netlify\.app|vercel\.app)$/i;
const API_UNSET = !API && STATIC_HOSTS.test(location.hostname);

/**
 * Media, file and raw URLs.
 *
 * `<img>`, `<video>` and "open in a new tab" cannot set request headers, so for
 * a locked item the access key travels as `?key=` instead - the only routes that
 * accept it. For an open item the query is omitted entirely, so a shared link
 * never carries someone else's key in its URL.
 */
const withKey = (url, key) => (key ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url);
const fileUrl = (id, key) => withKey(`${API}/f/${id}`, key);
const rawFileUrl = (id, key) => withKey(`${API}/f/${id}/raw`, key);
const mediaUrl = (id, key) => withKey(`${API}/m/${id}`, key);
const textUrl = (id, key) => withKey(`${API}/r/${id}`, key);
const isImageFile = (f) => /^image\//.test(f.mime || '');
const isVideoFile = (f) => /^video\//.test(f.mime || '');
const isAudioFile = (f) => /^audio\//.test(f.mime || '');

/**
 * One API call. `key` sends an item's access key in `x-cheatlab-key`, which is
 * how a locked publication answers with its contents instead of a shell.
 */
async function api(path, { method = 'GET', body, secret, key, signal, noAuth, headers: extra } = {}) {
  const headers = { 'x-cheatlab-client': CLIENT };
  if (secret) headers['x-cheatlab-secret'] = secret;
  if (key) headers['x-cheatlab-key'] = key;
  Object.assign(headers, extra || {});
  // Sent on everything except the endpoints that establish or end a session, so
  // a stale token cannot make a fresh login look signed-in.
  if (session && !noAuth) headers['x-cheatlab-session'] = session.token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }

  // The API lives on its own host. If it was never configured, the request goes
  // to the static site instead and comes back as an HTML error page, which would
  // otherwise surface as a bare "server unavailable".
  if (data === null) {
    const err = new Error(
      API
        ? `${API} ответил не JSON (${res.status}). Проверьте, что по этому адресу развёрнут Worker.`
        : 'Не задан адрес API. Впишите его в <meta name="cheatlab-api"> в index.html — например командой '
          + '`node scripts/set-api-url.mjs https://<ваш-worker>.workers.dev`, затем задеплойте сайт.',
    );
    err.status = res.status;
    err.misconfigured = true;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.reasons = data.reasons;
    // The whole payload, so callers can react to a captcha challenge, a daily
    // limit or a hint without a second round trip.
    err.data = data;
    // A token the server no longer accepts (expired, revoked, or issued to a
    // different browser) is dropped here rather than on every call site.
    if (res.status === 401 && session && !noAuth) saveSession(null);
    throw err;
  }
  return data;
}

/* -------------------------------------------------------------- account API */

/** Server-advertised proof-of-work difficulty, from /api/config. */
const powBits = () => Math.min(30, Math.max(8, Number(config?.powBits) || 18));

/**
 * Registers, paying the proof of work first.
 *
 * Registration is the only place the challenge is strictly required, and it is
 * also the one place a bot most wants, so the work is done before the request
 * rather than after a rejection.
 */
async function registerAccount({ nick, password }, onProgress) {
  const { challenge } = await api('/api/auth/pow', { noAuth: true });
  const nonce = await solvePow(challenge, powBits(), onProgress);
  // The proof travels in headers, not the body: powGate reads it from there so a
  // body field can never be replayed as if it were the verified work.
  return api('/api/auth/register', {
    method: 'POST',
    noAuth: true,
    body: { nick, password },
    headers: { 'x-cheatlab-pow': challenge, 'x-cheatlab-pow-nonce': nonce },
  });
}

async function loginAccount({ nick, password }) {
  return api('/api/auth/login', { method: 'POST', noAuth: true, body: { nick, password } });
}

async function logoutAccount() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // A failed logout still clears the local token: the user asked to be signed
    // out, and keeping a credential we could not revoke is the worse outcome.
  }
  saveSession(null);
  account = null;
  renderAccountChip();
}

/** Refreshes the cached account from the server. Cheap, and called on boot. */
async function refreshAccount() {
  if (!signedIn()) {
    account = null;
    // Still render: a first-time visitor has no session, and the rail has to
    // offer them the way in. Returning before this leaves it blank.
    renderAccountChip();
    return null;
  }
  try {
    const me = await api('/api/auth/me');
    account = me.user;
    if (!me.user) saveSession(null); // token rejected upstream
  } catch {
    account = null;
  }
  renderAccountChip();
  return account;
}

/* ------------------------------------------------------------------ captcha */

/**
 * Asks the anonymous user the challenge the server returned.
 *
 * Anonymous publishing is capped and captcha-gated, so this is the difference
 * between "publishing still works without an account" and "publishing is
 * broken". Resolves to `{ captchaToken, captchaAnswer }` or null if cancelled.
 *
 * The answer is computed by the person reading `q`; `token` is an opaque
 * handle, so nothing here can be replayed to pre-empt it.
 */
function askCaptcha(challenge) {
  return new Promise((resolve) => {
    const answer = h('input', {
      class: 'input captcha-answer', type: 'text', inputmode: 'numeric', autocomplete: 'off',
      placeholder: 'ответ', 'aria-label': 'Ответ на вопрос',
    });
    const error = h('p', { class: 'form-error', role: 'alert' });
    const done = (value) => { backdrop.remove(); resolve(value); };
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Ответить');

    const form = h('form', {
      class: 'panel auth-card',
      onsubmit: (e) => {
        e.preventDefault();
        const value = answer.value.trim();
        if (!value) {
          error.textContent = 'Введите ответ.';
          answer.focus();
          return;
        }
        done({ captchaToken: challenge.token, captchaAnswer: value });
      },
    },
      h('h2', { text: 'Подтвердите публикацию' }),
      h('p', { class: 'page-sub', text: String(challenge.q ?? '') }),
      h('div', { class: 'field-row' }, answer, submit),
      error,
      h('button', {
        class: 'btn btn-ghost', type: 'button',
        onclick: () => { done(null); navigate('/auth?mode=register'); },
      }, 'Создать аккаунт вместо этого'),
    );

    const backdrop = h('div', {
      class: 'modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) done(null); },
    }, form);

    document.body.appendChild(backdrop);
    answer.focus();
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
  });
}

/**
 * Runs `attempt` and, if the server answers with a captcha challenge, collects
 * an answer once and retries with it.
 *
 * Only one retry: a challenge is consumed by its first correct answer, so a
 * second failure means the answer was wrong and asking again would just be a
 * way to brute-force through the UI.
 */
async function withCaptcha(attempt) {
  try {
    return await attempt(null);
  } catch (err) {
    const challenge = err?.data?.captcha;
    if (err?.status !== 403 || !challenge?.token || !challenge?.q) throw err;
    const answer = await askCaptcha(challenge);
    if (!answer) throw new Error('Публикация отменена: не решена проверка.');
    return attempt(answer);
  }
}

/* ------------------------------------------------------------- account chip */

/**
 * The sign-in / account control in the rail.
 *
 * Rendered from scratch on every auth state change rather than toggling CSS, so
 * it cannot drift out of sync with the session it is meant to reflect.
 */
function renderAccountChip() {
  const slot = document.getElementById('accountSlot');
  if (!slot) return;
  const note = document.getElementById('railNote');

  if (account) {
    slot.replaceChildren(h('a', {
      class: 'rail-stat', href: `/u/${account.id}`,
      title: `@${account.nick}`,
    },
      avatarFor(account, 24),
      h('span', { text: account.nick }),
      account.admin ? h('span', { class: 'admin-badge admin-badge-sm', title: 'Администратор' }, icon('star', 'i i-sm')) : null,
      h('span', { class: 'spacer' }),
      h('span', { text: `${account.posts ?? 0}` }),
    ));
    if (note) {
      note.textContent = 'Ключ редактирования хранится в этом браузере. Аккаунт привязан к нему: вход с другого устройства потребует пароля.';
    }
    return;
  }

  slot.replaceChildren(h('a', { class: 'rail-stat', href: '/auth' },
    icon('user', 'i i-sm'),
    h('span', { text: signedIn() ? 'Профиль' : 'Войти · Регистрация' }),
  ));
  if (note) {
    note.textContent = signedIn()
      ? 'Сессия не подтверждена сервером.'
      : 'Анонимно доступна одна публикация в сутки. С аккаунтом — четыре, без проверки.';
  }
}

/* ---------------------------------------------------------------- auth view */

/** Label + the given input, matching the shape the editor already uses. */
function field(name, input) {
  return h('label', { class: 'field' },
    h('span', { class: 'label', text: name }),
    input,
  );
}

async function viewAuth(url) {
  const mode = url.searchParams.get('mode') === 'register' ? 'register' : 'login';
  const notice = h('p', { class: 'form-error', role: 'alert' });
  const nick = h('input', {
    class: 'input', name: 'nick', autocomplete: 'username', required: true,
    minlength: 3, maxlength: 24, spellcheck: false, autocapitalize: 'off',
    placeholder: '3–24 символа, латиница и цифры',
  });
  const password = h('input', {
    class: 'input', name: 'password', type: 'password', required: true,
    minlength: 10, autocomplete: mode === 'register' ? 'new-password' : 'current-password',
    placeholder: 'минимум 10 символов',
  });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' },
    mode === 'register' ? 'Создать аккаунт' : 'Войти');
  const status = h('p', { class: 'hint' });

  const form = h('form', {
    class: 'panel auth-card',
    onsubmit: async (e) => {
      e.preventDefault();
      notice.textContent = '';
      status.textContent = '';
      const body = { nick: nick.value.trim(), password: password.value };
      if (!body.nick || !body.password) {
        notice.textContent = 'Заполните оба поля.';
        return;
      }
      submit.disabled = true;
      try {
        if (mode === 'register') {
          // Registration is the one gated action: the browser does the
          // proof-of-work first, so the user sees progress instead of a refusal.
          status.textContent = 'Проверка…';
          submit.textContent = 'Проверка…';
          const res = await registerAccount(body, (n) => { status.textContent = `Проверка… ${n.toLocaleString('ru')}`; });
          saveSession({ token: res.token });
        } else {
          const res = await loginAccount(body);
          saveSession({ token: res.token });
        }
        await refreshAccount();
        toast(mode === 'register' ? 'Аккаунт создан' : 'Вход выполнен');
        navigate(account ? `/u/${account.id}` : '/');
      } catch (err) {
        notice.textContent = err.message;
        submit.disabled = false;
        submit.textContent = mode === 'register' ? 'Создать аккаунт' : 'Войти';
        status.textContent = '';
      }
    },
  },
    h('h1', { text: mode === 'register' ? 'Регистрация' : 'Вход' }),
    h('p', { class: 'page-sub', text: mode === 'register'
      ? 'Ник, пароль, никакой почты. Восстановить пароль нельзя — запомните его.'
      : 'Войдите, чтобы публиковать без проверки и следить за своим профилем.' }),
    field('Ник', nick),
    field('Пароль', password),
    notice,
    status,
    h('div', { class: 'field-row' },
      submit,
      h('a', {
        class: 'btn btn-ghost',
        href: mode === 'register' ? '/auth' : '/auth?mode=register',
      }, mode === 'register' ? 'Уже есть аккаунт — войти' : 'Нет аккаунта — создать'),
    ),
    signedIn() ? h('button', {
      class: 'btn btn-ghost', type: 'button',
      onclick: async () => { await logoutAccount(); toast('Вышли'); navigate('/'); },
    }, 'Выйти из текущего аккаунта') : null,
  );

  $view.replaceChildren(form);
}

function uploadFile(itemId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/api/items/${itemId}/files`);
    xhr.setRequestHeader('x-cheatlab-client', CLIENT);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* keep empty */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || `HTTP ${xhr.status}`), { reasons: data.reasons }));
    });
    xhr.addEventListener('error', () => reject(new Error('сеть недоступна')));
    xhr.addEventListener('abort', () => reject(new Error('загрузка отменена')));
    xhr.send(file);
  });
}

// ---------------------------------------------------------------- base path

/**
 * On GitHub Pages the site is served from a subpath, e.g.
 * https://user.github.io/cheatlab/, so "/" is not the app root. index.html
 * carries a <base href> for that prefix, which makes every relative asset
 * resolve from the right place no matter how deep the current URL is. App
 * routes are pushed with history.pushState as absolute paths, so they need the
 * same prefix applied by hand.
 *
 * Everything below keeps treating routes as root-relative ("/scripts") and only
 * translates at the two edges: navigating in, and reading the current route.
 */
const BASE = new URL('.', document.baseURI).pathname.replace(/\/+$/, '');

/**
 * The API's own paths. They are never app routes, so they must not pick up the
 * base prefix when the API is mounted on the same origin at the domain root.
 */
const API_PREFIXES = ['/api', '/f', '/m', '/r'];

function isApiPath(pathname) {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** Root-relative route ("/scripts") -> absolute, base-prefixed path. */
function appPath(href) {
  if (!BASE || !href || !href.startsWith('/') || href.startsWith('//')) return href;
  if (isApiPath(href)) return href;
  if (href === BASE || href.startsWith(BASE + '/')) return href;
  return BASE + href;
}

/** Absolute, already-resolved pathname -> does it belong to the app? */
function isAppLink(pathname) {
  if (isApiPath(pathname)) return false;
  if (!BASE) return true;
  return pathname === BASE || pathname.startsWith(BASE + '/');
}

function stripBase(pathname) {
  if (!BASE || !pathname.startsWith(BASE)) return pathname;
  return pathname.slice(BASE.length) || '/';
}

// ---------------------------------------------------------------- chrome

function markNav() {
  const path = stripBase(location.pathname);
  for (const link of document.querySelectorAll('.nav-link')) {
    const href = stripBase(new URL(link.href).pathname);
    const on = href === '/' ? path === '/' : path.startsWith(href);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

const searchInput = document.getElementById('searchInput');
document.getElementById('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/');
});
searchInput.addEventListener('input', () => {
  if (searchInput.value === '' && stripBase(location.pathname) === '/search') navigate('/');
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  if (a.origin !== location.origin) return;
  // Route links only. API paths are left to the browser, which is what keeps
  // downloads and raw media views working on a same-origin deployment.
  if (!isAppLink(a.pathname)) return;
  e.preventDefault();
  navigate(a.pathname + a.search + a.hash);
});

function navigate(href) {
  history.pushState({}, '', appPath(href));
  route();
}

window.addEventListener('popstate', route);

async function copy(text, label = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    const ta = h('textarea', { class: 'input', style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); toast(label); } catch { toast('не удалось скопировать', true); }
    ta.remove();
  }
}

// ---------------------------------------------------------------- shared bits

/* ---------------------------------------------------------------- social bits */

/** Small "N" counter with an icon, hidden at zero to keep rows quiet. */
function counter(iconName, value, cls = '') {
  if (!value) return null;
  return h('span', { class: cls }, icon(iconName, 'i i-sm'), String(value));
}

/**
 * Profile avatar: the author's own image when they set one, otherwise their
 * first letter. `onerror` falls back to the letter because a hotlinked logo can
 * 404 or block the request at any time and an empty circle would look broken.
 */
function avatarFor(user, size) {
  const letter = h('span', { class: 'avatar-letter', text: (user.nick || '?').slice(0, 1).toUpperCase() });
  const box = h('span', {
    class: 'avatar',
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`,
  }, letter);
  if (!user.logo) return box;
  // The letter stays underneath and simply gets covered, so a failed load needs
  // no DOM change at all: a hotlinked logo can 404 or be blocked at any time.
  box.prepend(h('img', {
    class: 'avatar-img', src: user.logo, alt: '', loading: 'lazy', decoding: 'async',
  }));
  return box;
}

/**
 * Like toggle.
 *
 * Requires an account on the server, so anonymous visitors get a link to the
 * auth page instead of a button that would only 401. State is written locally
 * from the response rather than refetching the item: the server returns the
 * authoritative count, and a round trip per tap is not worth it.
 */
function likeButton(item, state) {
  let liked = Boolean(state?.liked);
  let count = Number(item.likes) || 0;

  const label = h('span', { class: 'like-count' });
  const render = () => {
    btn.classList.toggle('is-on', liked);
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    label.textContent = String(count);
  };

  const btn = h('button', {
    class: 'btn btn-sm btn-like',
    type: 'button',
    onclick: async () => {
      if (!signedIn()) { navigate('/auth'); return; }
      btn.disabled = true;
      try {
        const res = await api(`/api/items/${item.id}/like`, { method: liked ? 'DELETE' : 'POST' });
        liked = Boolean(res.liked);
        count = Number(res.likes) || 0;
        render();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    },
  }, icon('heart', 'i i-sm'), label);

  render();
  return btn;
}

/** Marks a row whose contents are behind a key. */
const lockChip = (item) => (item.locked
  ? h('span', { class: 'chip chip-lock', title: item.keyHint ? `Ключ: ${item.keyHint}` : 'Под ключом' },
      icon('lock', 'i i-sm'), item.keyHint || 'под ключом')
  : null);

function typeRow(item) {
  const meta = h('div', { class: 'row-meta' },
    h('span', {}, icon('user', 'i i-sm'), item.author),
    counter('eye', item.hits),
    counter('heart', item.likes),
    item.language !== 'text' ? h('span', { text: LANG_LABEL[item.language] || item.language }) : null,
    item.files.length
      ? h('span', {}, icon('download', 'i i-sm'), `${item.files.length} / ${bytes(item.fileSize)}`)
      : null,
    h('span', { text: ago(item.createdAt) }),
  );

  const tags = item.tags.length
    ? h('div', { class: 'tags', style: 'margin-top:8px' },
        item.tags.map((t) => h('a', { class: 'tag', href: `/search?tag=${encodeURIComponent(t)}`, text: `#${t}` })))
    : null;

  // A locked item the reader cannot open gets no thumbnail and no file line: the
  // image route answers 403 without the key, and the list itself is withheld by
  // the server, so there is nothing to point at.
  const key = item.locked ? accessFor(item.id) : null;
  const visible = !item.locked || item.unlocked !== false;
  const thumb = visible
    ? item.files.find((f) => isImageFile(f) && f.size)
    : null;

  return h('a', { class: 'row', href: `/i/${item.id}` },
    thumb
      ? h('span', { class: 'row-thumb' }, h('img', { src: mediaUrl(thumb.id, key), alt: '', loading: 'lazy', decoding: 'async' }))
      : h('span', { class: 'row-mark' }, icon(TYPE_ICON[item.type] || 'clip', 'i i-sm')),
    h('span', {},
      h('span', { class: 'row-title', text: item.title }),
      meta,
      tags,
    ),
    h('span', { class: 'row-right' },
      lockChip(item),
      item.visibility === 'unlisted' ? icon('link', 'i i-sm') : null,
      h('span', { text: when(item.createdAt) }),
    ),
  );
}

function emptyState(title, text, actionHref, actionLabel) {
  return h('div', { class: 'empty' },
    h('h2', { text: title }),
    h('p', { text }),
    actionHref ? h('a', { class: 'btn btn-primary', href: actionHref }, icon('plus'), actionLabel) : null,
  );
}

function sortTabs(current, base) {
  const sep = base.includes('?') ? '&' : '?';
  const mk = (key, label, iconName) => h('a', {
    class: 'btn btn-sm' + (current === key ? '' : ' btn-ghost'),
    href: `${base}${sep}sort=${key}`,
  }, icon(iconName, 'i i-sm'), label);
  return h('div', { class: 'actions' }, mk('new', 'Новые', 'plus'), mk('hot', 'Популярные', 'sort'));
}

// ---------------------------------------------------------------- views

const FEED_TYPE = {
  '/scripts': 'script',
  '/apps': 'app',
  '/pastes': 'paste',
  '/images': 'image',
  '/videos': 'video',
  '/files': 'file',
};

const FEED_TITLE = {
  script: 'Скрипты', app: 'Приложения', paste: 'Пасты',
  image: 'Изображения', video: 'Видео', file: 'Файлы',
};

const FEED_BLURB = {
  script: 'Luau, Lua, Python и всё, что запускают через эксплойты и локальные редакторы.',
  app: 'Файлы и сборки: apk, dll, so, архивы. Каждый файл хранится с SHA-256.',
  paste: 'Короткие тексты, конфиги, команды. Ссылка ведёт на чистый текст без интерфейса.',
  image: 'Картинки и скриншоты с превью прямо в ленте.',
  video: 'Клипы с перемоткой: видео отдаётся диапазонами, поэтому не нужно ждать загрузку целиком.',
  file: 'Любые другие файлы: архивы, документы, сборки. Скачивание идёт напрямую из хранилища.',
};

const FEED_PATH = {
  script: '/scripts',
  app: '/apps',
  paste: '/pastes',
  image: '/images',
  video: '/videos',
  file: '/files',
};

async function viewFeed(path, url) {
  const type = FEED_TYPE[path] || '';
  const q = url.searchParams.get('q') || '';
  const tag = url.searchParams.get('tag') || '';
  const sort = url.searchParams.get('sort') === 'hot' ? 'hot' : 'new';
  const title = FEED_TITLE[type] || 'Публикации';
  const blurb = FEED_BLURB[type] || 'Всё, что опубликовали пользователи.';

  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', { text: q ? `Поиск: ${q}` : tag ? `#${tag}` : title }),
        h('p', { class: 'page-sub', text: q || tag ? 'Совпадения по названию, тегу и содержимому.' : blurb }),
      ),
      h('div', { class: 'spacer' }),
      sortTabs(sort, q || tag
        ? (tag ? `/search?tag=${encodeURIComponent(tag)}` : `/search?q=${encodeURIComponent(q)}`)
        : (type ? FEED_PATH[type] : '/')),
    ),
  );

  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  params.set('sort', sort);
  params.set('limit', '40');

  const { items, total } = await api(`/api/items?${params}`);
  const list = h('div', { class: 'list' });
  if (!items.length) {
    $view.append(emptyState(
      q || tag ? 'Ничего не нашлось' : 'Пока пусто',
        q || tag ? 'Попробуй другой запрос или сними фильтр.' : 'Опубликуй первым — регистрация не обязательна.',
      '/new', 'Опубликовать',
    ));
    return;
  }
  for (const item of items) list.append(typeRow(item));
  $view.append(list, h('p', { class: 'hint', style: 'margin-top:16px', text: `${total} всего` }));
}

async function viewItem(id) {
  const stored = accessFor(id);
  const { item, liked, isFollowing } = await api(`/api/items/${id}`, { key: stored || undefined });
  const secret = keyFor(id);
  // The key travels in the header for XHR-shaped calls and in the query string
  // for <img>/<video>/"open in new tab", which cannot set headers. A wrong key
  // stored from an earlier typo must not be retried silently on every render,
  // so a 403 here drops it and the reader gets the lock screen again.
  const key = item.unlocked ? stored : null;
  // `locked` describes the publication; `unlocked` describes this particular
  // request. Only the combination means the contents are still being withheld,
  // and it is what decides between the lock screen and the real thing - testing
  // `item.locked` alone would keep showing the form to a reader who already
  // typed the right key.
  const gated = item.locked && item.unlocked === false;

  /**
   * Media previews. Rendered above the file table so an image or video post
   * reads as media at a glance instead of as a download link. Video relies on
   * the API's byte-range support, and `preload="metadata"` keeps large clips
   * from being fetched in full.
   *
   * A locked item never reaches this branch - the server sends no file list at
   * all until a key matches - so nothing here has to guess whether a media URL
   * is going to answer 403.
   */
  const mediaFiles = item.files.filter((f) => isImageFile(f) || isVideoFile(f) || isAudioFile(f));
  const media = mediaFiles.length
    ? h('div', { class: 'media' }, mediaFiles.map((f) => {
        const src = mediaUrl(f.id, key);
        const caption = h('figcaption', {},
          h('a', { href: src, target: '_blank', rel: 'noopener', text: f.name }),
          h('span', { class: 'spacer' }),
          h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.id, key) }, icon('download', 'i i-sm'), 'Скачать'),
        );
        if (isImageFile(f)) {
          return h('figure', { class: 'media-item' },
            h('img', { class: 'media-img', src, alt: f.name, loading: 'lazy', decoding: 'async' }),
            caption,
          );
        }
        if (isVideoFile(f)) {
          return h('figure', { class: 'media-item' },
            h('video', { class: 'media-video', src, controls: true, preload: 'metadata', playsinline: true }),
            caption,
          );
        }
        return h('figure', { class: 'media-item' },
          h('audio', { class: 'media-audio', src, controls: true, preload: 'metadata' }),
          caption,
        );
      }))
    : null;

  const files = item.files.length
    ? h('table', { class: 'files' },
        h('thead', {}, h('tr', {},
          h('th', { text: 'Файл' }),
          h('th', { text: 'SHA-256' }),
          h('th', { class: 'num', text: 'Размер' }),
          h('th', { class: 'act', text: '' }),
        )),
        h('tbody', {}, item.files.map((f) => h('tr', {},
          h('td', { class: 'name', text: f.name }),
          h('td', { class: 'name', style: 'color:var(--mute)', text: f.sha256 || '' }),
          h('td', { class: 'num', text: bytes(f.size) }),
          h('td', { class: 'act' },
            h('a', { class: 'btn btn-sm', href: fileUrl(f.id, key) }, icon('download', 'i i-sm'), 'Скачать'),
            ' ',
            h('a', { class: 'btn btn-sm btn-ghost', href: rawFileUrl(f.id, key), target: '_blank', rel: 'noopener' }, icon('eye', 'i i-sm'), 'Открыть'),
          ),
        ))),
      )
    : null;

  const body = item.body
    ? h('div', { style: 'margin-top:26px' },
        h('div', { class: 'code-bar' },
          h('span', {}, icon('term', 'i i-sm'), LANG_LABEL[item.language] || item.language),
          h('span', { class: 'spacer' }),
          h('span', { text: `${item.body.split('\n').length} строк` }),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => copy(item.body, 'Код скопирован') }, icon('copy', 'i i-sm'), 'Копировать'),
          h('a', { class: 'btn btn-sm btn-ghost', href: textUrl(item.id, key), target: '_blank', rel: 'noopener' }, icon('link', 'i i-sm'), 'Сырой'),
        ),
        h('pre', { class: 'code' }, h('code', { text: item.body })),
      )
    : null;

  /**
   * Lock screen.
   *
   * The title, tags and counters are already public, so the reader knows what
   * they are about to open before typing anything. The key is checked against
   * the dedicated unlock route first: a wrong guess then costs one keyed hash
   * instead of a full page load, and the stored copy is only written on a
   * confirmed match.
   */
  const lockScreen = () => {
    const input = h('input', {
      class: 'input', type: 'password', name: 'key', maxlength: config.limits?.accessKeyMax || 64,
      placeholder: 'ключ доступа', autocomplete: 'off', spellcheck: false,
    });
    const notice = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('key', 'i i-sm'), 'Открыть');

    const form = h('form', {
      class: 'panel lock-panel',
      onsubmit: async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) { notice.textContent = 'Введи ключ.'; return; }
        submit.disabled = true;
        notice.textContent = '';
        try {
          await api(`/api/items/${item.id}/unlock`, { method: 'POST', body: { key: value } });
          rememberAccess(item.id, value);
          toast('Публикация открыта');
          route();
        } catch (err) {
          notice.textContent = err.status === 429 ? err.message : 'Неверный ключ.';
          submit.disabled = false;
          input.select();
        }
      },
    },
      h('div', { class: 'lock-head' },
        icon('lock'),
        h('div', {},
          h('h2', { text: 'Публикация под ключом' }),
          h('p', { class: 'hint', text: item.keyHint
            ? `Подсказка от автора: ${item.keyHint}`
            : 'Автор не оставил подсказку. Ключ выдаётся вместе со ссылкой.' }),
        ),
      ),
      h('div', { class: 'field-row', style: 'margin-top:16px' }, input, submit),
      notice,
    );

    return h('div', { class: 'lock-screen' },
      h('div', { class: 'lock-fade', 'aria-hidden': 'true' }),
      form,
    );
  };

  const owner = item.owner;
  const mine = Boolean(account && owner && account.id === owner.id);
  const followBtn = h('button', {
    class: 'btn btn-sm', type: 'button', disabled: mine,
    onclick: async () => {
      followBtn.disabled = true;
      try {
        const res = await api(`/api/users/${owner.id}/follow`, { method: isFollowing ? 'DELETE' : 'POST' });
        followBtn.textContent = res.following ? 'Отписаться' : 'Подписаться';
        followBtn.classList.toggle('btn-primary', res.following);
      } catch (err) { toast(err.message, true); }
      finally { followBtn.disabled = mine; }
    },
  }, isFollowing ? 'Отписаться' : 'Подписаться');

  // A div, not a link: the follow button is interactive and nesting a button
  // inside an anchor is invalid HTML, so only the name and the avatar are the
  // link target.
  const author = owner
    ? h('div', { class: 'author-row' },
        h('a', { class: 'author-link', href: `/u/${owner.id}` },
          avatarFor(owner, 40),
          h('span', {},
            h('span', { class: 'author-nick', text: owner.nick }),
            h('span', { class: 'author-sub', text: 'автор публикации' }),
          ),
        ),
        h('span', { class: 'spacer' }),
        signedIn() && !mine ? followBtn : null,
      )
    : h('span', { text: item.authorLabel || item.author });

  const sidebar = h('div', {},
    h('div', { class: 'panel' },
      h('div', { class: 'panel-title', text: 'Сведения' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Тип' }), h('dd', { text: TYPE_LABEL[item.type] }),
        h('dt', { text: 'Автор' }), h('dd', { text: item.authorLabel || item.author }),
        h('dt', { text: 'Создано' }), h('dd', { text: when(item.createdAt) }),
        h('dt', { text: 'Просмотры' }), h('dd', { text: String(item.hits) }),
        h('dt', { text: 'Лайки' }), h('dd', { text: String(item.likes ?? 0) }),
        h('dt', { text: 'Видимость' }), h('dd', { text: item.visibility === 'unlisted' ? 'по ссылке' : 'в ленте' }),
        item.locked ? h('dt', { text: 'Доступ' }) : null,
        item.locked ? h('dd', {}, lockChip(item)) : null,
        h('dt', { text: 'ID' }), h('dd', { text: item.id }),
      ),
    ),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-title', text: 'Действия' }),
      h('div', { class: 'actions' },
        likeButton(item, { liked }),
        h('button', { class: 'btn btn-sm', onclick: () => copy(location.href, 'Ссылка скопирована') }, icon('link', 'i i-sm'), 'Ссылка'),
        item.body ? h('button', { class: 'btn btn-sm', onclick: () => copy(item.body, 'Код скопирован') }, icon('copy', 'i i-sm'), 'Код') : null,
        // Only the author can rotate a key, and only the author can drop one, so
        // this button is behind the same edit secret as "Изменить" and "Удалить".
        secret ? h('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            // The plaintext was only ever shown once, at publish time, so the
            // only options left are replacing it or dropping the lock.
            const answer = prompt('Новый ключ доступа (пусто — снять защиту):');
            if (answer === null) return;
            try {
              await api(`/api/items/${item.id}`, { method: 'PATCH', secret, body: { accessKey: answer } });
              // Store the new key rather than dropping the old one, or the author
              // would lock themselves out of a post they just published. An empty
              // answer removes the lock, so there is nothing left to remember.
              if (answer) rememberAccess(item.id, answer);
              else forgetAccess(item.id);
              toast(answer ? 'Ключ обновлён' : 'Защита снята');
              route();
            } catch (err) { toast(err.message, true); }
          },
        }, icon('key', 'i i-sm'), secret && item.locked ? 'Сменить ключ' : 'Защитить ключом') : null,
        secret ? h('a', { class: 'btn btn-sm', href: `/edit/${item.id}` }, icon('edit', 'i i-sm'), 'Изменить') : null,
        secret ? h('button', {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!confirm(`Удалить «${item.title}» и её файлы? Действие необратимо.`)) return;
            try {
              await api(`/api/items/${item.id}`, { method: 'DELETE', secret });
              const keys = loadKeys();
              delete keys[item.id];
              saveKeys(keys);
              forgetAccess(item.id);
              toast('Удалено');
              navigate('/me');
            } catch (err) { toast(err.message, true); }
          },
        }, icon('trash', 'i i-sm'), 'Удалить') : null,
      ),
      secret ? null : h('p', { class: 'hint', style: 'margin-top:12px', text: 'Публикация создана в другом браузере — ключ редактирования здесь недоступен.' }),
    ),
    item.tags.length ? h('div', { class: 'panel' },
      h('div', { class: 'panel-title', text: 'Теги' }),
      h('div', { class: 'tags' }, item.tags.map((t) => h('a', { class: 'tag', href: `/search?tag=${encodeURIComponent(t)}`, text: `#${t}` }))),
    ) : null,
  );

  $view.replaceChildren(
    h('div', { style: 'margin-bottom:18px' },
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => history.length > 1 ? history.back() : navigate('/') }, icon('back', 'i i-sm'), 'Назад'),
    ),
    h('div', { class: 'split' },
      h('div', {},
        h('div', { class: 'pill pill-mute' }, icon(TYPE_ICON[item.type], 'i i-sm'), TYPE_LABEL[item.type]),
        item.locked ? lockChip(item) : null,
        h('h1', { style: 'margin:8px 0 0', text: item.title }),
        author,
        gated ? lockScreen() : media,
        gated ? null : files,
        gated ? null : body,
      ),
      sidebar,
    ),
  );
}

function editorForm(initial) {
  // Editing passes the full item, so `initial.files` exists there; a new
  // publication passes just `{ type }` and has no files yet. Normalise once so
  // neither the existing-file list nor the upload cap can hit `.length` on an
  // undefined array.
  const existing = initial.files || [];
  const state = {
    type: initial.type || 'script',
    language: initial.language || (initial.type === 'script' ? 'luau' : 'text'),
    title: initial.title || '',
    tags: (initial.tags || []).join(', '),
    body: initial.body || '',
    visibility: initial.visibility || 'public',
    // Editing an already-locked item: the existing key is a hash on the server
    // and cannot be read back, so the field starts empty and only what the
    // author types here is sent. An empty box leaves the current key alone
    // unless the "remove lock" checkbox is ticked.
    wasLocked: Boolean(initial.locked),
    removeLock: false,
  };

  const bodyInput = h('textarea', {
    class: 'textarea', id: 'f-body', spellcheck: 'false', autocomplete: 'off',
    placeholder: state.type === 'app' ? 'Описание, инструкция, список функций' : 'Вставь код или текст',
    oninput: (e) => { state.body = e.target.value; },
  });
  bodyInput.value = state.body;

  const titleInput = h('input', { class: 'input', id: 'f-title', maxlength: config.limits.titleMax || 120, value: state.title, oninput: (e) => { state.title = e.target.value; } });
  const tagsInput = h('input', { class: 'input', id: 'f-tags', value: state.tags, placeholder: 'aimbot, executor, roblox', oninput: (e) => { state.tags = e.target.value; } });
  const langSel = h('select', { class: 'select', id: 'f-lang', onchange: (e) => { state.language = e.target.value; } },
    config.languages.map((l) => h('option', { value: l, selected: l === state.language, text: LANG_LABEL[l] || l })));
  const langField = h('label', { class: 'field' }, h('span', { class: 'label', text: 'Язык' }), langSel);
  const unlisted = h('input', { type: 'checkbox', onchange: (e) => { state.visibility = e.target.checked ? 'unlisted' : 'public'; } });
  if (state.visibility === 'unlisted') unlisted.checked = true;

  /**
   * Access-key fields.
   *
   * The key box is blank by design even when the item is already locked: the
   * server only ever stores a hash, so there is nothing to prefill and
   * pretending otherwise would be a lie. Typing a key replaces the current one,
   * and the checkbox is the only way to remove a lock that the author no longer
   * has the key to.
   */
  const keyMax = config.limits?.accessKeyMax || 64;
  const hintMax = config.limits?.keyHintMax || 80;
  const accessKeyInput = h('input', {
    class: 'input', id: 'f-key', type: 'text', maxlength: keyMax, autocomplete: 'off', spellcheck: false,
    placeholder: state.wasLocked ? 'оставь пустым, чтобы не менять' : 'необязательно',
  });
  const keyHintInput = h('input', {
    class: 'input', id: 'f-key-hint', maxlength: hintMax, value: initial.keyHint || '',
    placeholder: 'например: для своих',
  });
  const removeLock = h('input', {
    type: 'checkbox', disabled: !state.wasLocked,
    onchange: (e) => {
      state.removeLock = e.target.checked;
      accessKeyInput.disabled = e.target.checked;
      if (e.target.checked) accessKeyInput.value = '';
    },
  });
  if (state.wasLocked) {
    keyHintInput.disabled = false;
  }
  const keyRow = h('label', { class: 'toggle' }, removeLock, h('span', { text: 'Снять защиту ключом' }));
  const keyHintField = h('label', { class: 'field' },
    h('span', { class: 'label', text: 'Подсказка к ключу' }), keyHintInput,
    h('span', { class: 'hint', text: 'видна всем, кто откроет публикацию, сама публикация — нет' }),
  );

  const keyPanel = h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('key', 'i i-sm'), 'Доступ по ключу'),
    h('div', { style: 'display:flex; flex-direction:column; gap:14px' },
      h('label', { class: 'field' },
        h('span', { class: 'label', text: 'Ключ' }),
        accessKeyInput,
        h('span', { class: 'hint', text: state.wasLocked
          ? 'текущий ключ сохранить нельзя — сервер хранит только хеш. Введи новый, чтобы заменить.'
          : 'показывается один раз при публикации и больше не восстанавливается' }),
      ),
      keyHintField,
      state.wasLocked ? keyRow : null,
    ),
  );

  /**
   * Keeps the type tab, the body placeholder and the language hint in step.
   * Media types carry no code, so the language selector becomes meaningless.
   */
  const MEDIA_TYPES = new Set(['image', 'video', 'file']);
  function setType(next) {
    state.type = next;
    for (const b of typeBar.children) {
      b.setAttribute('aria-selected', b.dataset.type === next);
    }
    const media = MEDIA_TYPES.has(next);
    if (langField) langField.hidden = media;
    bodyInput.placeholder = next === 'app'
      ? 'Описание, инструкция, список функций'
      : media
        ? 'Подпись к публикации (необязательно)'
        : 'Вставь код или текст';
  }

  const typeBar = h('div', { class: 'tabs' }, config.types.map((t) => h('button', {
    class: 'tab', type: 'button', role: 'tab', dataset: { type: t }, 'aria-selected': t === state.type,
    onclick: () => {
      if (t === 'paste' && state.language !== 'text') { state.language = 'text'; langSel.value = 'text'; }
      if (t === 'script' && state.language === 'text') { state.language = 'luau'; langSel.value = 'luau'; }
      setType(t);
    },
  }, icon(TYPE_ICON[t], 'i i-sm'), TYPE_LABEL[t])));

  const queue = h('div', { class: 'queue' });
  const pending = [];
  const fileInput = h('input', { type: 'file', multiple: true, onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; } });
  const drop = h('label', { class: 'drop' }, icon('upload'), h('span', { text: 'Перетащи файлы сюда или нажми, чтобы выбрать' }), fileInput);

  function addFiles(list) {
    for (const f of list) {
      if (pending.length + existing.length >= (config.limits.maxFilesPerItem || 20)) {
        toast('Лимит файлов на публикацию исчерпан', true);
        break;
      }
      if (f.size > config.limits.maxFileBytes) { toast(`${f.name}: больше лимита ${bytes(config.limits.maxFileBytes)}`, true); continue; }
      pending.push(f);
      const bar = h('span', { class: 'bar' }, h('span', { style: 'width:0%' }));
      const row = h('div', { class: 'queue-row' },
        h('span', { text: f.name }),
        h('span', { class: 'spacer' }),
        h('span', { text: bytes(f.size) }),
        bar,
      );
      queue.append(row);
      f._ui = { bar: bar.firstChild, row };
    }
    // dropping a picture or a clip should not also require picking the right tab
    if (!MEDIA_TYPES.has(state.type)) {
      const first = list.find((f) => /^image\//.test(f.type) || /^video\//.test(f.type));
      if (first) setType(/^image\//.test(first.type) ? 'image' : 'video');
    }
  }

  for (const drag of ['dragenter', 'dragover']) {
    document.addEventListener(drag, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  }
  for (const drag of ['dragleave', 'drop']) {
    document.addEventListener(drag, (e) => { e.preventDefault(); if (e.type === 'drop' || e.target === drop) drop.classList.remove('is-over'); });
  }
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length && document.body.contains(drop)) { e.preventDefault(); addFiles([...e.dataTransfer.files]); }
  });

  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, icon('check', 'i i-sm'), initial.id ? 'Сохранить' : 'Опубликовать');
  const form = h('form', { class: 'split', onsubmit: onSubmit },
    h('div', { style: 'display:flex; flex-direction:column; gap:20px' },
      typeBar,
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Название' }), titleInput),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'Теги' }), tagsInput, h('span', { class: 'hint', text: 'до 8 штук, через запятую' })),
      h('div', { class: 'field' },
        h('span', { class: 'label', text: 'Содержимое' }),
        h('div', { style: 'display:flex; gap:8px' },
          h('button', {
            class: 'btn btn-sm btn-ghost', type: 'button',
            onclick: async () => {
              try {
                const text = await navigator.clipboard.readText();
                bodyInput.value = `${bodyInput.value}${bodyInput.value ? '\n' : ''}${text}`;
                state.body = bodyInput.value;
              } catch { toast('буфер обмена недоступен', true); }
            },
          }, icon('copy', 'i i-sm'), 'Вставить'),
        ),
        bodyInput,
      ),
      h('div', { class: 'field' },
        h('span', { class: 'label', text: 'Файлы' }),
        drop,
        queue,
        existing.length
          ? h('div', { class: 'panel' },
              h('div', { class: 'panel-title', text: 'Уже загружено' }),
              existing.map((f) => h('div', { class: 'queue-row' },
                h('a', { href: fileUrl(f.id, initial.id ? accessFor(initial.id) : null), text: f.name }),
                h('span', { class: 'spacer' }),
                h('span', { text: bytes(f.size) }),
              )),
            )
          : null,
      ),
    ),
    h('div', {},
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title', text: 'Публикация' }),
        h('div', { style: 'display:flex; flex-direction:column; gap:14px' },
          langField,
          h('label', { class: 'toggle' }, unlisted, h('span', { text: 'Не показывать в ленте' })),
          h('div', { class: 'actions' }, submit),
          initial.id ? h('a', { class: 'btn btn-sm btn-ghost', href: `/i/${initial.id}` }, 'Отмена') : null,
        ),
      ),
      keyPanel,
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title', text: 'Как это работает' }),
        h('p', { class: 'hint', text: 'При публикации сервер выдаёт ключ редактирования — он остаётся в этом браузере. Секрет нужен, чтобы изменить или удалить запись. Анонимно — одна публикация в сутки с проверкой, с аккаунтом — четыре и без проверки.' }),
      ),
    ),
  );

  async function onSubmit(e) {
    e.preventDefault();
    if (!state.title.trim()) { toast('Нужно название', true); titleInput.focus(); return; }
    submit.disabled = true;
    submit.replaceChildren(icon('upload', 'i i-sm spin'), 'Публикация');

    const accessKey = accessKeyInput.value.trim();
    const payload = {
      type: state.type,
      title: state.title.trim(),
      language: state.language,
      tags: state.tags.split(/[,\s]+/).filter(Boolean),
      body: state.body,
      visibility: state.visibility,
    };
    // On create, an empty string is the same as no key. On edit it means "keep
    // the current one", so the field is only sent when the author actually
    // typed something or ticked "remove the lock".
    if (accessKey || state.removeLock) {
      payload.accessKey = state.removeLock ? '' : accessKey;
      payload.keyHint = keyHintInput.value.trim();
    } else if (keyHintInput.value.trim() && !initial.id) {
      payload.keyHint = keyHintInput.value.trim();
    }

    try {
      let id = initial.id;
      if (id) {
        await api(`/api/items/${id}`, { method: 'PATCH', body: payload, secret: keyFor(id) });
        if (state.removeLock) forgetAccess(id);
        else if (accessKey) rememberAccess(id, accessKey);
        toast(state.removeLock ? 'Сохранено, защита снята' : 'Сохранено');
      } else {
        // Anonymous publishing is captcha-gated, so a 403 here is expected for
        // signed-out users rather than a failure: ask the question and retry.
        // Signed-in users are exempt and never see the dialog.
        const res = await withCaptcha((answer) => api('/api/items', {
          method: 'POST', body: answer ? { ...payload, ...answer } : payload,
        }));
        id = res.item.id;
        rememberKey(id, res.secret);
        toast(res.registered
          ? `Опубликовано от имени ${account ? account.nick : 'аккаунта'}. Ключ: ${res.secret}`
          : `Опубликовано. Ключ: ${res.secret}`);
        // The access key comes back exactly once, from the create response, and
        // never again - so this is the last chance to keep a working local copy
        // for the author's own browser.
        if (res.accessKey) rememberAccess(id, res.accessKey);
      }

      let failed = 0;
      for (const f of pending) {
        try {
          f._ui.bar.style.width = '100%';
          await uploadFile(id, f, (p) => { f._ui.bar.style.width = `${Math.round(p * 100)}%`; });
          f._ui.row.replaceChildren(h('span', { text: f.name }), h('span', { class: 'spacer' }), h('span', { text: 'загружен' }));
        } catch (err) {
          failed++;
          f._ui.row.replaceChildren(h('span', { text: f.name }), h('span', { class: 'spacer' }), h('span', { text: err.message }));
        }
      }
      if (failed) toast(`${failed} файл(ов) не загрузились`, true);
      if (pending.length) toast(`Файлов загружено: ${pending.length - failed}`);
      navigate(`/i/${id}`);
    } catch (err) {
      const why = err.reasons ? `${err.message} (${err.reasons.map((r) => r.reason).join('; ')})` : err.message;
      toast(why, true);
      submit.disabled = false;
      submit.replaceChildren(icon('check', 'i i-sm'), initial.id ? 'Сохранить' : 'Опубликовать');
    }
  }

  return form;
}

async function viewNew(url) {
  const type = url.searchParams.get('type') || 'script';
  $view.replaceChildren(
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Новая публикация' }), h('p', {
        class: 'page-sub',
        text: signedIn()
          ? 'Публикуете от имени аккаунта. Ключ редактирования выдаст сервер.'
          : 'Анонимно доступна одна публикация в сутки и потребуется проверка. Ключ выдаст сервер.',
      }))),
    editorForm({ type }),
  );
}

async function viewEdit(id) {
  if (!keyFor(id)) {
    $view.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', { text: 'Нужен ключ' })),
      h('div', { class: 'notice' }, icon('lock'), h('span', { text: 'Эта публикация создана в другом браузере. Импортируй ключи на странице «Мои загрузки», чтобы вернуть доступ.' })),
      h('p', { style: 'margin-top:20px' }, h('a', { class: 'btn', href: `/i/${id}` }, icon('back', 'i i-sm'), 'К публикации'), ' ', h('a', { class: 'btn btn-ghost', href: '/me' }, 'Мои загрузки')),
    );
    return;
  }
  // The stored access key is sent along, otherwise the editor would load a bare
  // shell for a locked publication and show every field empty.
  const res = await api(`/api/items/${id}`, { key: accessFor(id) || undefined });
  const item = res.item;
  if (item.locked && !item.unlocked) {
    $view.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', { text: 'Публикация под ключом' })),
      h('div', { class: 'notice' }, icon('lock'), h('span', { text: 'Сначала открой публикацию ключом, потом возвращайся к редактированию.' })),
      h('p', { style: 'margin-top:20px' }, h('a', { class: 'btn', href: `/i/${id}` }, icon('key', 'i i-sm'), 'Ввести ключ')),
    );
    return;
  }
  $view.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Редактирование' }), h('p', { class: 'page-sub', text: item.title }))),
    editorForm(item),
  );
}

async function viewMe() {
  const { author, items, files } = await api('/api/me');
  const keys = loadKeys();
  const access = loadAccess();
  const itemById = new Map(items.map((it) => [it.id, it]));
  const mine = items.map((item) => {
    const owned = Boolean(keys[item.id]);
    return h('div', { class: 'row' },
      h('span', { class: 'row-mark' }, icon(item.locked ? 'lock' : TYPE_ICON[item.type] || 'clip', 'i i-sm')),
      h('span', {},
        h('a', { class: 'row-title', href: `/i/${item.id}`, text: item.title }),
        h('div', { class: 'row-meta' },
          h('span', {}, icon('hash', 'i i-sm'), item.id),
          h('span', { text: when(item.createdAt) }),
          h('span', {}, icon('eye', 'i i-sm'), String(item.hits)),
          counter('heart', item.likes),
          item.files.length ? h('span', {}, icon('download', 'i i-sm'), String(item.files.length)) : null,
          item.locked ? h('span', { text: access[item.id] ? 'ключ есть' : 'ключ утерян' }) : null,
          owned ? null : h('span', { text: 'только чтение' }),
        ),
      ),
      h('span', { class: 'row-right' },
        owned ? h('a', { class: 'btn btn-sm btn-ghost', href: `/edit/${item.id}` }, icon('edit', 'i i-sm')) : null,
      ),
    );
  });

  const exportBox = h('textarea', { class: 'textarea', style: 'min-height:120px', placeholder: JSON.stringify({ 'abc12345': 'ключ' }, null, 2), spellcheck: 'false' });
  // Access keys are exportable too, and as a separate blob: handing a reader an
  // edit key would hand them write access to the publication.
  const accessBox = h('textarea', { class: 'textarea', style: 'min-height:120px', placeholder: JSON.stringify({ 'abc12345': 'ключ доступа' }, null, 2), spellcheck: 'false' });
  /**
   * Validates a pasted blob before it is merged into a store.
   *
   * Every entry is checked here rather than trusted, because a bad paste would
   * otherwise sit in localStorage forever as a value no view can use, and the
   * import is the one path where data arrives from outside the app.
   */
  const parseKeys = (box) => {
    const incoming = JSON.parse(box.value || '{}');
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      throw new Error('ожидался объект { id: ключ }');
    }
    const entries = Object.entries(incoming);
    for (const [k, v] of entries) {
      if (!/^[A-Za-z0-9]{4,16}$/.test(k) || typeof v !== 'string' || !v) {
        throw new Error(`плохая запись: ${k}`);
      }
    }
    return incoming;
  };
  const lockedCount = items.filter((it) => it.locked).length;
  const lostKeys = items.filter((it) => it.locked && !access[it.id]).length;

  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', { text: 'Мои загрузки' }),
        h('p', { class: 'page-sub', text: `Устройство ${author} · ${items.length} публикаций · ${files.length} файлов` }),
      ),
      h('div', { class: 'spacer' }),
      h('a', { class: 'btn', href: '/new' }, icon('plus', 'i i-sm'), 'Опубликовать'),
    ),
    h('div', { class: 'split' },
      h('div', {}, mine.length ? h('div', { class: 'list' }, mine) : emptyState('Публикаций нет', 'Всё, что ты опубликуешь с этого устройства, появится здесь.', '/new', 'Опубликовать')),
      h('div', {},
        h('div', { class: 'panel' },
          h('div', { class: 'panel-title', text: 'Ключи редактирования' }),
          h('p', { class: 'hint', text: `Хранятся в localStorage этого браузера: ${Object.keys(keys).length} шт. При очистке данных сайта доступ к правке теряется, поэтому сохрани копию.` }),
          h('div', { class: 'actions', style: 'margin-top:12px' },
            h('button', { class: 'btn btn-sm', onclick: () => copy(JSON.stringify(keys, null, 2), 'Ключи скопированы') }, icon('download', 'i i-sm'), 'Экспорт'),
            h('button', {
              class: 'btn btn-sm',
              onclick: () => {
                try {
                  saveKeys({ ...loadKeys(), ...parseKeys(exportBox) });
                  toast('Ключи импортированы');
                  route();
                } catch (err) {
                  toast(err instanceof SyntaxError ? 'Это не JSON' : err.message, true);
                }
              },
            }, icon('upload', 'i i-sm'), 'Импорт'),
          ),
          exportBox,
        ),
        lockedCount
          ? h('div', { class: 'panel' },
              h('div', { class: 'panel-title' }, icon('key', 'i i-sm'), 'Ключи доступа'),
              h('p', { class: 'hint', text: `Под ключом ${lockedCount} публикаций, в браузере ${Object.keys(access).length} ключей.${lostKeys ? ` Потеряно: ${lostKeys} — их нельзя восстановить, только задать новые при редактировании.` : ''}` }),
              h('div', { class: 'actions', style: 'margin-top:12px' },
                h('button', { class: 'btn btn-sm', onclick: () => copy(JSON.stringify(access, null, 2), 'Ключи доступа скопированы') }, icon('download', 'i i-sm'), 'Экспорт'),
                h('button', {
                  class: 'btn btn-sm',
                  onclick: () => {
                    try {
                      const incoming = parseKeys(accessBox);
                      // Only accept keys for items this browser actually owns:
                      // a paste of someone else's dump should not quietly
                      // unlock a stranger's publication on this device. For a
                      // publication that isn't yours there is the unlock form
                      // on its own page.
                      const mine2 = {};
                      for (const [k, v] of Object.entries(incoming)) {
                        const it = itemById.get(k);
                        if (it && keys[k]) mine2[k] = v;
                      }
                      if (!Object.keys(mine2).length) { toast('Нет своих публикаций среди этих id', true); return; }
                      saveAccess({ ...loadAccess(), ...mine2 });
                      toast(`Импортировано ключей: ${Object.keys(mine2).length}`);
                      route();
                    } catch (err) {
                      toast(err instanceof SyntaxError ? 'Это не JSON' : err.message, true);
                    }
                  },
                }, icon('upload', 'i i-sm'), 'Импорт'),
              ),
              accessBox,
            )
          : null,
        h('div', { class: 'panel' },
          h('div', { class: 'panel-title', text: 'Мои файлы' }),
          files.length
            ? h('div', {}, files.map((f) => {
                const it = items.find((x) => x.files.some((y) => y.id === f.id));
                return h('div', { class: 'queue-row' },
                  h('a', { href: fileUrl(f.id, it ? access[it.id] : null), text: f.name, style: 'overflow:hidden;text-overflow:ellipsis' }),
                  h('span', { class: 'spacer' }),
                  h('span', { text: bytes(f.size) }),
                );
              }))
            : h('p', { class: 'hint', text: 'Файлов пока нет.' }),
        ),
      ),
    ),
  );
}

async function viewProfile(id) {
  const data = await api(`/api/users/${encodeURIComponent(id)}`);
  const u = data.user;
  const isMe = Boolean(account && account.id === u.id);
  const notice = h('p', { class: 'form-error', role: 'alert' });

  const bio = h('input', {
    class: 'input', name: 'bio', maxlength: 280,
    value: u.bio || '', placeholder: 'Пара слов о себе',
  });
  const logo = h('input', {
    class: 'input', name: 'logo', maxlength: 280, spellcheck: false, autocapitalize: 'off',
    value: u.logo || '', placeholder: 'https://.../avatar.png',
  });
  const accent = h('input', {
    class: 'input', name: 'accent', maxlength: 7, spellcheck: false,
    value: u.accent || '', placeholder: '#7c5cff',
    oninput: (e) => { e.target.style.borderColor = /^#[0-9a-f]{6}$/i.test(e.target.value) ? e.target.value : ''; },
  });
  const bg = h('input', {
    class: 'input', name: 'bg', maxlength: 120, spellcheck: false,
    value: u.bg || '', placeholder: 'linear-gradient(120deg, #17141f, #0b0b0b)',
  });
  const followBtn = h('button', {
    class: 'btn', type: 'button', disabled: isMe,
    onclick: async () => {
      followBtn.disabled = true;
      try {
        const res = await api(`/api/users/${u.id}/follow`, { method: data.isFollowing ? 'DELETE' : 'POST' });
        data.isFollowing = res.following;
        followBtn.textContent = res.following ? 'Отписаться' : 'Подписаться';
        followBtn.classList.toggle('btn-primary', res.following);
        const n = document.getElementById('followCount');
        if (n) n.textContent = String(u.followers + (res.following ? 1 : -1));
      } catch (err) {
        notice.textContent = err.message;
        followBtn.disabled = false;
      }
    },
  }, data.isFollowing ? 'Отписаться' : 'Подписаться');
  if (data.isFollowing) followBtn.classList.add('btn-primary');

  const stat = (label, value) => h('div', { class: 'stat-box' },
    h('span', { class: 'stat-value', text: String(value) }),
    h('span', { class: 'stat-label', text: label }),
  );

  const followersLink = h('a', {
    class: 'stat-box', href: `/u/${u.id}/followers`,
  },
    h('span', { class: 'stat-value', id: 'followCount', text: String(u.followers) }),
    h('span', { class: 'stat-label', text: 'подписчиков' }),
  );

  // A profile's own accent and background, applied to the card wrapper only -
  // never to <html>, where it would repaint the whole site for one user. The
  // values were already sanitised server-side (https URL, #hex, plain CSS), so
  // the strings are safe to hand to the style attribute as-is.
  let themeStyle = null;
  if (u.accent) themeStyle = `border-color:${u.accent}`;
  if (u.bg) themeStyle = themeStyle ? `${themeStyle};background:${u.bg}` : `background:${u.bg}`;

  const nickLine = h('h1', {},
    u.nick,
    u.admin ? h('span', { class: 'admin-badge', title: 'Администратор' }, icon('star', 'i i-sm'), 'админ') : null,
  );

  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        nickLine,
        h('p', { class: 'page-sub', text: `@${u.nick} · с ${new Date(u.createdAt).toLocaleDateString('ru')}` }),
      ),
      h('div', { class: 'field-row' },
        signedIn() && !isMe ? followBtn : null,
        isMe ? h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: async () => { await logoutAccount(); toast('Вышли'); navigate('/'); },
        }, 'Выйти') : null,
        signedIn() && !isMe ? h('a', { class: 'btn btn-ghost', href: '/auth' }, 'Сменить аккаунт') : null,
      ),
    ),
      h('div', { class: 'panel profile-card', style: themeStyle },
        h('div', { class: 'profile-head' },
          avatarFor(u, 64),
          h('div', { class: 'stats-row' },
            stat('публикаций', u.posts),
            followersLink,
            stat('подписок', u.following),
          ),
        ),
      ),
    u.bio && !isMe ? h('p', { class: 'page-sub', text: u.bio }) : null,
    isMe ? h('form', {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const res = await api('/api/auth/me', {
            method: 'PATCH',
            body: {
              bio: bio.value.trim(),
              logo: logo.value.trim(),
              accent: accent.value.trim(),
              bg: bg.value.trim(),
            },
          });
          account = res.user;
          toast('Профиль обновлён');
          navigate(`/u/${u.id}`);
        } catch (err) { notice.textContent = err.message; }
      },
    },
      h('h2', { text: 'О себе' }),
      bio,
      h('div', { class: 'design-row' },
        h('label', { class: 'field' },
          h('span', { class: 'label' }, icon('image', 'i i-sm'), 'Логотип'),
          logo,
          h('span', { class: 'hint', text: 'ссылка на https-картинку' }),
        ),
        h('label', { class: 'field' },
          h('span', { class: 'label' }, icon('palette', 'i i-sm'), 'Акцент'),
          accent,
          h('span', { class: 'hint', text: 'цвет вида #7c5cff' }),
        ),
        h('label', { class: 'field' },
          h('span', { class: 'label' }, icon('palette', 'i i-sm'), 'Фон'),
          bg,
          h('span', { class: 'hint', text: 'цвет или градиент CSS' }),
        ),
      ),
      h('p', { class: 'hint', text: 'Логотип, акцент и фон показываются в твоём профиле. Неверное значение молча игнорируется сервером.' }),
      notice,
      h('div', { class: 'field-row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Сохранить')),
    ) : null,
    notice,
    h('div', { class: 'panel' },
      h('div', { class: 'panel-title', text: 'Публикации' }),
      data.items.length
        ? h('div', { class: 'rows' }, data.items.map((it) => typeRow(it)))
        : h('p', { class: 'hint', text: 'Пока ничего не опубликовано.' }),
    ),
  );
}

async function viewFollowers(id) {
  const data = await api(`/api/users/${encodeURIComponent(id)}/followers`);
  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('h1', { text: 'Подписчики' }),
      h('a', { class: 'btn btn-ghost', href: `/u/${id}` }, 'К профилю'),
    ),
    data.users.length
      ? h('div', { class: 'panel' }, h('div', { class: 'rows' },
        data.users.map((u) => h('a', { class: 'row', href: `/u/${u.id}` },
          icon('user', 'i i-sm'),
          h('span', { text: u.nick }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'hint', text: `${u.posts ?? 0} публикаций` }),
        ))))
      : h('p', { class: 'hint', text: 'Пока никто не подписан.' }),
  );
}

async function viewStats() {
  const s = await api('/api/stats');
  const p = await api('/api/plugins');
  const line = (label, value) => [h('dt', { text: label }), h('dd', { text: String(value) })];
  $view.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Состояние' }), h('p', { class: 'page-sub', text: 'Счётчики хранилища и загруженные серверные плагины.' }))),
    h('div', { class: 'split' },
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title', text: 'Хранилище' }),
        h('dl', { class: 'kv' },
          ...line('Публикаций', s.items),
          ...line('Скриптов', s.scripts),
          ...line('Паст', s.pastes),
          ...line('Приложений', s.apps),
          ...line('Файлов', s.files),
          ...line('Объём', bytes(s.bytes)),
          ...line('Устройств', s.clients),
        ),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title', text: 'Серверные плагины' }),
        p.loaded.length
          ? h('div', {}, p.loaded.map((pl) => h('div', { class: 'queue-row' },
              h('span', {}, icon('box', 'i i-sm'), pl.name),
              h('span', { class: 'spacer' }),
              h('span', { text: pl.hooks.join(', ') }),
            )))
          : h('p', { class: 'hint', text: 'Плагины не загружены.' }),
        p.failed.length
          ? h('div', { class: 'notice', style: 'margin-top:12px' }, icon('alert'), h('span', { text: p.failed.map((f) => `${f.file}: ${f.error}`).join('; ') }))
          : null,
      ),
    ),
  );
}

function notFound() {
  $view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', { text: 'Страница не найдена' })),
    h('p', {}, h('a', { class: 'btn', href: '/' }, icon('back', 'i i-sm'), 'На главную')),
  );
}

// ---------------------------------------------------------------- router

let renderToken = 0;
async function route() {
  const token = ++renderToken;
  const path = stripBase(location.pathname);
  const url = new URL(location.href);
  markNav();
  if (path === '/search') searchInput.value = url.searchParams.get('q') || '';
  else if (path !== '/search') searchInput.value = '';
  $view.replaceChildren(h('p', { class: 'hint', text: 'Загрузка...' }));

  try {
    if (path === '/' || path === '/search' || FEED_TYPE[path]) {
      await viewFeed(path, url);
    } else if (path === '/new') {
      await viewNew(url);
    } else if (path === '/me') {
      await viewMe();
    } else if (path === '/stats') {
      await viewStats();
    } else if (path === '/auth') {
      await viewAuth(url);
    } else if (/^\/u\/[A-Za-z0-9_-]{3,32}$/.test(path)) {
      await viewProfile(path.slice(3));
    } else if (/^\/u\/[A-Za-z0-9_-]{3,32}\/followers$/.test(path)) {
      await viewFollowers(path.slice(3, -'/followers'.length));
    } else if (/^\/i\/[A-Za-z0-9]{4,16}$/.test(path)) {
      await viewItem(path.slice(3));
    } else if (/^\/edit\/[A-Za-z0-9]{4,16}$/.test(path)) {
      await viewEdit(path.slice(6));
    } else {
      notFound();
    }
  } catch (err) {
    if (token !== renderToken) return;
    $view.replaceChildren(
      h('div', { class: 'notice' }, icon('alert'), h('span', { text: err.message || 'ошибка загрузки' })),
      h('p', { style: 'margin-top:20px' }, h('a', { class: 'btn', href: '/' }, 'На главную')),
    );
  }
  window.scrollTo(0, 0);
}

const THEME_KEY = 'cheatlab.theme';

/** Dark is the default; the choice is remembered per browser. */
function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  const icon = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (icon) icon.setAttribute('href', next === 'dark' ? '#i-moon' : '#i-sun');
  if (label) label.textContent = next === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#0b0b0b' : '#ffffff');
}

function initTheme() {
  const btn = document.getElementById('themeToggle');
  applyTheme(currentTheme());
  if (!btn) return;
  btn.addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
}

async function boot() {
  initTheme();
  // the footer link must point at the API origin, not at the static site
  const apiLink = document.getElementById('apiLink');
  if (apiLink) apiLink.href = `${API}/api/stats`;

  if (API_UNSET) {
    $view.replaceChildren(h('div', { class: 'notice' },
      icon('alert'),
      h('div', {},
        h('strong', { text: 'API не задан' }),
        h('p', { style: 'margin:8px 0 12px' },
          'Сайт открыт, но адрес бэкенда не прописан, поэтому публикации недоступны. '
          + 'Проверка идёт по адресу ' + location.origin + '/api/config — это статический хостинг, он отвечает HTML-страницей ошибки, а не API.'),
        h('p', { style: 'margin:0 0 6px' }, 'Впишите адрес Worker и задеплойте сайт:'),
        h('pre', { style: 'margin:0;white-space:pre-wrap' },
          'node scripts/set-api-url.mjs https://<ваш-worker>.workers.dev'),
      ),
    ));
    return;
  }

  try {
    config = await api('/api/config');
  } catch (err) {
    // A misconfigured API origin makes every view fail with the same message.
    // Say so once, in full, instead of a transient toast nobody can act on.
    if (err.misconfigured) {
      $view.replaceChildren(h('div', { class: 'notice' },
        icon('alert'),
        h('div', {},
          h('strong', { text: 'API недоступен' }),
          h('p', { style: 'margin:8px 0 0', text: err.message }),
        ),
      ));
      return;
    }
    toast('сервер недоступен', true);
  }
  const stats = await api('/api/stats').catch(() => null);
  if (stats) {
    document.getElementById('statItems').textContent = String(stats.items);
    document.getElementById('footStats').textContent = `${stats.items} публикаций · ${bytes(stats.bytes)}`;
  }
  // Before the first route, so the rail shows the right control on arrival and a
  // stored token is validated rather than assumed.
  await refreshAccount();
  restoreDeepLink();
  await route();
}

/**
 * Takes the address bar back after GitHub Pages served 404.html.
 *
 * A deep link like /cheatlab/i/abc has no file behind it, so Pages answers 404
 * and 404.html parks the requested path in sessionStorage before bouncing to
 * the app root. Restoring it here means the visitor lands on the page they asked
 * for with the right URL, without the extra request a redirect would cost and
 * without a second Pages 404.
 *
 * The stored value is dropped on the way out either way, so a stale entry can
 * never hijack a later visit, and it is only honoured when it still points
 * inside this deployment.
 */
function restoreDeepLink() {
  const KEY = 'cheatlab.redirect';
  let saved;
  try {
    saved = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return;
  }
  if (!saved) return;
  const path = new URL(saved, location.origin);
  if (path.origin !== location.origin || !isAppLink(path.pathname)) return;
  history.replaceState({}, '', path.pathname + path.search + path.hash);
}

boot();
