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
    // `value` is a property, not an attribute: the attribute only records the
    // *default* value, so anything that resets or retypes the field afterwards
    // would leave the field showing what it was created with. Setting the
    // property is also what lets a test read back what the form was given.
    else if (k === 'value') el.value = v;
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

/* ------------------------------------------------------------- downscaling */

const IMAGE_MAX_EDGE = 1920;  // px on the long edge
const IMAGE_LEAVE_ALONE = 1.5 * 1024 * 1024; // already-small files are not worth re-encoding

/**
 * Shrinks a picture in the browser before it is uploaded.
 *
 * A phone screenshot of a menu is routinely 4-8 MB of pixels, and a cheat
 * listing is mostly screenshots: uploaded as-is they cost the reader a mobile
 * data plan, fill the author's storage quota with images nobody sees at that
 * resolution, and make the gallery feel broken on a slow connection. The fix
 * belongs here rather than on the server because the bytes never have to cross
 * the network at all - the original is discarded before the upload starts.
 *
 * The rules are deliberately conservative, because this code is running on other
 * people's files:
 *
 *   - GIF and SVG are returned untouched. A GIF is animated - one frame of it
 *     would be a silent, wrong picture - and an SVG is a vector that is already
 *     small and that re-encoding through a raster canvas would only blur.
 *   - A picture that is already small enough is returned untouched, so quality
 *     is never spent to save bytes nobody needed saved.
 *   - WebP is preferred, and falls back to JPEG and then to PNG. WebP keeps text
 *     in a screenshot legible at a fraction of a PNG's size, which matters
 *     because screenshots of code are the point of most of these posts.
 *   - If re-encoding does not actually pay for itself - the "save 4 MB" numbers
 *     come from a lossy re-encode, and a 900 KB PNG that stays 880 KB is not
 *     worth a second of everyone's time - the original bytes are kept and only
 *     the dimensions change.
 *
 * Returns the file to upload plus what happened, so the queue can tell the
 * author their picture was changed instead of silently substituting something
 * else for it.
 */
async function downscaleImage(file) {
  const result = { file, changed: false, note: '' };
  if (!/^image\//.test(file.type)) return result;
  if (/gif|svg/i.test(file.type)) return result;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A file whose type claims to be an image but that will not decode is not
    // this function's problem to solve - the upload will fail with a real
    // message, and failing here would only replace it with a vaguer one.
    return result;
  }

  const longEdge = Math.max(bitmap.width, bitmap.height);
  const needsResize = longEdge > IMAGE_MAX_EDGE;
  if (!needsResize && file.size <= IMAGE_LEAVE_ALONE) {
    bitmap.close?.();
    return result;
  }

  const scale = needsResize ? Math.min(1, IMAGE_MAX_EDGE / longEdge) : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // A JPEG has no alpha channel, so a transparent PNG flattened onto it comes
  // out with a black background unless the canvas is filled first.
  const target = /png/.test(file.type) ? 'image/png' : 'image/jpeg';
  if (target === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const quality = /png/.test(file.type) ? undefined : 0.9;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, target, quality));
  if (!blob) return result;

  // WebP is smaller than both of the above for this kind of picture, so it is
  // tried as well - but only swapped in when it wins by enough to be worth the
  // tiny quality difference.
  if (target !== 'image/webp') {
    const webp = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (webp && webp.size < blob.size * 0.8) blob = webp;
  }

  const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[blob.type] || 'bin';
  // The upload sends the name in a header and the server decides what a file is
  // from that name, so the extension has to follow the new type or the gallery
  // will refuse to render the picture it just received.
  const name = file.name.replace(/\.[^.]*$/, '') + `.${ext}`;
  const before = file.size;
  const scaled = new File([blob], name, { type: blob.type, lastModified: file.lastModified });
  const shrank = scaled.size < before * 0.98;
  const resized = needsResize;
  if (!shrank && !resized) return { file, changed: false, note: '' };
  result.file = scaled;
  result.changed = true;
  result.note = `${width}×${height}, ${bytes(blob.size)}`;
  return result;
}

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
    // A Blob or ArrayBuffer is a file upload: it carries its own content-type in
    // the blob's type, and JSON.stringify would turn the bytes into "[object
    // Blob]". Only a plain value is JSON, and only then does the helper set a
    // content-type, so an upload's declared type is what actually reaches the API.
    // `typeof` guards rather than plain `instanceof`, because this helper also
    // runs where the global is absent and a bare reference would throw before the
    // request is even made.
    const isBlob = (typeof Blob !== 'undefined' && body instanceof Blob)
      || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer);
  if (body !== undefined && !isBlob) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
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
  // An uploaded avatar is served by our own API rather than hotlinked from
  // somewhere else, so it cannot be blocked or go away: the account's own bytes,
  // on the same host as the profile. It wins over the `logo` URL field, which
  // stays available for people pointing at an image they already host.
  const src = user.avatar ? API + user.avatar : user.logo;
  if (!src) return box;
  // The letter stays underneath and simply gets covered, so a failed load needs
  // no DOM change at all: a hotlinked logo can 404 or be blocked at any time.
  box.prepend(h('img', {
    class: 'avatar-img', src, alt: '', loading: 'lazy', decoding: 'async',
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
      item.game ? h('span', { class: 'row-game' }, gameChip(item.game)) : null,
    ),
    h('span', { class: 'row-right' },
      lockChip(item),
      item.visibility === 'unlisted' ? icon('link', 'i i-sm') : null,
      h('span', { text: when(item.createdAt) }),
    ),
  );
}

/**
 * The game chip: a cover, the game's name, its studio, and a link to the rest of
 * what has been written about it.
 *
 * It is not an <a> around the cover for one reason - an image inside a link with
 * text beside it is announced twice by a screen reader, and the whole chip is
 * already clickable. The name alone is the link.
 *
 * The cover is only drawn when the server accepted it. A cover that failed the
 * worker's https-and-image-extension check comes back as an empty string, and
 * rendering that as `<img src="">` would re-request the page itself as an image,
 * so the fallback letter tile is not cosmetic.
 */
const gameChip = (game) => h('span', { class: 'chip chip-game' },
  game.cover
    ? h('img', { class: 'chip-cover', src: game.cover, alt: '', loading: 'lazy', decoding: 'async' })
    : h('span', { class: 'chip-cover chip-cover-empty' }, icon('game', 'i i-sm')),
  h('span', { class: 'chip-text' },
    h('a', { class: 'chip-game-name', href: gamePageHref(game), text: game.name || 'игра' }),
    game.author ? h('span', { class: 'chip-game-author', text: game.author }) : null,
  ),
);

/**
 * Where a chip points.
 *
 * The id goes in the path and nothing else does: the name and the cover are
 * re-read from the post on the destination, so a link cannot be edited into a
 * chip that claims to be a different game. A chip with no usable id - which is
 * the one case the server can hand back, if a cover or name was rejected - links
 * nowhere and says so, rather than to a page that would silently list everything.
 */
function gamePageHref(game) {
  return /^\d{1,20}$/.test(game.id || '') ? `/games/${game.id}` : null;
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

// A game's own page, reachable from the chip on any post about it. The id is
// numeric and bounded, which keeps it out of the shape of anything else the
// router matches.
const GAME_PAGE = /^\/games\/(\d{1,20})$/;

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
  // A game's page arrives here as `/search?game=<id>`, so the filter is read in
  // one place with the others rather than being rebuilt by the caller. Reading it
  // from the url is also what keeps a hand-typed `/search?game=…` link working
  // even though nothing in the site links to that form.
  const game = url.searchParams.get('game') || '';
  const sort = url.searchParams.get('sort') === 'hot' ? 'hot' : 'new';
  const filtered = q || tag || game;
  const title = FEED_TITLE[type] || 'Публикации';
  const blurb = FEED_BLURB[type] || 'Всё, что опубликовали пользователи.';

  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', { text: q ? `Поиск: ${q}` : tag ? `#${tag}` : title }),
        h('p', { class: 'page-sub', text: q || tag ? 'Совпадения по названию, тегу и содержимому.' : blurb }),
      ),
      h('div', { class: 'spacer' }),
      sortTabs(sort, filtered
        ? (tag ? `/search?tag=${encodeURIComponent(tag)}` : q ? `/search?q=${encodeURIComponent(q)}` : `/games/${game}`)
        : (type ? FEED_PATH[type] : '/')),
    ),
  );

  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  if (game) params.set('game', game);
  params.set('sort', sort);
  params.set('limit', '40');

  const { items, total } = await api(`/api/items?${params}`);
  const list = h('div', { class: 'list' });
  if (!items.length) {
    $view.append(emptyState(
      filtered ? 'Ничего не нашлось' : 'Пока пусто',
        filtered ? 'Попробуй другой запрос или сними фильтр.' : 'Опубликуй первым — регистрация не обязательна.',
      '/new', 'Опубликовать',
    ));
    return;
  }
  // A game's page is headed by the game, taken from a post about it rather than
  // from the url, so a shared link cannot rename the game it points at. The id is
  // matched strictly on purpose: if the server ever stopped filtering, the
  // heading would go missing rather than name the wrong game.
  if (game) {
    const named = items.find((it) => it.game?.id === game)?.game;
    if (named) $view.firstChild?.firstChild?.replaceChildren(gameHeading(named));
  }
  for (const item of items) list.append(typeRow(item));
  $view.append(list, h('p', { class: 'hint', style: 'margin-top:16px', text: `${total} всего` }));
}

/** The `<h1>` of a game's page: its chip, at heading size. */
function gameHeading(game) {
  return h('span', { class: 'page-title-row' }, gameChip(game));
}

/**
 * A game's page: the chip, and every post written about it.
 *
 * It reuses the feed and points the API at `?game=`, so there is one list to keep
 * working rather than a second implementation to keep in step. The chip is
 * resolved through the same lookup the publish form uses, which is what makes
 * this work for a game that nobody has posted about yet - the page still has a
 * name and a cover instead of a bare id.
 */
async function viewGame(id) {
  $view.replaceChildren(h('p', { class: 'hint', text: 'Загрузка...' }));
  let game = null;
  try {
    const found = await api(`/api/games/roblox/${id}`);
    game = { id: found.gameId, name: found.gameName, author: found.gameAuthor, cover: found.gameCover };
  } catch {
    // A game Roblox will not name is still worth a page: the posts exist and are
    // filterable by id alone, so the list below is not conditional on the lookup.
  }
  const url = new URL(location.href);
  url.search = `?game=${encodeURIComponent(id)}`;
  url.pathname = '/search';
  await viewFeed('/search', url);
  // The lookup wins over whatever the feed derived, because it is the only source
  // that can name a game with no posts yet. It runs last, so on the common path -
  // a game with posts - the two agree and this changes nothing.
  if (game) $view.firstChild?.firstChild?.replaceChildren(gameHeading(game));
}

/**
 * The image carousel.
 *
 * One slide at a time, with arrows, dots and a counter. It is built here rather
 * than with a scroll-snap container because the two behave differently in a way
 * that matters for screenshots: a snapped scroll shows a sliver of the next
 * picture, which invites the reader to keep swiping and lose their place, while
 * a carousel shows exactly one image and says how many there are.
 *
 * Three ways to move, because the device is unknown and a gesture-only control
 * is unusable with a keyboard:
 *   - the arrows and dots, which are real buttons and work everywhere;
 *   - left/right arrow keys while the carousel has focus;
 *   - a horizontal swipe, which is what a phone reader will try first.
 *
 * Pictures are fetched as the reader reaches them: the current one and the two on
 * either side, three in total however many the post has. A post with twenty
 * screenshots costs three downloads until the reader asks for the rest, and an
 * arrow press still lands on a picture that is already there rather than on a
 * spinner.
 */
function imageCarousel(files, key) {
  // The images are kept in a list of their own rather than dug back out of the
  // slides with firstChild. A slide is a <figure> with an image and a caption in
  // it, and any edit to that structure - a wrapper, a text node, a comment -
  // would then silently point the lazy loader at the wrong element, which shows
  // up as a picture that never loads rather than as an error.
  const imgs = files.map((f) => h('img', { class: 'media-img', alt: f.name, loading: 'lazy', decoding: 'async' }));
  const slides = files.map((f, i) => h('figure', { class: 'media-item' },
    imgs[i],
    h('figcaption', {},
      // The name opens the picture itself, which is what a reader who just saw
      // the file name click on. It carries the key only for a locked post, so
      // the shared link never spreads someone else's key any further than the
      // download button next to it already does.
      h('a', { class: 'media-name', href: mediaUrl(f.id, key), target: '_blank', rel: 'noopener', text: f.name }),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.id, key) }, icon('download', 'i i-sm'), 'Скачать'),
    ),
  ));
  let index = 0;
  let loaded = new Set();

  const counter = h('span', { class: 'carousel-count' });
  const dots = h('div', { class: 'carousel-dots' });
  const stage = h('div', { class: 'carousel-stage' }, slides);

  const load = (i) => {
    if (loaded.has(i)) return;
    loaded.add(i);
    imgs[i].src = mediaUrl(files[i].id, key);
  };

  const show = (next) => {
    index = (next + files.length) % files.length;
    // Load the neighbours so an arrow press lands on a picture that is already
    // there instead of a spinner.
    load(index);
    load((index + 1) % files.length);
    load((index - 1 + files.length) % files.length);
    stage.style.setProperty('--carousel-index', String(index));
    for (const [i, dot] of [...dots.children].entries()) {
      dot.setAttribute('aria-current', i === index ? 'true' : 'false');
    }
    counter.textContent = `${index + 1} / ${files.length}`;
    prev.disabled = prev.hidden = files.length < 2;
    next.disabled = next.hidden = files.length < 2;
  };

  const prev = h('button', {
    class: 'carousel-nav carousel-prev', type: 'button', 'aria-label': 'Предыдущее фото',
    onclick: () => show(index - 1),
  }, icon('back', 'i i-sm'));
  const next = h('button', {
    class: 'carousel-nav carousel-next', type: 'button', 'aria-label': 'Следующее фото',
    onclick: () => show(index + 1),
  }, icon('next', 'i i-sm'));

  files.forEach((f, i) => {
    const dot = h('button', {
      class: 'carousel-dot', type: 'button', 'aria-label': `Фото ${i + 1}`,
      onclick: () => show(i),
    });
    dots.append(dot);
  });

  // Keyboard: only while the carousel itself holds focus, so the arrows on the
  // feed and in the comment box keep working while the reader is typing.
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
  };

  // Swipe. A pointer that moves mostly sideways and much further than it moves
  // vertically is a swipe; anything else is a scroll or a tap and is left alone,
  // which is what keeps a long picture from being flip-flopped by a reader just
  // trying to scroll past it.
  let start = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    start = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
  });
  stage.addEventListener('pointercancel', () => { start = null; });

  const root = h('div', {
    class: 'carousel', tabindex: '0', role: 'group', 'aria-roledescription': 'карусель',
    onkeydown: onKey,
  },
    h('div', { class: 'carousel-head' }, h('span', { class: 'pill pill-mute' }, icon('image', 'i i-sm'), 'Фото'), h('span', { class: 'spacer' }), counter),
    h('div', { class: 'carousel-box' }, stage, prev, next),
    files.length > 2 ? dots : null,
  );
  show(0);
  return root;
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
   * Media previews. Rendered below the code so a script is read before the
   * screenshots that illustrate it - a reader who opened a listing wants the
   * script, and the pictures are the second question, not the first.
   *
   * Pictures become a carousel once there is more than one: a cheat post with
   * six screenshots otherwise becomes a scroll the length of a phone screen, and
   * the last one - usually the one with the answer - is the picture nobody sees.
   * Video and audio are left as their own blocks, because a carousel that
   * swaps a playing clip out from under it is worse than a long page.
   *
   * A locked item never reaches this branch - the server sends no file list at
   * all until a key matches - so nothing here has to guess whether a media URL
   * is going to answer 403.
   */
  const mediaFiles = item.files.filter((f) => isImageFile(f) || isVideoFile(f) || isAudioFile(f));
  const caption = (f, src) => h('figcaption', {},
    h('a', { href: src, target: '_blank', rel: 'noopener', text: f.name }),
    h('span', { class: 'spacer' }),
    h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.id, key) }, icon('download', 'i i-sm'), 'Скачать'),
  );
  const pictures = mediaFiles.filter(isImageFile);
  const clips = mediaFiles.filter((f) => !isImageFile(f));
  // One picture needs no carousel - it is already a single slide, and the
  // arrows and dots would be decoration around something the reader can see.
  const single = pictures.length === 1 ? pictures : [];
  const gallery = pictures.length > 1 ? imageCarousel(pictures, key) : null;
  const media = mediaFiles.length
    ? h('div', { class: 'media' },
        gallery,
        ...single.map((f) => {
          const src = mediaUrl(f.id, key);
          return h('figure', { class: 'media-item' },
            h('img', { class: 'media-img', src, alt: f.name, loading: 'lazy', decoding: 'async' }),
            caption(f, src),
          );
        }),
        ...clips.map((f) => {
          const src = mediaUrl(f.id, key);
          return isVideoFile(f)
            ? h('figure', { class: 'media-item' },
                h('video', { class: 'media-video', src, controls: true, preload: 'metadata', playsinline: true }),
                caption(f, src),
              )
            : h('figure', { class: 'media-item' },
                h('audio', { class: 'media-audio', src, controls: true, preload: 'metadata' }),
                caption(f, src),
              );
        }),
      )
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
            h('span', { class: 'author-nick' },
              h('span', { text: owner.nick }),
              // The editorial mark sits next to the name, not in the sidebar:
              // the reason someone is popular is who they are, and it should be
              // visible where the post is read.
              owner.popular
                ? h('span', {
                    class: 'popular-badge', title: 'Популярный автор',
                    'aria-label': 'популярный автор',
                  }, icon('star', 'i i-sm'), ' популярный')
                : null,
            ),
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
        item.game ? h('dt', { text: 'Игра' }) : null,
        item.game ? h('dd', {}, gameChip(item.game)) : null,
        item.keySystem ? h('dt', { text: 'Ключевая система' }) : null,
        item.keySystem ? h('dd', { text: item.keySystem }) : null,
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
        // Available to the author too: reporting your own post is how you ask
        // for it to be taken down without deleting it, and a moderator acting on
        // a report leaves the trail that makes the queue auditable.
        h('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => fileReport('item', item.id, `публикацию «${item.title}»`),
        }, icon('alert', 'i i-sm'), 'Пожаловаться'),
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
        // The code comes before the attachments. A post is filed under a type
        // because of what it contains, and the body is the thing itself - the
        // screenshots exist to illustrate it. It also means a long code block
        // starts right under the title instead of below a full-screen picture a
        // reader has to scroll past to reach anything.
        gated ? lockScreen() : body,
        gated ? null : media,
        gated ? null : files,
        gated ? null : commentsPanel(item),
      ),
      sidebar,
    ),
  );
}

/**
 * Comments. The API has had them for a while, but nothing rendered them, which
 * left the report dialog's "комментарий" target with no ID to point at.
 *
 * Rendering it here rather than behind a tab keeps the reading position: a
 * comment is part of the post, and a reader who has to go somewhere else to see
 * that anyone replied has already lost the thread.
 */
function commentsPanel(item) {
  const panel = h('section', { class: 'panel' });
  const list = h('div', { class: 'comment-list' });
  const count = h('span', { class: 'pill pill-mute' });

  const load = async () => {
    try {
      const { comments } = await api(`/api/items/${item.id}/comments`);
      count.textContent = String(comments.length);
      list.replaceChildren(...(comments.length
        ? comments.map((c) => h('div', { class: 'comment' },
            h('a', { class: 'comment-head', href: c.userId ? `/u/${c.userId}` : null },
              // avatarFor falls back to the letter tile, so a comment from a
              // deleted account still renders as something rather than a gap.
              avatarFor({ nick: c.nick, avatar: c.avatar }, 28),
              h('span', { class: 'comment-nick', text: c.nick }),
              c.popular
                ? h('span', { class: 'popular-badge popular-badge-sm', title: 'Популярный автор' }, icon('star', 'i i-sm'))
                : null,
              h('span', { class: 'hint', text: ago(c.createdAt) }),
            ),
            h('p', { class: 'comment-body', text: c.body }),
            h('div', { class: 'field-row' },
              // Report, not delete: a reader cannot remove someone else's words,
              // and a complaint is the only lever they have.
              h('button', {
                class: 'btn btn-sm btn-ghost',
                onclick: () => fileReport('comment', c.id, `комментарий к «${item.title}»`),
              }, icon('alert', 'i i-sm'), 'Пожаловаться'),
              c.canDelete ? h('button', {
                class: 'btn btn-sm btn-ghost',
                onclick: async () => {
                  try {
                    await api(`/api/comments/${c.id}`, { method: 'DELETE' });
                    toast('Комментарий удалён');
                    await load();
                  } catch (err) { toast(err.message, true); }
                },
              }, icon('trash', 'i i-sm'), 'Удалить') : null,
            ),
          ))
        : [h('p', { class: 'empty', text: 'Комментариев пока нет.' })]));
    } catch (err) {
      list.replaceChildren(h('p', { class: 'empty', text: err.message }));
    }
  };

  const form = (() => {
    const textArea = h('textarea', { class: 'textarea textarea-short', rows: 3, maxlength: 2000, placeholder: 'По существу публикации.' });
    const sendBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Отправить');
    const notice = h('p', { class: 'form-error', role: 'alert' });
    if (!signedIn()) {
      return h('p', { class: 'hint' },
        'Чтобы комментировать, ',
        h('a', { href: '/auth', text: 'войдите' }),
        '.',
      );
    }
    return h('form', {
      class: 'field',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = textArea.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        notice.textContent = '';
        try {
          await api(`/api/items/${item.id}/comments`, { method: 'POST', body: { body: text } });
          textArea.value = '';
          toast('Комментарий отправлен');
          await load();
        } catch (err) {
          // A ban surfaces here as well as on the publish page: the account can
          // still read, and the reason belongs where the action was refused.
          notice.textContent = err.message;
        } finally { sendBtn.disabled = false; }
      },
    },
      h('span', { class: 'label' }, 'Ваш комментарий'),
      textArea,
      h('div', { class: 'field-row' },
        sendBtn,
        h('span', { class: 'hint', text: 'Комментарий можно удалить только вам.' }),
      ),
      notice,
    );
  })();

  panel.append(
    // The heading is added here rather than with the panel above, because the
    // count next to it only exists once the comments have loaded.
    h('div', { class: 'field-row' },
      h('div', { class: 'panel-title', style: 'margin:0' }, icon('hash', 'i i-sm'), ' Комментарии'),
      h('span', { class: 'spacer' }),
      count,
    ),
    form,
    list,
  );
  load();
  return panel;
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
    game: initial.game || null,
    keySystem: initial.keySystem || '',
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
   * The game and the key system.
   *
   * Both are one free-text box each, and both exist because "which game is this
   * for" and "what has to be running for it to work" are the first two questions
   * a reader asks about any post. Typed in prose they get missed; as fields they
   * get filled in.
   *
   * The game id is resolved to a name, a studio and a cover by the API, so the
   * author types one number instead of transcribing three fields - and cannot
   * accidentally point a chip at a different game than the one they meant by
   * typing the wrong name. Every field stays editable afterwards, because the
   * lookup can be wrong (a private place, a game that has since been renamed) and
   * an author who cannot correct it has no way to publish at all.
   */
  const gameIdInput = h('input', {
    class: 'input', id: 'f-game-id', inputmode: 'numeric', autocomplete: 'off', spellcheck: false,
    placeholder: '1818 или 909090', value: state.game?.id || '',
  });
  const gameNameInput = h('input', { class: 'input', id: 'f-game-name', value: state.game?.name || '', placeholder: 'название' });
  const gameAuthorInput = h('input', { class: 'input', id: 'f-game-author', value: state.game?.author || '', placeholder: 'студия или автор' });
  const gameCoverInput = h('input', {
    class: 'input', id: 'f-game-cover', value: state.game?.cover || '',
    placeholder: 'https://ссылка на обложку', spellcheck: false, autocomplete: 'off',
  });
  const gamePreview = h('div', { class: 'game-preview' });
  const gameStatus = h('p', { class: 'hint' });
  const lookup = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const id = gameIdInput.value.trim();
      if (!/^\d{1,20}$/.test(id)) { gameStatus.textContent = 'Нужен числовой id игры.'; gameIdInput.focus(); return; }
      lookup.disabled = true;
      gameStatus.textContent = 'Ищу игру…';
      try {
        const found = await api(`/api/games/roblox/${id}`);
        state.game = { id: found.gameId, name: found.gameName, author: found.gameAuthor, cover: found.gameCover };
        gameIdInput.value = found.gameId;
        gameNameInput.value = found.gameName;
        gameAuthorInput.value = found.gameAuthor;
        gameCoverInput.value = found.gameCover;
        drawPreview();
        gameStatus.textContent = found.cached ? 'Найдено (из кэша).' : 'Найдено.';
      } catch (err) {
        gameStatus.textContent = `${err.message}. Заполни поля вручную или оставь игру пустой.`;
        gamePreview.replaceChildren();
        state.game = null;
      } finally {
        lookup.disabled = false;
      }
    },
  }, icon('search', 'i i-sm'), 'Найти');

  function drawPreview() {
    if (!state.game?.name) { gamePreview.replaceChildren(); return; }
    gamePreview.replaceChildren(gameChip(state.game));
  }
  drawPreview();

  // Editing a name or a studio by hand has to be reflected in what gets sent,
  // and clearing the name has to clear the chip - otherwise the author fixes a
  // typo in the visible field and publishes the old text anyway.
  //
  // The four fields are read together rather than patched one at a time, so hand
  // typing can *start* a chip and not only correct one. That case is not
  // hypothetical: the lookup fails for a private place, and an author who then
  // types the name by hand must still get a chip instead of a form that quietly
  // publishes nothing at all. An id and a name are what a chip needs; the studio
  // and the cover are display detail and may stay empty.
  const readGameFields = () => {
    const id = gameIdInput.value.trim();
    const name = gameNameInput.value.trim();
    const author = gameAuthorInput.value.trim();
    const cover = gameCoverInput.value.trim();
    state.game = id && name ? { id, name, author, cover } : null;
    drawPreview();
  };
  for (const input of [gameIdInput, gameNameInput, gameAuthorInput, gameCoverInput]) {
    input.addEventListener('input', readGameFields);
  }

  const gamePanel = h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('game', 'i i-sm'), 'Игра'),
    h('div', { style: 'display:flex; flex-direction:column; gap:14px' },
      h('label', { class: 'field' },
        h('span', { class: 'label', text: 'ID игры' }),
        h('div', { class: 'field-row' }, gameIdInput, lookup),
        h('span', { class: 'hint', text: 'id плейса или universe из ссылки roblox.com/games' }),
      ),
      h('label', { class: 'field' },
        h('span', { class: 'label', text: 'Название' }), gameNameInput),
      h('label', { class: 'field' },
        h('span', { class: 'label', text: 'Студия / автор' }), gameAuthorInput),
      h('label', { class: 'field' },
        h('span', { class: 'label', text: 'Обложка' }), gameCoverInput,
        h('span', { class: 'hint', text: 'подставится сама после «Найти»; можно заменить или стереть' })),
      gamePreview,
      gameStatus,
    ),
  );

  const keySystemInput = h('input', {
    class: 'input', id: 'f-key-system', list: 'key-systems', maxlength: 40,
    value: state.keySystem, placeholder: 'необязательно',
    oninput: (e) => { state.keySystem = e.target.value.trim(); },
  });
  const keySystemList = h('datalist', { id: 'key-systems' },
    // Suggestions only. The field accepts anything, because the executors in use
    // change faster than this file will and a closed list would quietly refuse
    // to name the one a reader actually needs.
    ['Luasense', 'Synapse', 'Fluxus', 'Moon Sec', 'Codex', 'Delta', 'Arceus', 'Solara', 'Wave', 'Selenis']
      .map((name) => h('option', { value: name })));
  const keySystemPanel = h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('box', 'i i-sm'), 'Ключевая система'),
    h('label', { class: 'field' },
      keySystemInput,
      keySystemList,
      h('span', { class: 'hint', text: 'что должно быть запущено, чтобы скрипт работал' }),
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

  /**
   * Adds files to the queue, shrinking pictures on the way in.
   *
   * The size check happens after the downscale, not before, which reverses the
   * obvious order and is the whole point: a 12 MB phone screenshot is over the
   * limit as the camera wrote it and comfortably under it once it is 1920px
   * wide. Rejecting first would throw away exactly the files most worth
   * keeping. A 12 MB video has no such second chance and is refused as it is.
   */
  async function addFiles(list) {
    const rows = [];
    for (const original of list) {
      if (pending.length + existing.length + rows.length >= (config.limits.maxFilesPerItem || 60)) {
        toast('Лимит файлов на публикацию исчерпан', true);
        break;
      }
      const bar = h('span', { class: 'bar' }, h('span', { style: 'width:0%' }));
      const size = h('span', { text: bytes(original.size) });
      const row = h('div', { class: 'queue-row' },
        h('span', { text: original.name }),
        h('span', { class: 'spacer' }),
        size,
        bar,
      );
      queue.append(row);
      rows.push({ original, row, bar, size });
    }

    // dropping a picture or a clip should not also require picking the right tab
    if (!MEDIA_TYPES.has(state.type)) {
      const first = list.find((f) => /^image\//.test(f.type) || /^video\//.test(f.type));
      if (first) setType(/^image\//.test(first.type) ? 'image' : 'video');
    }

    // One file at a time: decoding a dozen 8 MB screenshots into bitmaps at once
    // is how a phone browser runs out of memory on the very photos the author
    // is trying to save space on.
    for (const entry of rows) {
      entry.row.classList.add('is-working');
      let file = entry.original;
      try {
        const shrunk = await downscaleImage(file);
        file = shrunk.file;
        if (shrunk.changed) {
          entry.row.firstChild.textContent = file.name;
          entry.size.textContent = `${bytes(entry.original.size)} → ${bytes(file.size)}`;
          entry.row.title = `уменьшено в браузере: ${shrunk.note}`;
        }
      } catch {
        // A picture that will not decode is still allowed through as itself, so
        // the upload can reject it with a message about the file rather than the
        // author seeing a silent gap in their queue.
      }
      entry.row.classList.remove('is-working');
      if (file.size > config.limits.maxFileBytes) {
        entry.row.replaceChildren(h('span', { text: entry.original.name }));
        entry.row.append(h('span', { class: 'spacer' }), h('span', { class: 'err', text: `больше ${bytes(config.limits.maxFileBytes)}` }));
        toast(`${entry.original.name}: больше лимита ${bytes(config.limits.maxFileBytes)}`, true);
        entry.row.remove();
        continue;
      }
      file._ui = { bar: entry.bar.firstChild, row: entry.row };
      pending.push(file);
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
      gamePanel,
      keySystemPanel,
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title', text: 'Как это работает' }),
        h('p', { class: 'hint', text: 'При публикации сервер выдаёт ключ редактирования — он остаётся в этом браузере. Секрет нужен, чтобы изменить или удалить запись. Анонимно — одна публикация в сутки с проверкой, с аккаунтом — двенадцать и без проверки.' }),
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
    // The game and the key system are sent only when they are filled in, and the
    // four game fields travel together. Sending gameName without gameId would
    // be dropped by the server anyway - a name with no id is a chip that points
    // nowhere - and sending them separately would let the author change the
    // visible name and keep the id of a different game.
    if (state.game?.id && state.game?.name) {
      payload.gameId = state.game.id;
      payload.gameName = state.game.name;
      payload.gameAuthor = state.game.author || '';
      payload.gameCover = state.game.cover || '';
    }
    if (state.keySystem) payload.keySystem = state.keySystem;
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
    // The popular mark is the operator's own editorial call, not a claim the
    // account makes about itself, so it is a separate badge from "admin".
    u.popular ? h('span', { class: 'popular-badge', title: 'Популярный автор' }, icon('star', 'i i-sm'), 'популярный') : null,
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
        // The entry point to the moderation console. Gated in the UI because the
        // role is already known here, and enforced again on every admin route -
        // a hidden link is a courtesy, not a permission.
        account?.admin || account?.role === 'moderator'
          ? h('a', { class: 'btn btn-ghost', href: '/admin' }, icon('shield', 'i i-sm'), 'Модерация')
          : null,
        !isMe ? h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: () => fileReport('user', u.id, `аккаунт @${u.nick}`),
        }, icon('alert', 'i i-sm'), 'Пожаловаться') : null,
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
    isMe ? avatarEditor(u, notice) : null,
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

/* ----------------------------------------------------------------- reports -- *
 * Filing one needs no account. The person who wants a post taken down often
 * has no reason to register first, and requiring registration to complain is
 * the surest way to get no complaints at all. What the reporter gets back is a
 * receipt id, which is also the thing to quote when following up.
 */

const REPORT_REASONS = [
  ['copyright', 'Авторские права'],
  ['illegal', 'Незаконный контент'],
  ['porn', 'Порнография'],
  ['violence', 'Насилие'],
  ['harassment', 'Оскорбления'],
  ['impersonation', 'Выдача себя за другого'],
  ['abuse', 'Оскорбление или домогательство'],
  ['spam', 'Спам'],
  ['other', 'Другое'],
];
const REASON_LABEL = Object.fromEntries(REPORT_REASONS);

function reportDialog(targetType, targetId, what) {
  return new Promise((resolve) => {
    const details = h('textarea', {
      class: 'textarea', rows: 4, maxlength: 1000,
      placeholder: 'Что именно не так? Ссылка, автор, дата — всё, что поможет разобраться.',
    });
    const reasonSelect = h('select', { class: 'select' },
      REPORT_REASONS.map(([value, label]) => h('option', { value, text: label })),
    );
    const error = h('p', { class: 'form-error', role: 'alert' });
    const done = (value) => { backdrop.remove(); resolve(value); };
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Отправить');

    const form = h('form', {
      class: 'panel auth-card',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          const res = await api('/api/reports', {
            method: 'POST',
            body: { targetType, targetId, reason: reasonSelect.value, details: details.value.trim() },
          });
          done(res);
        } catch (err) {
          error.textContent = err.message || 'не удалось отправить';
          submit.disabled = false;
        }
      },
    },
      h('h2', { text: 'Пожаловаться' }),
      h('p', { class: 'page-sub', text: `На ${what}. Аккаунт не нужен.` }),
      h('label', { class: 'field' },
        h('span', { class: 'label' }, 'Причина'),
        reasonSelect,
      ),
      h('label', { class: 'field' },
        h('span', { class: 'label' }, 'Подробности'),
        details,
      ),
      error,
      h('div', { class: 'field-row' },
        submit,
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => done(null) }, 'Отмена'),
      ),
    );

    const backdrop = h('div', {
      class: 'modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) done(null); },
    }, form);

    document.body.appendChild(backdrop);
    details.focus();
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
  });
}

/** Files a report and reports the outcome, including the receipt id. */
async function fileReport(targetType, targetId, what) {
  const res = await reportDialog(targetType, targetId, what);
  if (!res) return;
  toast(`Жалоба принята, номер ${res.id}. Мы разберём её и сообщим о решении.`, true);
}

/* ---------------------------------------------------------------- avatars -- *
 * Uploaded from the user's own device, so the image is shrunk in the browser
 * before it is sent. The server accepts 512 KiB and only four image types, and
 * re-encoding a 4 MB phone photo to a 256px square PNG is both the difference
 * between fitting that limit and not, and the reason the stored bytes are a
 * thumbnail rather than the original. The account's `logo` URL field stays
 * available for people who would rather point at an image they already host.
 */

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_EDGE = 256;

/**
 * Draws the image into a canvas at most AVATAR_EDGE on its longest side and
 * re-encodes it. A canvas of zero width throws in several browsers, which is
 * what happens for a malformed or still-loading image, so the size is read off
 * the element and the natural size is trusted only once it is non-zero.
 */
function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!AVATAR_TYPES.includes(file.type)) {
      reject(new Error('Нужен PNG, JPEG, WebP или GIF'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const long = Math.max(img.naturalWidth, img.naturalHeight);
      // A small GIF is kept as-is: re-encoding an animation through a canvas
      // flattens it to its first frame, which is a worse outcome than a
      // slightly larger file.
      if (!long || (file.type === 'image/gif' && file.size <= AVATAR_MAX_BYTES)) {
        resolve(file);
        return;
      }
      const scale = Math.min(1, AVATAR_EDGE / long);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(file); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) { resolve(file); return; }
        // WebP is the smallest of the three at this size, but it is not decodable
        // everywhere, so a JPEG fallback is used when the browser cannot make one.
        const out = blob.type === 'image/webp' ? blob : null;
        if (out && out.size <= AVATAR_MAX_BYTES) { resolve(out); return; }
        canvas.toBlob((jpeg) => resolve(jpeg && jpeg.size <= AVATAR_MAX_BYTES ? jpeg : file), 'image/jpeg', 0.86);
      }, 'image/webp');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Файл не читается как изображение'));
    };
    img.src = url;
  });
}

/** The avatar picker, shown only on your own profile. */
function avatarEditor(u, notice) {
  const file = h('input', { class: 'input', type: 'file', accept: AVATAR_TYPES.join(',') });
  const preview = h('div', { class: 'avatar-picker' });

  const paint = () => {
    preview.replaceChildren(avatarFor(u, 72),
      h('div', { class: 'field-row' },
        h('button', {
          class: 'btn btn-primary', type: 'button',
          onclick: async (e) => {
            const btn = e.currentTarget;
            if (!file.files || !file.files[0]) { notice.textContent = 'Выберите файл'; return; }
            btn.disabled = true;
            notice.textContent = '';
            try {
              const shrunk = await resizeAvatar(file.files[0]);
              if (shrunk.size > AVATAR_MAX_BYTES) {
                throw new Error(`Файл ${bytes(shrunk.size)} — больше лимита ${bytes(AVATAR_MAX_BYTES)}`);
              }
              const res = await api('/api/auth/avatar', { method: 'POST', body: shrunk });
              account = res.user;
              toast('Аватар обновлён');
              navigate(`/u/${u.id}`);
            } catch (err) {
              notice.textContent = err.message || 'не удалось загрузить';
              btn.disabled = false;
            }
          },
        }, 'Загрузить'),
        u.avatar ? h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const res = await api('/api/auth/avatar', { method: 'DELETE' });
              account = res.user;
              toast('Аватар удалён');
              navigate(`/u/${u.id}`);
            } catch (err) {
              notice.textContent = err.message;
              e.currentTarget.disabled = false;
            }
          },
        }, 'Убрать') : null,
      ),
    );
  };
  paint();

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('user', 'i i-sm'), ' Аватар'),
    h('div', { class: 'design-row' },
      preview,
      h('label', { class: 'field' },
        h('span', { class: 'label' }, 'Файл'),
        file,
        h('span', { class: 'hint', text: `PNG, JPEG, WebP или GIF, до ${bytes(AVATAR_MAX_BYTES)}. Большие фото уменьшаются в браузере.` }),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ legal --
 * Three documents and a report form. The text is deliberately plain: a rule
 * nobody reads because it was written for a lawyer is not a rule, and the one
 * obligation that is not negotiable is that a complaint reaches a person who
 * can act on it and that the person who filed it can be told what happened.
 */

const UPDATED = '15 сентября 2026';

function legalPage(title, intro, sections) {
  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', { text: title }),
        h('p', { class: 'page-sub', text: `Редакция от ${UPDATED}.` }),
      ),
    ),
    h('div', { class: 'panel legal' },
      h('p', { class: 'page-sub', text: intro }),
      sections.map(([head, ...paras]) => h('section', {},
        h('h2', { text: head }),
        paras.map((p) => h('p', { text: p })),
      )),
      h('p', { class: 'hint', text: 'Документы не отменяют закон. Если право требует от нас что-то, чего здесь нет, напишите, и мы это исправим.' }),
    ),
    h('p', { style: 'margin-top:18px' },
      h('a', { class: 'btn btn-ghost', href: '/report' }, icon('flag', 'i i-sm'), 'Пожаловаться на контент'),
    ),
  );
}

function viewRules() {
  legalPage('Правила площадки', 'Публикуя здесь, вы соглашаетесь с этими правилами. Площадка — анонимная: у аккаунта нет юридического лица, а у вас нет обязанностей перед третьими лицами, кроме тех, что вы добровольно взяли на себя, загрузив чужой материал.', [
    ['Что запрещено', 'Контент, нарушающий закон, материалы, права на которые у вас нет, чужие персональные данные, публикации, выдающие себя за других людей, угрозы и травлю.'],
    ['Что будет сделано', 'За нарушения аккаунт получает бан на срок от часа до бесконечности, публикация снимается, а ник блокируется. Решение модератора можно обжаловать, написав на почту, указанную в разделе «Контакты».'],
    ['Кто отвечает за контент', 'Автор. Площадка не предварительно проверяет публикации и не может гарантировать законность любого файла, но жалобы разбирает и принимает меры.'],
    ['Блокировки', 'Бан действует на аккаунт, а не на браузер: новый вход не снимает его. Срок виден при первой попытке публикации.'],
  ]);
}

function viewTerms() {
  legalPage('Условия использования', 'Сервис предоставляется как есть, без гарантий. Ниже — что именно это означает на практике.', [
    ['Что вы получаете', 'Публикацию файлов и текстов по ссылке, аккаунт с ключом редактирования, возможность закрыть публикацию ключом доступа и подписаться на других.'],
    ['Обязательства сервиса', 'Хранить опубликованное, пока оно не снято по вашей просьбе или по жалобе; отвечать на жалобы; не требовать оплаты за базовые функции.'],
    ['Обязательства автора', 'Не публиковать то, что запрещено правилами; отвечать на жалобы о своих материалах; не выдавать себя за другого человека.'],
    ['Ответственность', 'Сервис не отвечает за содержимое публикаций и за убытки, возникшие из-за них. Прямая ответственность сервиса ограничена суммой, фактически уплаченной за использование, то есть, при текущих тарифах, нулём.'],
    ['Прекращение', 'Аккаунт можно удалить, написав с него. Публикации удалённого аккаунта остаются, если под ними нет активной жалобы, иначе они снимаются.'],
  ]);
}

function viewPrivacy() {
  legalPage('Приватность', 'Сервис не продаёт данные и не строит на них рекламу. Ниже — что хранится и зачем.', [
    ['Что хранится', 'Для аккаунта: ник, описание, аватар, тема профиля, счётчики подписок и публикаций. Для посетителя без аккаунта: идентификатор устройства, дата первого визита и счётчик публикаций, к которым он обращался.'],
    ['Пароли', 'Пароль не хранится. Вместо него лежит PBKDF2-хеш с солью, из него нельзя восстановить пароль, только проверить его.'],
    ['Ключи', 'Ключ доступа к закрытой публикации хранится только у вас, в вашем браузере. Сервер хранит его хеш и короткую подсказку.'],
    ['Аватары', 'Файл аватара хранится на сервере и виден всем, кто открыл ваш профиль. Удаление аккаунта удаляет аватар.'],
    ['Кто читает жалобы', 'Жалобы видят администраторы и модераторы. В жалобе нет вашего аккаунта, если вы отправили её без входа, но есть идентификатор устройства, по которому её можно отличить от повторной.'],
    ['Срок хранения', 'Публикации и аккаунты хранятся, пока их не удалили. Аккаунты, не заходившие более года, удаляются вместе с публикациями.'],
  ]);
}

/** The report form, as a page. Filing one needs no account. */
async function viewReport() {
  const targetId = new URL(location.href).searchParams.get('id') || '';
  const notice = h('p', { class: 'form-error', role: 'alert' });
  const target = h('input', {
    class: 'input', maxlength: 40, value: targetId,
    placeholder: 'ID публикации или аккаунта', spellcheck: false, autocomplete: 'off',
  });
  const kind = h('select', { class: 'select' },
    [['item', 'Публикация'], ['user', 'Аккаунт'], ['comment', 'Комментарий']]
      .map(([v, l]) => h('option', { value: v, text: l })),
  );
  const reason = h('select', { class: 'select' },
    REPORT_REASONS.map(([v, l]) => h('option', { value: v, text: l })),
  );
  const details = h('textarea', { class: 'textarea', rows: 5, maxlength: 1000, placeholder: 'Что именно не так и где это видно.' });

  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, icon('flag', 'i i-sm'), ' Пожаловаться'),
        h('p', { class: 'page-sub', text: 'Аккаунт не нужен. Ответ придёт по номеру обращения.' }),
      ),
    ),
    h('form', {
      class: 'panel legal',
      onsubmit: async (e) => {
        e.preventDefault();
        const id = (target.value || '').trim();
        if (!id) { notice.textContent = 'Укажите ID публикации или аккаунта.'; return; }
        try {
          const res = await api('/api/reports', {
            method: 'POST',
            body: { targetType: kind.value, targetId: id, reason: reason.value, details: (details.value || '').trim() },
          });
          notice.textContent = '';
          $view.replaceChildren(
            h('div', { class: 'page-head' }, h('h1', { text: 'Жалоба принята' })),
            h('div', { class: 'panel legal' },
              h('p', { text: `Номер обращения: ${res.id}. Сохраните его — по нему можно уточнить, чем закончилось разбирательство.` }),
              h('p', { class: 'page-sub', text: 'Мы разбираем жалобы в порядке поступления. Если речь о чужих персональных данных или о нелегальном контенте, разбираем быстрее.' }),
            ),
            h('p', { style: 'margin-top:18px' }, h('a', { class: 'btn btn-ghost', href: '/' }, 'На главную')),
          );
        } catch (err) { notice.textContent = err.message; }
      },
    },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Что именно'), kind),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'ID'), target),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Причина'), reason),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Подробности'), details),
      notice,
      h('div', { class: 'field-row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Отправить')),
      h('p', { class: 'hint', text: 'Ложные жалобы приводят к бану аккаунта. Не используйте форму для спама или разбирательств с людьми.' }),
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
  const [s, p] = await Promise.all([api('/api/stats'), api('/api/plugins')]);
  const line = (label, value) => [h('dt', { text: label }), h('dd', { text: String(value) })];
  $view.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Состояние' }), h('p', { class: 'page-sub', text: 'Счётчики хранилища и загруженные серверные плагины.' }))),
    h('div', { class: 'split' },
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title' }, icon('user', 'i i-sm'), ' Люди'),
        // People, not storage. A visitor counter that only counts publishers
        // understates the site by an order of magnitude, so the client that
        // every page load sends is counted here.
        h('dl', { class: 'kv' },
          ...line('Аккаунтов', s.users ?? 0),
          ...line('Устройств', s.clients ?? 0),
          ...line('Открытых жалоб', s.openReports ?? 0),
          ...line('Действующих банов', s.activeBans ?? 0),
        ),
      ),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title', text: 'Хранилище' }),
        h('dl', { class: 'kv' },
          ...line('Публикаций', s.items),
          ...line('Скриптов', s.scripts),
          ...line('Паст', s.pastes),
          ...line('Приложений', s.apps),
          ...line('Файлов', s.files),
          ...line('Объём', bytes(s.bytes)),
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

/* ------------------------------------------------------------------ chat -- */

/**
 * The socket, keyed by conversation.
 *
 * One connection per open room rather than one for the whole site: a channel and
 * a direct message have different readers, so a single multiplexed stream would
 * have to filter by conversation anyway. It also means a room that is busy does
 * not delay the one you are typing in.
 *
 * The ticket is spent on the first handshake, so a socket that drops and has to
 * be replaced needs a fresh one. That is why `connect` is called again rather
 * than reusing anything.
 */
const chatSockets = new Map();
let chatRoom = null;
let chatMessages = [];
let chatOlder = null;
let chatBacklog = true;
// The log and the field are held here rather than looked up by id on every use:
// both are rebuilt on each render, and the app already treats a small set of
// static nodes (the view, the toast, the search box) this way.
let chatLog = null;
let chatField = null;
/**
 * The file waiting to go out with the next message, or null.
 *
 * Held here rather than in the composer because a render rebuilds the composer
 * and would otherwise drop the picked file every time anything else re-painted.
 */
let chatPick = null;

/**
 * The half-typed message, kept here rather than read back off the field.
 *
 * The composer is rebuilt on every render, and a render happens for reasons that
 * have nothing to do with the writer: somebody else's message arrives, a read
 * marker lands, a slow history page fills in. Reading the draft off the DOM would
 * mean losing whatever was typed every time one of those happened, so the field
 * is drawn from this and writes to it.
 */
let chatDraft = '';

/**
 * How many messages have arrived while the reader was scrolled up, and the first
 * of them.
 *
 * The count is for the button that takes them back down; the id is for the line
 * drawn through the log, because "you have missed something" is only useful if
 * the something has an edge you can see.
 */
let chatMissed = 0;
let chatUnreadFrom = null;

/** Resets both when a different conversation is opened. */
function chatClearMissed() {
  chatMissed = 0;
  chatUnreadFrom = null;
}

const dayKey = (ms) => {
  const d = new Date(ms || 0);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** "Сегодня" beats a date the reader has to work out themselves. */
function dayLabel(ms) {
  const then = new Date(ms || 0);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (dayKey(then.getTime()) === dayKey(today.getTime())) return 'Сегодня';
  if (dayKey(then.getTime()) === dayKey(yesterday.getTime())) return 'Вчера';
  return then.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * True when `b` is another message from the same person, close enough in time and
 * same day, that repeating their name above it would only be noise.
 */
const sameRun = (a, b) => !!a && !!b && a.userId === b.userId
  && dayKey(a.createdAt) === dayKey(b.createdAt)
  && (b.createdAt || 0) - (a.createdAt || 0) < 5 * 60 * 1000;

/** Drops the socket for a room and clears its reconnect timer. */
function chatClose(convId) {
  const open = chatSockets.get(convId);
  if (open?.timer) clearTimeout(open.timer);
  if (open?.ws) {
    try { open.ws.close(); } catch { /* already closing */ }
  }
  chatSockets.delete(convId);
}

/**
 * Opens the live connection for a room.
 *
 * The ticket exists because a browser cannot attach the session header to a
 * WebSocket handshake. It is exchanged over an ordinary authenticated POST, used
 * once, and expires in a minute - so a ticket that leaks in a log is worthless
 * almost immediately, unlike a session token in a query string.
 */
async function chatConnect(convId) {
  chatClose(convId);
  let grant;
  try {
    grant = await api(`/api/chats/${convId}/ticket`, { method: 'POST' });
  } catch {
    // A reader who may only read cannot hold a socket: the ticket is minted for
    // people who may post. History still works, it just does not update itself.
    return;
  }
  if (!grant?.ticket || !grant?.url || chatRoom?.id !== convId) return;

  // The API lives on another origin from the page, so the socket has to be built
  // from the API's origin rather than the page's - and http has to become ws,
  // which is why the path comes from the server instead of being assembled here.
  const base = (API || '').replace(/^http/, 'ws') || location.origin.replace(/^http/, 'ws');
  const query = new URLSearchParams({ id: convId, t: grant.ticketId, ticket: grant.ticket });
  let ws;
  try {
    ws = new WebSocket(`${base}${grant.url}?${query}`);
  } catch {
    return;
  }
  const entry = { ws, timer: null };
  chatSockets.set(convId, entry);

  ws.onmessage = (ev) => {
    let frame;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object' || chatRoom?.id !== convId) return;
    // "stale" means something was stored while this room had no subscribers, so
    // the socket cannot say what - history is re-read once rather than guessed at.
    if (frame.t === 'stale') { chatOpen(convId); return; }
    if (frame.t !== 'msg' || !frame.m) return;
    chatAdd(frame.m);
  };

  ws.onopen = () => {
    entry.open = true;
    if (chatRoom?.id !== convId) return;
    chatRoom.live = true;
    // A socket that had to be re-opened missed everything said while it was
    // down - the room does not replay it - so history is read again once here.
    // The first connection needs no re-read: chatOpen just fetched it.
    if (chatRoom.connects++ > 0) chatOpen(convId, { keepSocket: true });
  };

  ws.onclose = () => {
    if (chatSockets.get(convId) !== entry) return;
    chatSockets.delete(convId);
    entry.open = false;
    if (chatRoom?.id === convId) chatRoom.live = false;
    // Only reconnect while the room is still on screen: a background tab must
    // not keep a socket open, and neither must a room the user has left.
    if (chatRoom?.id !== convId) return;
    entry.timer = setTimeout(() => {
      if (chatRoom?.id === convId) chatConnect(convId);
    }, 4000);
  };
  ws.onerror = () => { /* onclose does the recovery */ };
}

// A laptop that was asleep comes back with its socket already dead and no error
// worth reporting, so the room is re-opened when the tab becomes visible again or
// the network returns. Both are cheap: one ticket, and only if nothing is open.
addEventListener('online', () => { if (chatRoom?.id && !chatSockets.has(chatRoom.id)) chatConnect(chatRoom.id); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (chatRoom?.id && !chatSockets.has(chatRoom.id)) chatConnect(chatRoom.id);
});

/**
 * Reads one page of history and draws the room.
 *
 * `keepSocket` re-reads history without touching the connection, which is what a
 * reconnect needs: the socket is already open, and minting another ticket would
 * throw away the one that just worked.
 */
async function chatOpen(convId, { keepSocket = false } = {}) {
  if (!convId) return;
  if (!keepSocket) {
    chatClose(chatRoom?.id);
    chatRoom = { id: convId, connects: 0, live: false };
    chatMessages = [];
    chatBacklog = true;
    // A draft belongs to the conversation it was written in. Carrying it into the
    // next room would post one person's unfinished thought to somebody else.
    chatDraft = '';
    chatPick = null;
  }
  chatLog = null;

  let data;
  try {
    data = await api(`/api/chats/${convId}?limit=60`);
  } catch (err) {
    $view.replaceChildren(h('div', { class: 'notice' }, icon('alert'), h('span', { text: err.message || 'чат недоступен' })));
    return;
  }
  if (chatRoom?.id !== convId) return;

  chatRoom.chat = data.chat;
  // History arrives newest first and is drawn bottom-up, so it is reversed once
  // here instead of the client sorting on every render.
  chatMessages = (data.messages || []).slice().reverse();
  chatBacklog = !!data.hasMore;
  chatClearMissed();
  // The paging cursor is the oldest message on screen, and it is what the next
  // "earlier" request walks back from.
  chatOlder = chatMessages[0]?.id || null;

  chatRender();
  chatMarkRead(convId);
  if (!keepSocket) chatConnect(convId);
}

/** Clears the unread badge the moment a room is actually read. */
async function chatMarkRead(convId) {
  try {
    await api(`/api/chats/${convId}/read`, { method: 'POST' });
    const row = document.querySelector(`[data-chat="${convId}"]`);
    row?.classList.remove('is-unread');
    row?.querySelector('.chat-badge')?.remove();
  } catch { /* the badge is cosmetic; it is corrected on the next list load */ }
}

/** Pulls the previous page of history, for the button above the log. */
async function chatOlderPage() {
  if (!chatBacklog || !chatOlder || !chatRoom) return;
  try {
    const data = await api(`/api/chats/${chatRoom.id}?limit=40&before=${encodeURIComponent(chatOlder)}`);
    const page = (data.messages || []).slice().reverse();
    if (!page.length) { chatBacklog = false; chatRender(); return; }
    chatOlder = page[0].id;
    chatMessages = page.concat(chatMessages);
    chatRender();
  } catch {
    chatBacklog = false;
    chatRender();
  }
}

/**
 * Adds one message to the open room and repaints.
 *
 * The same row arrives from two directions - the answer to the sender's own post
 * and the frame the Durable Object fans out - so every row is checked by id
 * before it is added. Without that, sending a message paints it twice.
 *
 * `convId` is the room the row belongs to, and it is not assumed to be the open
 * one. A post takes a round trip, and the reader may well have opened a different
 * conversation in the time it took; painting their message into that one would
 * show a person words they never wrote in a room they never spoke in.
 */
function chatAdd(msg, convId = chatRoom?.id) {
  if (!msg || !msg.id || !convId) return;
  if (!chatRoom || chatRoom.id !== convId) return;
  if (chatMessages.some((x) => x.id === msg.id)) return;
  chatMessages.push(msg);
  chatMessages.sort((a, b) => a.createdAt - b.createdAt);
  // New rows land at the bottom, so the view stays where it is: a reader who has
  // scrolled up into history is not yanked back down by someone talking.
  const atBottom = !chatLog
    || chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60;
  // Read up the screen: remember where the unread part starts so the log can mark
  // it, and how much of it there is so the reader can be told without scrolling.
  // The reader's own messages do not count - they were not told anything.
  if (!atBottom && msg.userId !== account?.id) {
    chatMissed += 1;
    if (!chatUnreadFrom) chatUnreadFrom = msg.id;
  }
  chatRender('keep');
  if (atBottom && chatLog) chatLog.scrollTop = chatLog.scrollHeight;
}

/**
 * Sends one message, and the file that goes with it if there is one.
 *
 * The two are separate requests because the message has to exist before a file
 * can hang off it. That means a file on its own is a message with no words, and
 * an upload that fails has left an empty row behind - so the row is taken back
 * down here rather than left in the room as a bubble with nothing in it. The
 * retraction only touches a message this send created, and only while it is
 * still empty.
 */
async function chatSend(text, file = null) {
  const convId = chatRoom?.id;
  const body = String(text || '').slice(0, 2000);
  if (!convId || (!body.trim() && !file)) return false;
  let saved;
  try {
    saved = await api(`/api/chats/${convId}/messages`, {
      method: 'POST',
      // `attach` is what tells the server an empty body is deliberate and a file
      // is coming, rather than a mistake worth refusing.
      body: { body, attach: !!file },
    });
    // Painted from the answer, not waited for on the socket. The fan-out is best
    // effort by design - the Durable Object can be asleep, upgrading or restarting
    // - and the message is already stored either way. Painting only on the frame
    // would let a dropped push swallow a message the server accepted, and the
    // sender would watch their words vanish from their own room.
    //
    // `chatAdd` ignores a row for a room that is no longer open, and a message the
    // sender left the room while it was in flight belongs to that old room.
    if (saved?.message) chatAdd(saved.message, convId);
  } catch (err) {
    toast(err.message || 'не отправлено', true);
    return false;
  }

  if (!file || !saved?.message) return true;
  try {
    const up = await api(`/api/chats/${convId}/messages/${saved.message.id}/files`, {
      method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name) },
    });
    chatAttachFile(saved.message.id, up.file, convId);
  } catch (err) {
    // The message is already stored, so the send counts; the file did not make
    // it and the sender is told, rather than being left to wonder.
    toast(err.message || 'файл не загрузился', true);
    if (!body.trim()) await chatRetract(saved.message.id, convId);
    return !!body.trim();
  }
  return true;
}

/** Hangs an uploaded file on a message that is already drawn. */
function chatAttachFile(messageId, file, convId = chatRoom?.id) {
  if (!chatRoom) return;
  chatMessages = chatMessages.map((m) => (
    m.id === messageId ? { ...m, files: [...(m.files || []), file] } : m
  ));
  chatRender('keep');
}

/**
 * Takes down a message this tab just sent, for a send that did not finish.
 *
 * The room is named rather than read from the open tab, for the same reason as
 * above: an upload can fail after the reader has moved on, and a retraction sent
 * to whatever room happens to be open would delete the wrong thing or nothing.
 */
async function chatRetract(messageId, convId = chatRoom?.id) {
  if (!convId) return;
  try {
    await api(`/api/chats/${convId}/messages/${messageId}`, { method: 'DELETE' });
    if (!chatRoom) return;
    chatMessages = chatMessages.filter((m) => m.id !== messageId);
    chatRender('keep');
  } catch { /* the empty row stays; history is authoritative and it is visible */ }
}

/** One message line. The body is a text node, never markup. */
function chatBubble(m, grouped = false) {
  const mine = account && m.userId === account.id;
  const when_ = m.createdAt ? ago(m.createdAt) : '';
  // A run of messages from one person names them once. Repeating the name above
  // every line of a paragraph they are typing turns the log into a list of forms.
  const stamp = m.createdAt
    ? h('time', { class: 'chat-time', text: when_, title: new Date(m.createdAt).toLocaleString('ru-RU') })
    : null;
  return h('div', { class: `chat-msg${mine ? ' is-mine' : ''}${grouped ? ' is-grouped' : ''}` },
    h('div', { class: 'chat-msg-head' },
      grouped ? null : h('span', { class: 'chat-nick', text: m.nick || '—' }),
      stamp,
      // The author can always retract; a moderator can too. The flag comes from
      // the server, and the server re-checks it - a hidden button is not the
      // control, it is only the affordance.
      (mine || chatRoom?.chat?.rights?.canManage) && !m.deleted
        ? h('button', {
          class: 'chat-del', type: 'button', title: 'Удалить', 'aria-label': 'Удалить сообщение',
          onClick: async () => {
            try {
              await api(`/api/chats/${chatRoom.id}/messages/${m.id}`, { method: 'DELETE' });
              chatMessages = chatMessages.map((x) => (x.id === m.id ? { ...x, deleted: true, body: '' } : x));
              chatRender();
            } catch (err) { toast(err.message || 'не удалено', true); }
          },
        }, icon('trash', 'i i-sm'))
        : null,
    ),
    m.deleted
      ? h('p', { class: 'chat-body is-deleted', text: 'сообщение удалено' })
      : h('p', { class: 'chat-body', text: m.body || '' }),
    m.game ? h('a', { class: 'chat-game', href: `/games/${m.game.id}` },
      m.game.cover ? h('img', { class: 'chat-game-cover', src: m.game.cover, alt: '', loading: 'lazy' }) : null,
      h('span', { text: m.game.name || `Игра ${m.game.id}` }),
    ) : null,
    (m.files || []).length ? h('div', { class: 'chat-files' },
      ...m.files.map((f) => h('a', {
        class: 'chat-file', href: f.url, target: '_blank', rel: 'noopener',
      }, icon('file', 'i i-sm'), h('span', { text: `${f.name} · ${bytes(f.size)}` }))),
    ) : null,
  );
}

/**
 * The message bubbles, plus the lines a reader needs to navigate them: a date
 * whenever the day turns over, and a marker at the first message they missed.
 *
 * These are drawn here rather than inside the log so the ordering rules stay in
 * one place. Grouping is decided by `sameRun`, which looks at the message before
 * the one being drawn - so a re-render or an older page arriving keeps the same
 * answer without any state to carry.
 */
function chatRows() {
  const out = [];
  let prev = null;
  let prevDay = null;
  for (const m of chatMessages) {
    const day = dayKey(m.createdAt);
    if (day !== prevDay) {
      out.push(h('div', { class: 'chat-day', text: dayLabel(m.createdAt) }));
      prevDay = day;
      prev = null;
    }
    if (m.id === chatUnreadFrom) {
      out.push(h('div', { class: 'chat-new' }, h('span', { text: 'Непрочитанные' })));
    }
    out.push(chatBubble(m, sameRun(prev, m)));
    prev = m;
  }
  return out;
}

/**
 * Posts whatever is in the composer and clears it.
 *
 * Enter and the send button both land here, so the two can never disagree about
 * what counts as a send. `roomId` is checked after the round trip because the
 * reader is allowed to leave mid-send, and restoring a draft into a conversation
 * they are no longer reading would be worse than losing it.
 */
async function sendComposer(roomId) {
  // The field is read rather than the draft, because it is the one thing the
  // browser has actually been given: autofill and paste can fill it without an
  // input event ever firing, and the words that end up posted should be the words
  // in the box the reader is looking at.
  const text = chatField ? chatField.value : chatDraft;
  const file = chatPick;
  // Cleared straight away so a slow send does not feel stuck, and put back if the
  // words really did not go anywhere. The file goes back with them: it is the
  // same send that failed.
  //
  // The state is what gets restored, not the field. This node is about to be
  // thrown away by the render below, so writing to it would restore nothing.
  chatDraft = '';
  chatPick = null;
  chatRender('keep');
  if (!(await chatSend(text, file)) && chatRoom?.id === roomId) {
    chatDraft = text;
    chatPick = file;
    chatRender('keep');
    chatField?.focus?.();
  }
}

/**
 * Grows the composer with its content, up to a point.
 *
 * An unbounded textarea pushes the send button off the screen on a long message,
 * which is the moment the reader most needs to see it.
 */
function chatAutoGrow(el) {
  if (!el || !el.style) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight || 0, 160)}px`;
}

/**
 * Draws the open room.
 *
 * The whole log is replaced rather than patched. That is affordable because the
 * page is capped at a few hundred rows and it removes a whole class of bug where
 * a re-render leaves a node that was deleted, or duplicates a row that is still
 * in the list. The scroll position is restored afterwards, so a re-render while
 * reading history does not throw the reader back to the newest message.
 */
function chatRender(scroll = 'bottom') {
  if (!chatRoom?.chat) return;
  const chat = chatRoom.chat;

  // Remembered before the nodes are rebuilt: after the swap the old log is gone,
  // so its geometry has to be taken first.
  const prev = chatLog;
  const prevTop = prev ? prev.scrollTop : 0;
  const prevHeight = prev ? prev.scrollHeight : 0;
  const keepTop = scroll === 'keep' && prev;

  const list = h('div', { class: 'chat-msgs' },
    chatBacklog
      ? h('button', { class: 'chat-more', type: 'button', onClick: chatOlderPage }, 'Показать ранние')
      : null,
    ...chatRows(),
  );

  chatField = h('textarea', {
    id: 'chat-input', class: 'chat-input chat-field', rows: '1', autocomplete: 'off',
    placeholder: chat.rights?.canPost ? 'Сообщение…' : 'Только чтение',
    disabled: !chat.rights?.canPost, maxlength: '2000',
    value: chatDraft,
    oninput: (e) => { chatDraft = e.target.value; chatAutoGrow(e.target); },
    // Enter sends because a one-line box is what a conversation mostly is;
    // Shift+Enter is the way out for the times it is not. Without this the
    // textarea would swallow the send entirely.
    onkeydown: (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      sendComposer(chat.id);
    },
  });
  // A picture on its own is a message with no words, so the picker sits next to
  // the field rather than behind a menu. The file input is invisible and the
  // label is the button, which is what a keyboard and a screen reader get for
  // free - a bare icon would be an unlabelled control.
  const picker = chat.rights?.canPost
    ? h('label', { class: 'chat-attach' },
      icon('file', 'i i-sm'),
      h('span', { class: 'sr-only', text: 'Прикрепить файл' }),
      h('input', {
        type: 'file', class: 'sr-only', tabindex: '-1',
        onchange: async (e) => {
          const picked = [...(e.target?.files || [])][0];
          e.target.value = '';
          if (!picked) return;
          // Shrunk on the way in, for the same reason the editor shrinks: the
          // limit is on the stored file, not on what the camera wrote.
          const shrunk = await downscaleImage(picked);
          if (chatRoom?.id !== chat.id) return;
          chatPick = shrunk.file;
          chatRender('keep');
        },
      }),
    )
    : null;
  const composer = h('form', {
    class: 'chat-composer',
    onSubmit: (e) => { e.preventDefault(); sendComposer(chat.id); },
  },
    chatPick ? h('div', { class: 'chat-pending' },
      icon('file', 'i i-sm'),
      h('span', { text: chatPick.name }),
      h('button', {
        class: 'chat-del', type: 'button', title: 'Убрать файл', 'aria-label': 'Убрать файл',
        onClick: () => { chatPick = null; chatRender('keep'); },
      }, icon('trash', 'i i-sm')),
    ) : null,
    h('div', { class: 'chat-compose-row' }, picker, chatField),
    h('button', { class: 'btn btn-sm', type: 'submit', disabled: !chat.rights?.canPost }, 'Отправить'),
  );

  // A public channel can be read without joining it, and a reader who cannot post
  // gets the join button instead of a disabled composer with no explanation.
  const join = !chat.rights?.canPost && chat.discoverable && !chat.role
    ? h('button', {
      class: 'btn btn-sm', type: 'button',
      onClick: async (e) => {
        e.target.disabled = true;
        try {
          await api(`/api/chats/${chat.id}/members`, { method: 'POST', body: { userId: account.id } });
          await chatOpen(chat.id, { keepSocket: true });
        } catch (err) { toast(err.message || 'не удалось вступить', true); }
      },
    }, 'Вступить')
    : null;

  chatLog = h('div', { class: 'chat-log', id: 'chat-log' }, list);

  const kindLabel = chat.kind === 'channel' ? 'Канал' : chat.kind === 'group' ? 'Группа' : 'Личный чат';
  // The reader cannot tell a dropped socket from a quiet room, and the two ask
  // for opposite behaviour: one wants a reconnect, the other nothing at all.
  const live = h('span', { class: `chat-live${chatRoom.live ? ' is-on' : ''}` },
    h('i', { class: 'dot' }),
    h('span', { text: chatRoom.live ? 'в сети' : 'переподключение' }),
  );

  $view.replaceChildren(
    h('div', { class: 'page-head chat-top' },
      h('div', { class: 'chat-title' },
        h('h1', { text: chat.title || 'Чат' }),
        h('p', { class: 'page-sub' },
          h('span', { text: `${kindLabel} · участников: ${chat.members ?? '—'}` }),
          live,
        ),
      ),
      h('a', { class: 'btn btn-sm btn-ghost', href: '/chat' }, 'К списку'),
    ),
    h('div', { class: 'chat-wrap' },
      // Floated over the log rather than below it: the point is to be reachable
      // from wherever the reader has scrolled to, and a bar pinned to the bottom
      // of the screen would be exactly where they are not looking.
      chatMissed
        ? h('button', {
          class: 'chat-jump', type: 'button',
          onClick: () => {
            chatClearMissed();
            chatRender('bottom');
            chatField?.focus?.();
          },
        }, chatMissed === 1 ? '1 новое' : `${chatMissed} новых`)
        : null,
      chatLog,
      join ? h('div', { class: 'chat-join' }, join) : composer,
    ),
  );

  // Set after the nodes are in the document: until then there is no height to
  // scroll to, and "bottom" would land in the middle of the first page.
  if (keepTop) {
    // An older page was prepended, so the message that was on screen has to stay
    // on screen - which means shifting down by however much was added above.
    chatLog.scrollTop = prevTop + (chatLog.scrollHeight - prevHeight);
  } else if (scroll === 'top') {
    chatLog.scrollTop = 0;
  } else {
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

/** Sidebar of rooms plus the ways to start a new one. */
function chatListView(data, banner) {
  const rows = (data.chats || []).map((c) => h('a', {
    class: `chat-row${c.unread ? ' is-unread' : ''}`,
    href: `/chat/${c.id}`,
    dataset: { chat: c.id },
  },
    h('span', { class: 'chat-row-main' },
      h('span', { class: 'chat-row-title', text: c.title || 'Личный чат' }),
      h('span', { class: 'chat-row-sub', text: c.lastAt ? ago(c.lastAt) : 'нет сообщений' }),
    ),
    c.unread ? h('span', { class: 'chat-badge', text: String(c.unread) }) : null,
  ));

  let kindField = null;
  let titleField = null;
  const create = h('form', {
    class: 'chat-create',
    onSubmit: async (e) => {
      e.preventDefault();
      const title = titleField.value.trim();
      if (!title) return;
      try {
        const made = await api('/api/chats', { method: 'POST', body: { kind: kindField.value, title } });
        navigate(`/chat/${made.chat.id}`);
      } catch (err) { toast(err.message || 'не создано', true); }
    },
  },
    kindField = h('select', { class: 'chat-kind' },
      h('option', { value: 'channel', text: 'Канал — читают все' }),
      h('option', { value: 'group', text: 'Группа — по приглашению' }),
    ),
    titleField = h('input', { class: 'chat-input', type: 'text', placeholder: 'Название', maxlength: '80' }),
    h('button', { class: 'btn btn-sm', type: 'submit' }, 'Создать'),
  );

  // A direct message needs a person, not a name, so it is started from the two
  // lists of people below rather than from a title field.
  //
  // The field takes either an id or a nick, because both are things a person has.
  // An id goes straight through; a nick is resolved first, and an ambiguous one is
  // asked about rather than guessed at - picking the most popular stranger and
  // opening a conversation with them is not an acceptable guess.
  let dmField = null;
  const dmHits = h('div', { class: 'chat-hits' });
  const openDm = async (userId) => {
    try {
      const made = await api(`/api/chats/dm/${encodeURIComponent(userId)}`, { method: 'POST' });
      navigate(`/chat/${made.chat.id}`);
      return true;
    } catch (err) {
      // "no such account" is not a final answer to something that may equally be a
      // name, so it is handed back to the caller to try the other reading. Every
      // other refusal - blocked, not followed, throttled - is a real answer, and
      // is reported as one instead of being retried as if it were a typo.
      if (err?.message && err.message !== 'no such account') toast(err.message, true);
      return false;
    }
  };
  const dm = h('form', {
    class: 'chat-create',
    onSubmit: async (e) => {
      e.preventDefault();
      const typed = dmField.value.trim().replace(/^@/, '');
      if (!typed) return;
      dmHits.replaceChildren();
      // Most nicks are spelled like ids, so the id is tried first and the name
      // second. Only a miss at both ends is a miss.
      if (/^[A-Za-z0-9_-]{3,40}$/.test(typed) && await openDm(typed)) return;
      try {
        const found = await api(`/api/users?q=${encodeURIComponent(typed)}`);
        const people = found.users || [];
        if (people.length === 1) { await openDm(people[0].id); return; }
        if (!people.length) { toast('ник не найден', true); return; }
        dmHits.replaceChildren(...people.map((u) => h('button', {
          class: 'chat-chip', type: 'button', onClick: () => openDm(u.id),
        }, u.nick, u.id === account?.id ? h('span', { class: 'chat-chip-self', text: 'это вы' }) : null)));
      } catch (err) { toast(err.message || 'не найти', true); }
    },
  },
    dmField = h('input', { class: 'chat-input', type: 'text', placeholder: 'Имя или @id для личного чата', maxlength: '40' }),
    h('button', { class: 'btn btn-sm', type: 'submit' }, 'Написать'),
  );
  const dmBlock = h('div', {}, dm, dmHits);

  const channels = h('details', { class: 'chat-discover' },
    h('summary', { text: 'Публичные каналы' }),
    h('div', { class: 'chat-discover-list' },
      ...(data.channels || []).map((c) => h('a', { class: 'chat-chip', href: `/chat/${c.id}` }, `# ${c.title}`)),
    ),
  );

  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: 'Чат' }), h('p', { class: 'page-sub', text: 'Каналы, группы и личные переписки.' })),
    ),
    banner || null,
    create,
    dmBlock,
    channels,
    rows.length
      ? h('div', { class: 'chat-list' }, ...rows)
      : h('p', { class: 'hint', text: 'У вас пока нет диалогов. Создайте канал или группу выше.' }),
  );
}

async function viewChat(url) {
  // A signed-out reader is offered the sign-in page rather than an error, since
  // a chat needs an account for the same reason posting does.
  if (!account) {
    $view.replaceChildren(
      h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Чат' }))),
      h('p', { class: 'hint', text: 'Войдите, чтобы читать и писать в чатах.' }),
      h('a', { class: 'btn', href: '/auth' }, 'Войти'),
    );
    return;
  }

  // The room id is taken from the base-stripped path, never from the raw URL.
  // Every other view here works on the path `route()` already cleaned: on a
  // static host the site lives under a subdirectory, so the raw pathname is
  // `/cheatlab/chat/<id>` and slicing a fixed `/chat/` prefix off it yields
  // `e.../<id>` - a request for a room that does not exist, and an empty view.
  const convId = stripBase(url.pathname).slice('/chat/'.length).replace(/\/$/, '');
  if (convId) { await chatOpen(convId); return; }

  // The room list and the public channel list are fetched together: the second is
  // what lets somebody find a room to join, and a sidebar that only lists what you
  // are already in is a dead end for a first visit.
  const [mine, publicRooms] = await Promise.all([
    api('/api/chats').catch(() => ({ chats: [] })),
    api('/api/chats/channels').catch(() => ({ channels: [] })),
  ]);
  chatListView({ chats: mine.chats || [], channels: publicRooms.channels || [] }, null);
}

/* ----------------------------------------------------------------- admin --
 * The console is one page with four queues rather than a nested set of admin
 * screens: a moderator's whole job is "look at the open reports, look at the
 * newest posts, act", and every extra level of navigation is a level between
 * reading a complaint and answering it.
 *
 * Nothing here is a permission. The role is read from /api/admin/overview, and
 * every action is re-checked server-side, so a stale page or a hand-typed URL
 * gets the same answer as a hidden button.
 */

const ADMIN_TABS = [
  ['reports', 'flag', 'Жалобы'],
  ['items', 'doc', 'Публикации'],
  ['users', 'user', 'Аккаунты'],
  ['nicks', 'ban', 'Ники'],
];

const BAN_PRESETS = [
  [1, 'час'], [24, 'сутки'], [72, '3 дня'], [168, 'неделя'], [720, 'месяц'],
];

function adminAction(label, cls, run) {
  const btn = h('button', { class: `btn btn-sm ${cls || 'btn-ghost'}`, type: 'button' }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await run();
    } catch (err) {
      toast(err.message || 'не получилось', true);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

async function viewAdmin(tab = 'reports') {
  if (!signedIn()) { navigate('/auth'); return; }

  let overview;
  try {
    overview = await api('/api/admin/overview');
  } catch (err) {
    $view.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', { text: 'Модерация' })),
      h('div', { class: 'notice' }, icon('ban', 'i i-sm'), h('span', { text: err.message })),
      h('p', { class: 'hint', style: 'margin-top:16px', text: 'Страница доступна администраторам и модераторам.' }),
    );
    return;
  }

  const isAdmin = overview.role === 'admin';
  const open = overview.reports?.length || 0;
  const body = h('div', {});

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ADMIN_TABS.map(([key, ic, label]) => h('button', {
    class: 'tab', type: 'button', role: 'tab', 'aria-selected': key === tab,
    onclick: () => { navigate(`/admin/${key}`); },
  }, icon(ic, 'i i-sm'), label, key === 'reports' && open ? h('span', { class: 'pill', text: String(open) }) : null)));

  const paint = async () => {
    if (tab === 'reports') await paintReports(body, isAdmin, paint);
    else if (tab === 'items') await paintItems(body, paint);
    else if (tab === 'users') await paintUsers(body, isAdmin, paint);
    else await paintNicks(body, isAdmin, paint);
  };

  $view.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, icon('shield', 'i i-sm'), ' Модерация'),
        h('p', {
          class: 'page-sub',
          text: isAdmin
            ? 'Полный доступ: роли, блок ников, снятие банов и баны без ограничения по сроку.'
            : 'Модератор: удаление публикаций, бан до 7 дней, жалобы и отметка популярного автора.',
        }),
      ),
    ),
    tabs,
    body,
  );
  await paint();
}

/** The report queue. A resolved report stays in the log, which is the point. */
async function paintReports(body, isAdmin, refresh) {
  const { reports } = await api('/api/admin/reports');
  if (!reports.length) {
    body.replaceChildren(h('div', { class: 'panel' }, h('p', { class: 'empty', text: 'Жалоб нет.' })));
    return;
  }
  const TARGET = { item: 'публикацию', user: 'аккаунт', comment: 'комментарий' };
  const resolve = (report, status) => adminAction(
    status === 'resolved' ? 'Снять' : 'Отклонить',
    status === 'resolved' ? 'btn-primary' : 'btn-ghost',
    async () => {
      // The Worker reports what it actually removed, and the wording follows it:
      // a complaint about an account is closed here but the account is dealt
      // with separately, and telling the operator it was "taken down" when
      // nothing was would be the kind of small lie that erodes trust in a queue.
      const res = await api(`/api/admin/reports/${report.id}`, { method: 'POST', body: { status } });
      if (status === 'dismissed') toast('Жалоба отклонена');
      else if (res && res.removed) toast('Публикация снята по жалобе');
      else toast('Жалоба закрыта. Аккаунт разберите в разделе «Аккаунты»');
      await refresh();
    },
  );
  body.replaceChildren(h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('flag', 'i i-sm'), ` Жалобы (${reports.length})`),
    h('div', { class: 'rows' }, reports.map((r) => h('div', { class: 'queue-row' },
      h('div', {},
        h('div', {},
          h('strong', { text: REASON_LABEL[r.reason] || r.reason }),
          h('span', { class: 'hint', text: ` · на ${TARGET[r.targetType] || r.targetType} ` }),
          r.targetType === 'item' ? h('a', { href: `/i/${r.targetId}`, text: r.targetId }) : null,
        ),
        r.details ? h('p', { class: 'page-sub', text: r.details }) : null,
         h('p', { class: 'hint', text: `${ago(r.createdAt)}${r.byUserId ? '' : ' · без аккаунта'}` }),
      ),
      h('span', { class: 'spacer' }),
      h('span', { class: 'pill pill-mute', text: r.status }),
      r.status === 'open' ? resolve(r, 'dismissed') : null,
      // Only content can be taken down from here. An account is not deleted
      // because of a complaint, so a user target gets no takedown button - the
      // account queue is where a ban is set, with a term and a reason.
      r.status === 'open' && (r.targetType === 'item' || r.targetType === 'comment') ? resolve(r, 'resolved') : null,
    ))),
  ));
}

/** Newest posts across every author, which is where spam shows up first. */
async function paintItems(body, refresh) {
  const { items } = await api('/api/admin/items?limit=50');
  if (!items.length) {
    body.replaceChildren(h('div', { class: 'panel' }, h('p', { class: 'empty', text: 'Публикаций нет.' })));
    return;
  }
  body.replaceChildren(h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('doc', 'i i-sm'), ' Последние публикации'),
    h('div', { class: 'rows' }, items.map((it) => h('div', { class: 'queue-row' },
      h('a', { href: `/i/${it.id}` }, h('strong', { text: it.title })),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hint', text: `${it.authorLabel || it.author} · ${ago(it.createdAt)}` }),
      adminAction('Снять', 'btn-ghost', async () => {
        if (!confirm(`Снять публикацию «${it.title}»? Действие необратимо.`)) return;
        await api(`/api/admin/items/${it.id}`, { method: 'DELETE' });
        toast('Публикация снята');
        await refresh();
      }),
    ))),
  ));
}

/** Account search, ban, popular mark and - for an admin only - the role. */
async function paintUsers(body, isAdmin, refresh) {
  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'ник или ID аккаунта',
    autocomplete: 'off', spellcheck: false,
  });
  const results = h('div', { class: 'rows' });

  const run = async () => {
    // `value` is read defensively: an input with nothing typed in is an empty
    // string in a browser, but the moderation console must not be the one view
    // that breaks on a null there.
    const { users } = await api(`/api/admin/users?q=${encodeURIComponent((search.value || '').trim())}`);
    results.replaceChildren(...(users.length
      ? users.map((u) => h('div', { class: 'queue-row' },
        avatarFor(u, 32),
        h('div', {},
          h('div', {},
            h('a', { href: `/u/${u.id}` }, h('strong', { text: u.nick })),
            u.admin ? h('span', { class: 'admin-badge admin-badge-sm', title: 'Администратор' }, icon('star', 'i i-sm')) : null,
            u.popular ? h('span', { class: 'popular-badge popular-badge-sm', title: 'Популярный автор' }, icon('star', 'i i-sm')) : null,
            u.role === 'moderator' ? h('span', { class: 'pill', text: 'модератор' }) : null,
            u.banned ? h('span', { class: 'pill pill-danger', text: 'забанен' }) : null,
          ),
          h('p', { class: 'hint', text: `${u.id} · ${u.posts ?? 0} публикаций · ${u.followers ?? 0} подписчиков` }),
        ),
        h('span', { class: 'spacer' }),
        adminAction('Популярный', 'btn-ghost', async () => {
          await api(`/api/admin/users/${u.id}/popular`, { method: 'POST', body: { popular: !u.popular } });
          await refresh();
        }),
        banButton(u, isAdmin, refresh),
        isAdmin ? adminAction(u.role === 'moderator' ? 'Снять модератора' : 'Сделать модератором', 'btn-ghost', async () => {
          await api(`/api/admin/users/${u.id}/role`, {
            method: 'POST', body: { role: u.role === 'moderator' ? 'user' : 'moderator' },
          });
          toast('Роль обновлена');
          await refresh();
        }) : null,
      ))
      : [h('p', { class: 'empty', text: 'Никого не нашлось.' })]));
  };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });

  body.replaceChildren(h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('user', 'i i-sm'), ' Поиск аккаунта'),
    h('div', { class: 'field-row' }, search, h('button', { class: 'btn btn-primary', type: 'button', onclick: run }, 'Найти')),
    results,
  ));
  await run();
}

/** A ban form as a prompt, because the presets are the point and free text is not. */
function banButton(u, isAdmin, refresh) {
  return adminAction('Забанить', 'btn-ghost', async () => {
    const presets = isAdmin
      ? [...BAN_PRESETS, [24 * 365, 'год'], [0, 'до снятия']]
      : BAN_PRESETS;
    const choice = prompt(`Срок бана для @${u.nick}:\n${presets.map(([v, l], i) => `${i + 1} — ${l}`).join('\n')}\n\nНомер срока, либо часы числом.`);
    if (choice === null) return;
    const pick = Number(choice.trim());
    const found = presets.find(([v]) => v === pick);
    const hours = found ? found[0] : Number.isFinite(pick) ? pick : 24;
    const reason = prompt('Причина (видна автору при попытке публикации):', 'нарушение правил') || '';
    await api(`/api/admin/users/${u.id}/ban`, { method: 'POST', body: { hours, reason } });
    toast(`@${u.nick} забанен`);
    await refresh();
  });
}

/** The blocked-nick list. Admin only: a moderator cannot act on it. */
async function paintNicks(body, isAdmin, refresh) {
  if (!isAdmin) {
    body.replaceChildren(h('div', { class: 'panel' },
      h('p', { class: 'empty', text: 'Блок ников доступен только администратору.' })));
    return;
  }
  const nick = h('input', { class: 'input', placeholder: 'ник', maxlength: 24, autocomplete: 'off', spellcheck: false });
  const reason = h('input', { class: 'input', placeholder: 'причина', maxlength: 200 });
  const { blocked } = await api('/api/admin/nicks');

  body.replaceChildren(h('div', { class: 'panel' },
    h('div', { class: 'panel-title' }, icon('ban', 'i i-sm'), ' Заблокированные ники'),
    h('div', { class: 'field-row' },
      nick, reason,
      h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api('/api/admin/nicks', { method: 'POST', body: { nick: nick.value.trim(), reason: reason.value.trim() } });
            toast('Ник заблокирован');
            await refresh();
          } catch (err) {
            toast(err.message, true);
            e.currentTarget.disabled = false;
          }
        },
      }, 'Заблокировать'),
    ),
    blocked.length
      ? h('div', { class: 'rows' }, blocked.map((b) => h('div', { class: 'queue-row' },
          h('div', {},
            h('strong', { text: b.nick }),
            h('p', { class: 'hint', text: b.reason || 'без причины' }),
          ),
          h('span', { class: 'spacer' }),
          adminAction('Разблокировать', 'btn-ghost', async () => {
            await api(`/api/admin/nicks/${encodeURIComponent(b.nick_key)}`, { method: 'DELETE' });
            toast('Ник разблокирован');
            await refresh();
          }),
        )))
      : h('p', { class: 'empty', text: 'Список пуст.' }),
  ));
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
    } else if (GAME_PAGE.test(path)) {
      await viewGame(path.slice('/games/'.length));
    } else if (path === '/new') {
      await viewNew(url);
    } else if (path === '/me') {
      await viewMe();
    } else if (path === '/chat' || path.startsWith('/chat/')) {
      await viewChat(url);
    } else if (path === '/stats') {
      await viewStats();
    } else if (path === '/auth') {
      await viewAuth(url);
    } else if (path === '/admin' || path.startsWith('/admin/')) {
      const tab = path.slice('/admin'.length).replace(/^\//, '') || 'reports';
      await viewAdmin(['reports', 'items', 'users', 'nicks'].includes(tab) ? tab : 'reports');
    } else if (path === '/rules') {
      viewRules();
    } else if (path === '/terms') {
      viewTerms();
    } else if (path === '/privacy') {
      viewPrivacy();
    } else if (path === '/report') {
      await viewReport();
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
