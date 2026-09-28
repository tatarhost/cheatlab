const KEY_STORE = 'cheatlab.keys';
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

function clientId() {
  let id = localStorage.getItem(ID_STORE);
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    const bytesRaw = crypto.getRandomValues(new Uint8Array(24));
    id = btoa(String.fromCharCode(...bytesRaw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem(ID_STORE, id);
  }
  return id;
}
const CLIENT = clientId();

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

const fileUrl = (id) => `${API}/f/${id}`;
const rawFileUrl = (id) => `${API}/f/${id}/raw`;
const mediaUrl = (id) => `${API}/m/${id}`;
const textUrl = (id) => `${API}/r/${id}`;
const isImageFile = (f) => /^image\//.test(f.mime || '');
const isVideoFile = (f) => /^video\//.test(f.mime || '');
const isAudioFile = (f) => /^audio\//.test(f.mime || '');

async function api(path, { method = 'GET', body, secret, signal } = {}) {
  const headers = { 'x-cheatlab-client': CLIENT };
  if (secret) headers['x-cheatlab-secret'] = secret;
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
    throw err;
  }
  return data;
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

function typeRow(item) {
  const meta = h('div', { class: 'row-meta' },
    h('span', {}, icon('user', 'i i-sm'), item.author),
    h('span', {}, icon('eye', 'i i-sm'), String(item.hits)),
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

  // first image gets a thumbnail so media feeds are browsable as a gallery
  const thumb = item.files.find((f) => isImageFile(f) && f.size);

  return h('a', { class: 'row', href: `/i/${item.id}` },
    thumb
      ? h('span', { class: 'row-thumb' }, h('img', { src: mediaUrl(thumb.id), alt: '', loading: 'lazy', decoding: 'async' }))
      : h('span', { class: 'row-mark' }, icon(TYPE_ICON[item.type] || 'clip', 'i i-sm')),
    h('span', {},
      h('span', { class: 'row-title', text: item.title }),
      meta,
      tags,
    ),
    h('span', { class: 'row-right' },
      item.visibility === 'unlisted' ? icon('lock', 'i i-sm') : null,
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
      q || tag ? 'Попробуй другой запрос или сними фильтр.' : 'Опубликуй первым — регистрация не нужна.',
      '/new', 'Опубликовать',
    ));
    return;
  }
  for (const item of items) list.append(typeRow(item));
  $view.append(list, h('p', { class: 'hint', style: 'margin-top:16px', text: `${total} всего` }));
}

async function viewItem(id) {
  const { item } = await api(`/api/items/${id}`);
  const secret = keyFor(id);

  /**
   * Media previews. Rendered above the file table so an image or video post
   * reads as media at a glance instead of as a download link. Video relies on
   * the API's byte-range support, and `preload="metadata"` keeps large clips
   * from being fetched in full.
   */
  const mediaFiles = item.files.filter((f) => isImageFile(f) || isVideoFile(f) || isAudioFile(f));
  const media = mediaFiles.length
    ? h('div', { class: 'media' }, mediaFiles.map((f) => {
        if (isImageFile(f)) {
          return h('figure', { class: 'media-item' },
            h('img', {
              class: 'media-img',
              src: mediaUrl(f.id),
              alt: f.name,
              loading: 'lazy',
              decoding: 'async',
            }),
            h('figcaption', {},
              h('a', { href: mediaUrl(f.id), target: '_blank', rel: 'noopener', text: f.name }),
              h('span', { class: 'spacer' }),
              h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.id) }, icon('download', 'i i-sm'), 'Скачать'),
            ),
          );
        }
        if (isVideoFile(f)) {
          return h('figure', { class: 'media-item' },
            h('video', {
              class: 'media-video',
              src: mediaUrl(f.id),
              controls: true,
              preload: 'metadata',
              playsinline: true,
            }),
            h('figcaption', {},
              h('a', { href: mediaUrl(f.id), target: '_blank', rel: 'noopener', text: f.name }),
              h('span', { class: 'spacer' }),
              h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.id) }, icon('download', 'i i-sm'), 'Скачать'),
            ),
          );
        }
        return h('figure', { class: 'media-item' },
          h('audio', { class: 'media-audio', src: mediaUrl(f.id), controls: true, preload: 'metadata' }),
          h('figcaption', {},
            h('a', { href: mediaUrl(f.id), target: '_blank', rel: 'noopener', text: f.name }),
            h('span', { class: 'spacer' }),
            h('a', { class: 'btn btn-sm btn-ghost', href: fileUrl(f.id) }, icon('download', 'i i-sm'), 'Скачать'),
          ),
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
            h('a', { class: 'btn btn-sm', href: fileUrl(f.id) }, icon('download', 'i i-sm'), 'Скачать'),
            ' ',
            h('a', { class: 'btn btn-sm btn-ghost', href: rawFileUrl(f.id), target: '_blank', rel: 'noopener' }, icon('eye', 'i i-sm'), 'Открыть'),
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
          h('a', { class: 'btn btn-sm btn-ghost', href: textUrl(item.id), target: '_blank', rel: 'noopener' }, icon('link', 'i i-sm'), 'Сырой'),
        ),
        h('pre', { class: 'code' }, h('code', { text: item.body })),
      )
    : null;

  const sidebar = h('div', {},
    h('div', { class: 'panel' },
      h('div', { class: 'panel-title', text: 'Сведения' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Тип' }), h('dd', { text: TYPE_LABEL[item.type] }),
        h('dt', { text: 'Автор' }), h('dd', { text: item.authorLabel || item.author }),
        h('dt', { text: 'Создано' }), h('dd', { text: when(item.createdAt) }),
        h('dt', { text: 'Просмотры' }), h('dd', { text: String(item.hits) }),
        h('dt', { text: 'Видимость' }), h('dd', { text: item.visibility === 'unlisted' ? 'по ссылке' : 'в ленте' }),
        h('dt', { text: 'ID' }), h('dd', { text: item.id }),
      ),
    ),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-title', text: 'Действия' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-sm', onclick: () => copy(location.href, 'Ссылка скопирована') }, icon('link', 'i i-sm'), 'Ссылка'),
        item.body ? h('button', { class: 'btn btn-sm', onclick: () => copy(item.body, 'Код скопирован') }, icon('copy', 'i i-sm'), 'Код') : null,
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
        h('h1', { style: 'margin:8px 0 0', text: item.title }),
        media,
        files,
        body,
      ),
      sidebar,
    ),
  );
}

function editorForm(initial) {
  const state = {
    type: initial.type || 'script',
    language: initial.language || (initial.type === 'script' ? 'luau' : 'text'),
    title: initial.title || '',
    tags: (initial.tags || []).join(', '),
    body: initial.body || '',
    visibility: initial.visibility || 'public',
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
      if (pending.length + initial.files.length >= (config.limits.maxFilesPerItem || 20)) {
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
        initial.files.length
          ? h('div', { class: 'panel' },
              h('div', { class: 'panel-title', text: 'Уже загружено' }),
              initial.files.map((f) => h('div', { class: 'queue-row' },
                h('a', { href: fileUrl(f.id), text: f.name }),
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
      h('div', { class: 'panel' },
        h('div', { class: 'panel-title', text: 'Как это работает' }),
        h('p', { class: 'hint', text: 'Аккаунт не создаётся. При публикации сервер выдаёт ключ редактирования — он остаётся в этом браузере. Секрет нужен, чтобы изменить или удалить запись.' }),
      ),
    ),
  );

  async function onSubmit(e) {
    e.preventDefault();
    if (!state.title.trim()) { toast('Нужно название', true); titleInput.focus(); return; }
    submit.disabled = true;
    submit.replaceChildren(icon('upload', 'i i-sm spin'), 'Публикация');

    const payload = {
      type: state.type,
      title: state.title.trim(),
      language: state.language,
      tags: state.tags.split(/[,\s]+/).filter(Boolean),
      body: state.body,
      visibility: state.visibility,
    };

    try {
      let id = initial.id;
      if (id) {
        await api(`/api/items/${id}`, { method: 'PATCH', body: payload, secret: keyFor(id) });
        toast('Сохранено');
      } else {
        const res = await api('/api/items', { method: 'POST', body: payload });
        id = res.item.id;
        rememberKey(id, res.secret);
        toast(`Опубликовано. Ключ: ${res.secret}`);
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
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Новая публикация' }), h('p', { class: 'page-sub', text: 'Без регистрации. Ключ редактирования выдаст сервер.' }))),
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
  const { item } = await api(`/api/items/${id}`);
  $view.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Редактирование' }), h('p', { class: 'page-sub', text: item.title }))),
    editorForm(item),
  );
}

async function viewMe() {
  const { author, items, files } = await api('/api/me');
  const keys = loadKeys();
  const mine = items.map((item) => {
    const owned = Boolean(keys[item.id]);
    return h('div', { class: 'row' },
      h('span', { class: 'row-mark' }, icon(TYPE_ICON[item.type] || 'clip', 'i i-sm')),
      h('span', {},
        h('a', { class: 'row-title', href: `/i/${item.id}`, text: item.title }),
        h('div', { class: 'row-meta' },
          h('span', {}, icon('hash', 'i i-sm'), item.id),
          h('span', { text: when(item.createdAt) }),
          h('span', {}, icon('eye', 'i i-sm'), String(item.hits)),
          item.files.length ? h('span', {}, icon('download', 'i i-sm'), String(item.files.length)) : null,
          owned ? null : h('span', { text: 'только чтение' }),
        ),
      ),
      h('span', { class: 'row-right' },
        owned ? h('a', { class: 'btn btn-sm btn-ghost', href: `/edit/${item.id}` }, icon('edit', 'i i-sm')) : null,
      ),
    );
  });

  const exportBox = h('textarea', { class: 'textarea', style: 'min-height:120px', placeholder: JSON.stringify({ 'abc12345': 'ключ' }, null, 2), spellcheck: 'false' });

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
                  const incoming = JSON.parse(exportBox.value || '{}');
                  saveKeys({ ...loadKeys(), ...incoming });
                  toast('Ключи импортированы');
                  route();
                } catch { toast('не похоже на JSON с ключами', true); }
              },
            }, icon('upload', 'i i-sm'), 'Импорт'),
          ),
          exportBox,
        ),
        h('div', { class: 'panel' },
          h('div', { class: 'panel-title', text: 'Мои файлы' }),
          files.length
            ? h('div', {}, files.map((f) => h('div', { class: 'queue-row' },
                h('a', { href: fileUrl(f.id), text: f.name, style: 'overflow:hidden;text-overflow:ellipsis' }),
                h('span', { class: 'spacer' }),
                h('span', { text: bytes(f.size) }),
              )))
            : h('p', { class: 'hint', text: 'Файлов пока нет.' }),
        ),
      ),
    ),
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

async function boot() {
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
  await route();
}

boot();
