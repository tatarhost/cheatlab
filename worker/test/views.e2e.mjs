/**
 * End-to-end render check: real Worker + real SQL, real JSON, then the real
 * public/app.js booted against a DOM stub that forwards fetch to the Worker.
 *
 * The suites in worker/test assert the API contract. This asserts the other
 * half - that the views can actually build themselves from those responses -
 * which is where a missing field, a renamed key or a bad `instanceof` in the
 * view layer would otherwise only show up in a browser.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeEnv, call, request, answerQuestion } from './harness.mjs';
import worker from '../src/index.js';

const PUBLIC = new URL('../../public/', import.meta.url);
const appSrc = readFileSync(new URL('app.js', PUBLIC), 'utf8');
// Point the app at the harness host instead of production, so the stubbed
// fetch below can hand the Request straight to the Worker.
const appHtml = readFileSync(new URL('index.html', PUBLIC), 'utf8')
  .replace('https://cheatlab.tatarhost.workers.dev', 'https://api.cheatlab.test');

/* ------------------------------------------------------------------ the DOM */

class Node {}
class Element extends Node {
  constructor(tag = 'div') {
    super();
    this.tagName = String(tag).toUpperCase();
    this.style = new Proxy({ setProperty() {}, removeProperty() {} }, {
      get: (t, k) => (k in t ? t[k] : ''),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    this.dataset = {};
    this.children = [];
    this.attributes = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.textContent = '';
    this.innerHTML = '';
    // h() wires handlers through addEventListener, so they are kept rather than
    // dropped - otherwise no click could ever be simulated and a button would be
    // indistinguishable from a label.
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  /**
   * Invokes the handlers the app attached for `type`, the way a real event would.
   *
   * Defined here rather than left as a no-op: h() wires every onclick and
   * onsubmit through addEventListener, so an event that does nothing would make
   * a broken button look identical to an inert label - which is exactly the
   * failure this suite exists to catch. Keep this the only click() in the class
   * body; a second definition further down silently wins and turns clicks into
   * no-ops again.
   */
  fire(type, extra = {}) {
    let prevented = false;
    const event = { type, preventDefault() { prevented = true; }, ...extra };
    for (const fn of this.listeners.get(type) || []) fn(event);
    return prevented;
  }
  click() { return this.fire('click'); }
  submit() { return this.fire('submit'); }
  append(...k) { this.children.push(...k); }
  prepend(...k) { this.children.unshift(...k); }
  replaceChildren(...k) { this.children = k; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  focus() {} blur() {} select() {} contains() { return false; }
  /**
   * A form control's value, the way a browser reports it.
   *
   * A SELECT with no selection answers with its first option, which is how
   * every select in the app is meant to be read: the default is the first
   * choice and the markup never marks one selected. Returning undefined here
   * instead would make every select-driven form submit an empty value and fail
   * for a reason that has nothing to do with the view under test.
   */
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const first = this.children.find((c) => c && c.tagName === 'OPTION');
      return first ? first.getAttribute('value') ?? '' : '';
    }
    return '';
  }
  set value(v) { this._value = String(v); }
}
class TextNode extends Node {
  constructor(t) { super(); this.nodeType = 3; this.textContent = String(t); }
}

/** Flattens the stub tree to text so a check can look for what was rendered. */
function textOf(node, out = []) {
  if (node == null) return out;
  if (node instanceof TextNode) { out.push(node.textContent); return out; }
  if (node instanceof Node) {
    // h() sets `text` through textContent rather than as a child node, so both
    // have to be collected or every prop-built label reads as empty.
    if (node.textContent) out.push(node.textContent);
    for (const k of node.children || []) textOf(k, out);
  }
  return out;
}
function hrefsOf(node, out = []) {
  if (node instanceof Node) {
    const href = node.attributes?.href;
    if (typeof href === 'string') out.push(href);
    for (const k of node.children || []) hrefsOf(k, out);
  }
  return out;
}

/**
 * Collects elements in render order, so a test can address a control the way a
 * person does - by the label next to it - instead of by DOM id the app never
 * sets.
 */
function findAll(node, predicate, out = []) {
  if (node instanceof Node) {
    if (predicate(node)) out.push(node);
    for (const k of node.children || []) findAll(k, predicate, out);
  }
  return out;
}
/** A button whose own rendered text contains `label`. */
function buttonWithLabel(node, label) {
  return findAll(node, (el) => el.tagName === 'BUTTON' && textOf(el).join(' ').includes(label))[0] || null;
}
/**
 * The panel that carries `heading` and has a textarea to type into.
 *
 * `pop()` picks the tightest wrapper of several matches, but the heading alone
 * also contains the title's text, so the filter has to require the textarea too
 * - otherwise it returns the heading and the lookup below finds nothing.
 */
function panelWithTextarea(node, heading) {
  const matches = findAll(node, (el) => textOf(el).join(' ').includes(heading)
    && findAll(el, (kid) => kid.tagName === 'TEXTAREA').length > 0);
  return matches[matches.length - 1] || null;
}

/* -------------------------------------------------------------- seed a D1 */

const env = makeEnv({ ANON_NEW_ITEMS_PER_DAY: '50', REG_NEW_ITEMS_PER_DAY: '50' });
const as = (client, path, opts) => call(worker, env, path, { client, ...opts });

// Author: registered, with a themed profile, a locked paste and a file behind it.
// Registration, exactly as the auth view performs it: fetch the advertised
// difficulty, ask for a challenge, solve it, then post with both headers.
async function register(client, nick) {
  const cfg = await as(client, '/api/config');
  const bits = Math.min(30, Math.max(8, Number(cfg.json?.powBits) || 8));
  const { challenge } = (await as(client, '/api/auth/pow')).json;
  const nonce = await solvePowLocal(challenge, bits);
  return as(client, '/api/auth/register', {
    method: 'POST',
    body: { nick, password: 'Tr0ub4dor-and-3-ducks' },
    headers: { 'x-cheatlab-pow': challenge, 'x-cheatlab-pow-nonce': nonce },
  });
}

const reg = await register('e2eauthor0000001', 'author');
if (reg.status !== 201) throw new Error(`seed: register returned ${reg.status} ${reg.text}`);
const token = reg.json.token;
const authorId = reg.json.user.id;

const themed = await as('e2eauthor0000001', '/api/auth/me', {
  method: 'PATCH', session: token,
  body: {
    bio: 'делаю виджеты',
    logo: 'https://cdn.example.com/a.png',
    accent: '#7c5cff',
    bg: 'linear-gradient(180deg, #101014, #1b1b24)',
  },
});
if (themed.status !== 200) throw new Error(`seed: profile ${themed.status} ${themed.text}`);
// A 200 here only says the PATCH was accepted. If the sanitizer quietly dropped
// the background, every later profile check would still pass on an unstyled page,
// so the stored value is compared here - at the one point where the seed and the
// sanitizer meet.
if (themed.json.user.bg !== 'linear-gradient(180deg, #101014, #1b1b24)') {
  throw new Error(`seed: background was not stored: ${JSON.stringify(themed.json.user.bg)}`);
}

const created = await as('e2eauthor0000001', '/api/items', {
  method: 'POST', session: token,
  body: {
    type: 'script', title: 'закрытый скрипт', body: 'print("секрет")',
    language: 'luau', tags: 'roblox ui',
    accessKey: 'e2e-secret-key', keyHint: 'ключ из профиля',
  },
});
if (created.status !== 201) throw new Error(`seed: create ${created.status} ${created.text}`);
const itemId = created.json.item.id;

const open = await as('e2eauthor0000001', '/api/items', {
  method: 'POST', session: token,
  body: { type: 'paste', title: 'открытая заметка', body: 'просто текст' },
});
const openId = open.json.item.id;

// A second browser that registers, likes the locked item, follows the author,
// and sets an admin flag so the badge path runs.
const fan = await register('e2efan0000000001', 'fan');
if (fan.status !== 201) throw new Error(`seed: fan register ${fan.status} ${fan.text}`);
await as('e2efan0000000001', `/api/items/${itemId}/like`, { method: 'POST', session: fan.json.token });
await as('e2efan0000000001', `/api/users/${authorId}/follow`, { method: 'POST', session: fan.json.token });

/* --------------------------------------------------- boot the app per route */

/**
 * Boots app.js at one route as one browser, and returns the rendered text plus
 * every href the view produced.
 *
 * `editKeys` and `accessKeys` are the two separate localStorage maps the app
 * keeps, so a test can be explicit about which browser holds which secret
 * rather than inheriting the author's by accident.
 */
async function boot(route, { client, session, editKeys = {}, accessKeys = {} } = {}) {
  const [path, search = ''] = route.split('?');
  const view = new Element('main');
  // Queued answers for window.prompt/confirm, drained in order. The moderation
  // console asks for a ban length and a reason through prompts, and a stub that
  // returned nothing would make those actions look inert rather than wrong.
  const answers = [];
  const byId = new Map();
  for (const m of appHtml.matchAll(/\sid="([^"]+)"/g)) byId.set(m[1], new Element('div'));
  byId.set('app', new Element('body'));
  byId.set('view', view);
  byId.set('themeIcon', new Element('use'));
  // Toast messages are user-visible feedback for failed input, so the test needs
  // to read them the same way a person does.
  byId.set('toast', new Element('div'));

  const local = new Map(Object.entries({
    'cheatlab.client': client || 'e2ebrowser00000001',
    ...(session ? { 'cheatlab.session': JSON.stringify({ token: session }) } : {}),
    'cheatlab.keys': JSON.stringify(editKeys),
    'cheatlab.access': JSON.stringify(accessKeys),
  }));

  const document = {
    documentElement: new Element('html'),
    body: byId.get('app'),
    head: new Element('head'),
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (t) => new Element(t),
    createElementNS: (_n, t) => new Element(t),
    createTextNode: (t) => new TextNode(t),
    createDocumentFragment: () => new Element('#f'),
    querySelector: (s) => {
      if (s.startsWith('#')) return byId.get(s.slice(1)) ?? null;
      if (s.includes('cheatlab-api')) return Object.assign(new Element('meta'), { content: 'https://api.cheatlab.test' });
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    title: '', baseURI: 'https://tatarhost.github.io/cheatlab/',
    visibilityState: 'visible',
  };

  // `location` is mutable on purpose and `pushState` really moves it, because
  // `navigate()` is pushState + route(). With a no-op stub, any redirect -
  // a signed-out visitor sent to /auth, say - would re-render the same route and
  // recurse until the stack runs out, which looks exactly like a bug in the view
  // that did the redirecting.
  const loc = {
    href: `https://tatarhost.github.io/cheatlab${route}`,
    pathname: `/cheatlab${path}`.replace(/\/+$/, '') || '/cheatlab',
    search: search ? `?${search}` : '',
    hash: '', origin: 'https://tatarhost.github.io',
    assign(next) { this.href = next; route_(this); },
    replace(next) { this.href = next; route_(this); },
    reload() {},
  };
  function route_(l) {
    const u = new URL(l.href, loc.origin);
    l.pathname = u.pathname;
    l.search = u.search;
    l.hash = u.hash;
  }

  const sandbox = {
    document, Node, Element,
    location: loc,
    history: {
      state: null,
      pushState(_s, _t, url) { if (url) route_(Object.assign(loc, { href: new URL(url, loc.origin + loc.pathname).href })); },
      replaceState(_s, _t, url) { if (url) route_(Object.assign(loc, { href: new URL(url, loc.origin + loc.pathname).href })); },
    },
    localStorage: {
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: (k) => local.delete(k),
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node', sendBeacon: () => true },
    // The real Worker, behind the real request. `api()` calls fetch the way the
    // browser does - a URL plus an init - so both shapes have to be accepted, and
    // headers dropped here would silently turn every call into an anonymous one.
    fetch: async (input, init) => {
      const r = new Request(input, init);
      const res = await worker.fetch(r, env);
      if (process.env.VIEWS_TRACE) {
        const body = await res.clone().text();
        console.log('   ', r.method, new URL(r.url).pathname + new URL(r.url).search,
          [...r.headers.keys()].join(',') || '(no headers)',
          '->', res.status, body.slice(0, 120).replace(/\s+/g, ' '));
      }
      return res;
    },
    Response, Request, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    // Standard globals the app's upload path touches. Without them `api()` would
    // throw on a reference rather than on a request, which is how a whole view
    // can fail to render for a reason that has nothing to do with the view.
    Blob, ArrayBuffer, Uint8Array, File, FormData,
    // Browsers have all three; without them a view that asks the operator a
    // question would throw a ReferenceError instead of asking it.
    prompt: () => (answers.length ? answers.shift() : null),
    confirm: () => (answers.length ? !!answers.shift() : false),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    crypto: globalThis.crypto,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    // console.log/warn are muted because the app logs on every route; error is
    // left on, since a swallowed exception is how a click handler can fail to do
    // anything at all while every check still passes.
    console: { ...console, log: process.env.VIEWS_TRACE ? console.log : () => {}, warn: () => {} },
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    addEventListener: () => {}, removeEventListener: () => {},
    scrollTo: () => {}, scrollBy: () => {},
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

  vm.createContext(sandbox);
  await vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
  // boot() -> route() -> api() against the real Worker is several awaits deep,
  // so poll the view until it stops growing instead of guessing a delay. An
  // empty view after the deadline is itself a failure the checks below report.
  let last = -1;
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const size = view.children.length;
    if (size && size === last) break;
    last = size;
  }
  return {
    text: textOf(view).join(' '),
    // Re-reads the view after an action. `text` is a snapshot taken at boot, so
    // it cannot see anything a click or a submit rendered afterwards.
    read: () => textOf(view).join(' '),
    hrefs: hrefsOf(view),
    view,
    local,
    /** Queues the answers the next prompt()/confirm() calls will receive. */
    answer: (...v) => answers.push(...v),
    toast: () => textOf(byId.get('toast')).join(' '),
  };
}

/** The client's solvePow, transcribed from public/app.js. */
async function solvePowLocal(challenge, bits, maxTries = 5e6) {
  const enc = new TextEncoder();
  for (let nonce = 0; nonce < maxTries; nonce++) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}.${nonce}`)));
    let zeros = 0;
    for (let i = 0; i < digest.length && digest[i] === 0; i++) zeros += 8;
    if (zeros < digest.length * 8 && digest[zeros >> 3]) zeros += Math.clz32(digest[zeros >> 3]) - 24;
    if (zeros >= bits) return String(nonce);
  }
  return null;
}

/* ------------------------------------------------------------------- checks */

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; return; }
  failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
};

const feed = await boot('/');
check('feed renders the open item', feed.text.includes('открытая заметка'), feed.text.slice(0, 200));
check('feed renders the locked item shell', feed.text.includes('закрытый скрипт'));
check('feed shows the lock hint, not the body', feed.text.includes('ключ из профиля') && !feed.text.includes('print("секрет")'));
check('feed shows the like count', feed.text.includes('1'), feed.text.slice(0, 200));

const lockedGuest = await boot(`/i/${itemId}`, { client: 'e2eguest000000001' });
check('a locked item page still shows its title', lockedGuest.text.includes('закрытый скрипт'));
check('it asks for a key instead of the body', !lockedGuest.text.includes('print("секрет")'));
check('the lock screen names the hint', lockedGuest.text.includes('ключ из профиля'), lockedGuest.text.slice(0, 240));

const lockedOwner = await boot(`/i/${itemId}`, {
  client: 'e2eauthor0000001',
  session: token,
  // The author published it, so this browser holds both secrets: the edit
  // secret and the access key, which the app stores on a successful create.
  editKeys: { [itemId]: created.json.secret },
  accessKeys: { [itemId]: 'e2e-secret-key' },
});
check('the author, who kept the key, sees the body', lockedOwner.text.includes('print("секрет")'), lockedOwner.text.slice(0, 240));
check('the author is offered edit and delete',
  lockedOwner.hrefs.some((x) => x.includes(`/edit/${itemId}`)),
  lockedOwner.hrefs.join(' '));

const unlockedFan = await boot(`/i/${itemId}`, {
  client: 'e2efan0000000001',
  session: fan.json.token,
  accessKeys: { [itemId]: 'e2e-secret-key' },
});
check('a key in this browser opens the item', unlockedFan.text.includes('print("секрет")'), unlockedFan.text.slice(0, 240));
check('the fan holds no edit key, so no edit link',
  !unlockedFan.hrefs.some((x) => x.includes(`/edit/${itemId}`)), unlockedFan.hrefs.join(' '));
check('nor a delete button', !unlockedFan.text.includes('Удалить'), unlockedFan.text.slice(0, 300));

const profile = await boot(`/u/${authorId}`, { client: 'e2eguest000000001' });
check('the profile renders the author', profile.text.includes('author'), profile.text.slice(0, 200));
check('and their bio', profile.text.includes('делаю виджеты'), profile.text.slice(0, 240));
check('and links the locked post as a card', profile.text.includes('закрытый скрипт'));

const fanProfile = await boot(`/u/${authorId}`, { client: 'e2efan0000000001', session: fan.json.token });
check('a follower sees the follow state', fanProfile.text.includes('Отписаться') || fanProfile.text.includes('подписан'), fanProfile.text.slice(0, 240));

const open1 = await boot(`/i/${openId}`, { client: 'e2eguest000000001' });
check('an unlocked post renders for a stranger', open1.text.includes('просто текст'), open1.text.slice(0, 240));

const editor = await boot('/new', { client: 'e2eauthor0000001', session: token });
check('the publish form offers the key fields', editor.text.includes('Ключ') || editor.text.toLowerCase().includes('ключ'), editor.text.slice(0, 240));

const me = await boot('/me', {
  client: 'e2eauthor0000001',
  session: token,
  editKeys: { [itemId]: created.json.secret, [openId]: open.json.secret },
  accessKeys: { [itemId]: 'e2e-secret-key' },
});
check('my publications lists both posts', me.text.includes('закрытый скрипт') && me.text.includes('открытая заметка'), me.text.slice(0, 300));

const followers = await boot(`/u/${authorId}/followers`, { client: 'e2eguest000000001' });
check('the followers list renders', followers.text.includes('fan'), followers.text.slice(0, 200));

// The admin badge is server-driven, so the flag has to be in the env the
// profile is read through - exactly as it is for a Worker deployment.
const plainProfile = await boot(`/u/${authorId}`, { client: 'e2eguest000000001' });
check('an unlisted user is not badged', !plainProfile.text.includes('админ'), plainProfile.text.slice(0, 200));

env.ADMIN_IDS = authorId;
const adminProfile = await boot(`/u/${authorId}`, { client: 'e2eguest000000001' });
check('a listed user is badged', adminProfile.text.includes('админ'), adminProfile.text.slice(0, 200));
env.ADMIN_IDS = '';

// The editor needs both secrets: the edit key to get in at all, and the access
// key to see the fields of a locked publication rather than an empty shell.
const editOk = await boot(`/edit/${itemId}`, {
  client: 'e2eauthor0000001',
  session: token,
  editKeys: { [itemId]: created.json.secret },
  accessKeys: { [itemId]: 'e2e-secret-key' },
});
check('the editor loads a locked post it can open', editOk.text.includes('Редактирование') && editOk.text.includes('закрытый скрипт'), editOk.text.slice(0, 240));
check('and offers the key controls', editOk.text.includes('Ключ') || editOk.text.toLowerCase().includes('защит'), editOk.text.slice(0, 400));

const editNoKey = await boot(`/edit/${itemId}`, {
  client: 'e2eauthor0000001',
  session: token,
  editKeys: { [itemId]: created.json.secret },
});
check('without the access key the editor refuses to blank the fields', editNoKey.text.includes('Публикация под ключом'), editNoKey.text.slice(0, 240));

const editNoSecret = await boot(`/edit/${itemId}`, { client: 'e2eguest000000001' });
check('without the edit key there is no editor at all', editNoSecret.text.includes('Нужен ключ'), editNoSecret.text.slice(0, 240));

const search = await boot('/search?q=скрипт', { client: 'e2eguest000000001' });
check('search renders results', search.text.includes('закрытый скрипт'), search.text.slice(0, 200));

// The remaining routes, booted for the same reason: a view that throws renders
// the 404 box, which is indistinguishable from a wrong link unless something
// says so. Each of these must produce its own content, not "not found".
for (const [route, needle, why] of [
  ['/stats', 'Публикаций', 'the stats page'],
  ['/auth', 'Войти', 'the auth page'],
  ['/scripts', '', 'the scripts feed'],
  ['/pastes', 'открытая заметка', 'the pastes feed'],
  ['/images', '', 'an empty media feed'],
  ['/rules', 'нарушающий закон', 'the rules page'],
  ['/terms', 'без гарантий', 'the terms page'],
  ['/privacy', 'Пароль не хранится', 'the privacy page'],
  ['/report', 'Причина', 'the report page'],
]) {
  const page = await boot(route, { client: 'e2eguest000000001' });
  check(`${why} is not the 404 page`, !page.text.includes('Страница не найдена'), page.text.slice(0, 160));
  if (needle) check(`${why} shows its content`, page.text.includes(needle), page.text.slice(0, 200));
}

/* ------------------------------------------------------- legal and reports --
 * The footer carries the documents, and the report form has to accept a
 * complaint from a signed-out visitor, because that is the whole point of a
 * takedown route: the person with the problem usually has no account. */

// The footer is static markup in index.html, which the DOM stub does not parse,
// so its links are asserted against the file itself rather than a render. They
// have to be relative: <base href="/cheatlab/"> is what puts a leading-slash link
// outside the project on GitHub Pages.
for (const doc of ['rules', 'terms', 'privacy', 'report']) {
  check(`index.html links to ${doc}`, appHtml.includes(`href="${doc}"`), 'no such href in index.html');
}

const guestReport = await boot('/report?id=' + openId, { client: 'e2eguest000000001' });
const reportForm = findAll(guestReport.view, (el) => el.tagName === 'FORM')[0];
check('the report form can be submitted without an account', Boolean(reportForm));
// The id is pre-filled from ?id=, but the field is typed into the way a person
// would, so the query string is not what makes this pass.
const reportId = findAll(reportForm || new Element(), (el) => el.tagName === 'INPUT')[0];
if (reportId) reportId.value = openId;
if (reportForm) reportForm.submit();
await new Promise((r) => setTimeout(r, 80));
check('a guest complaint is accepted and numbered', guestReport.read().includes('Номер обращения'), guestReport.read().slice(0, 240));

env.ADMIN_IDS = authorId;
// The session is the author's, so the queue is read as the author: a session is
// bound to its client, and borrowing it from another client is refused as signed
// out rather than as unauthorised.
const filed = await as('e2eauthor0000001', '/api/admin/reports', { session: token });
check('and it lands in the moderation queue', filed.status === 200 && filed.json.reports.length > 0,
  `${filed.status} ${filed.text.slice(0, 160)}`);

// The same form has to be reachable from a post, because that is where the
// reader is when they decide something is wrong.
const postReport = await boot(`/i/${openId}`, { client: 'e2eguest000000001' });
check('a post page offers the complaint action',
  findAll(postReport.view, (el) => el.tagName === 'BUTTON'
    && textOf(el).join(' ').includes('Пожаловаться')).length > 0,
  postReport.text.slice(0, 240));

/* ------------------------------------------------------------------ admin --
 * The console is the part of Phase 1 a moderator actually uses, so it is booted
 * as a moderator with a queued complaint rather than only checked for not
 * throwing. */

// Signed out, the console redirects to /auth rather than describing itself: the
// stub's history now really moves, so this checks the redirect and not a loop.
const signedOut = await boot('/admin', { client: 'e2eguest000000001' });
check('a signed-out visitor is sent to the auth page', signedOut.text.includes('Войти'), signedOut.text.slice(0, 240));

const denied = await boot('/admin', { client: 'e2efan0000000001', session: fan.json.token });
check('a signed-in stranger is refused the console',
  denied.text.includes('Модерация') && denied.text.includes('администраторам и модераторам'), denied.text.slice(0, 240));
check('and is shown no queue', !denied.text.includes('Жалобы ('), denied.text.slice(0, 240));

const modQueue = await boot('/admin', { client: 'e2eauthor0000001', session: token });
check('an admin sees the reports queue', modQueue.text.includes('Жалобы ('), modQueue.text.slice(0, 300));
check('and the queued complaint is in it', modQueue.text.includes('Жалобы (1)'), modQueue.text.slice(0, 300));
check('with the capability summary for a full admin',
  modQueue.text.includes('Полный доступ'), modQueue.text.slice(0, 300));
check('the tabs are a tablist', findAll(modQueue.view, (el) => el.tagName === 'BUTTON'
  && (el.attributes || {}).role === 'tab').length === 4, modQueue.text.slice(0, 200));

for (const [route, needle, why] of [
  ['/admin/items', 'Последние публикации', 'the moderation item queue'],
  ['/admin/users', 'Поиск аккаунта', 'the account queue'],
  ['/admin/nicks', 'Заблокированные ники', 'the nick block list'],
]) {
  const page = await boot(route, { client: 'e2eauthor0000001', session: token });
  check(`${why} renders`, page.text.includes(needle) && !page.text.includes('Страница не найдена'), page.text.slice(0, 240));
}

// A moderator is not an admin, and the console has to say so rather than offer
// a role button that the Worker will refuse. The fan is promoted first, so the
// console is then booted as somebody who is genuinely a moderator and no admin.
const promoted = await as('e2eauthor0000001', `/api/admin/users/${fan.json.user.id}/role`, {
  method: 'POST', session: token, body: { role: 'moderator' },
});
check('the fan is now a moderator', promoted.status === 200 && promoted.json.user.role === 'moderator',
  `${promoted.status} ${promoted.text.slice(0, 160)}`);

env.ADMIN_IDS = '';
const modNicks = await boot('/admin/nicks', { client: 'e2efan0000000001', session: fan.json.token });
check('a moderator is told the nick block list is admin-only',
  modNicks.text.includes('только администратору'), modNicks.text.slice(0, 240));
const modUsers = await boot('/admin/users', { client: 'e2efan0000000001', session: fan.json.token });
check('a moderator gets the account queue', modUsers.text.includes('Поиск аккаунта'), modUsers.text.slice(0, 240));
check('and is offered no role control',
  !findAll(modUsers.view, (el) => el.tagName === 'BUTTON'
    && textOf(el).join(' ').includes('модератором')).length, modUsers.text.slice(0, 240));
const modHome = await boot('/admin', { client: 'e2efan0000000001', session: fan.json.token });
check('and sees the moderator scope, not the admin one',
  modHome.text.includes('Модератор:') && !modHome.text.includes('Полный доступ'), modHome.text.slice(0, 300));

/* ------------------------------------ banning through the console, end to end */

// The ban is the only Phase 1 action with a real consequence for a person, so
// it is driven from the queue rather than only asserted against the API.
env.ADMIN_IDS = authorId;
const banQueue = await boot('/admin/users', { client: 'e2eauthor0000001', session: token });
const searchBox = findAll(banQueue.view, (el) => el.tagName === 'INPUT')[0];
if (searchBox) searchBox.value = 'fan';
buttonWithLabel(banQueue.view, 'Найти').click();
await new Promise((r) => setTimeout(r, 60));
const found = banQueue.read();
check('the queue finds the account', found.includes('fan') && !found.includes('author'), found.slice(0, 300));

// The console asks for the term and then the reason; both come from the queue.
banQueue.answer('1', 'спам');
buttonWithLabel(banQueue.view, 'Забанить').click();
await new Promise((r) => setTimeout(r, 100));
check('the account comes back marked as banned', banQueue.read().includes('забанен'), banQueue.read().slice(0, 300));
const blockedWrite = await as('e2efan0000000001', '/api/items', {
  method: 'POST', session: fan.json.token, body: { type: 'paste', title: 'после бана', body: 'x' },
});
check('and a banned account cannot publish', blockedWrite.status === 403, `${blockedWrite.status} ${blockedWrite.text.slice(0, 120)}`);
check('with the reason shown to it', blockedWrite.text.includes('спам'), blockedWrite.text.slice(0, 200));

const unban = await as('e2eauthor0000001', `/api/admin/users/${fan.json.user.id}/ban`, {
  method: 'DELETE', session: token,
});
check('a ban can be lifted again', unban.status === 200 || unban.status === 204, `${unban.status} ${unban.text.slice(0, 160)}`);
const afterUnban = await as('e2efan0000000001', '/api/items', {
  method: 'POST', session: fan.json.token, body: { type: 'paste', title: 'после снятия бана', body: 'x' },
});
check('and the account publishes again', afterUnban.status === 201, `${afterUnban.status} ${afterUnban.text.slice(0, 160)}`);
const fanItemId = afterUnban.json && afterUnban.json.item && afterUnban.json.item.id;

// The popular mark has to be visible on the publication, not only in the queue
// where it was set: it is a claim about an author, made to readers.
const popular = await as('e2eauthor0000001', `/api/admin/users/${authorId}/popular`, {
  method: 'POST', session: token, body: { popular: true },
});
check('the popular mark is set', popular.status === 200 && popular.json.user.popular === true,
  `${popular.status} ${popular.text.slice(0, 160)}`);
check('a post by a popular author carries the mark',
  (await boot(`/i/${openId}`, { client: 'e2eguest000000001' })).text.includes('популярный'), openId);
check('and a post by anyone else does not',
  fanItemId ? !(await boot(`/i/${fanItemId}`, { client: 'e2eguest000000001' })).text.includes('популярный')
    : 'the fan could not publish a post to check', fanItemId || 'no fan post');
await as('e2eauthor0000001', `/api/admin/users/${authorId}/popular`, {
  method: 'POST', session: token, body: { popular: false },
});

const resolveBtn = buttonWithLabel(modQueue.view, 'Снять');
if (resolveBtn) resolveBtn.click();
await new Promise((r) => setTimeout(r, 100));
check('resolving a complaint takes the post down',
  (await as('e2eguest000000001', `/api/items/${openId}`)).status === 404,
  'the item is still there after the report was upheld');

env.ADMIN_IDS = '';

const unknown = await boot('/nope', { client: 'e2eguest000000001' });
check('an unknown route really is the 404 page', unknown.text.includes('Страница не найдена'), unknown.text.slice(0, 160));

const missing = await boot('/i/zzzzzzzz', { client: 'e2eguest000000001' });
check('a missing item does not render an empty page', !missing.text.includes('Загрузка'), missing.text.slice(0, 160));

/* ------------------------------------------------- key import through the UI */

// Import is the one place where data arrives from outside the app, so it is
// clicked rather than merely rendered. This browser owns the edit key but has
// lost the access key, exactly as it would after clearing site data.
const importer = await boot('/me', {
  client: 'e2eauthor0000001',
  session: token,
  editKeys: { [itemId]: created.json.secret },
  accessKeys: {},
});
const accessPanel = panelWithTextarea(importer.view, 'Ключи доступа');
check('the access key panel is there to import into', Boolean(accessPanel), 'no panel found');
const importBox = findAll(accessPanel, (el) => el.tagName === 'TEXTAREA')[0];
const importBtn = buttonWithLabel(accessPanel, 'Импорт');
check('with a box and a button', Boolean(importBox) && Boolean(importBtn));

importBox.value = JSON.stringify({ [itemId]: 'e2e-secret-key' });
importBtn.click();
await new Promise((r) => setTimeout(r, 40));
check('a valid key lands in the access store',
  JSON.parse(importer.local.get('cheatlab.access') || '{}')[itemId] === 'e2e-secret-key',
  String(importer.local.get('cheatlab.access')));

// A dump that names publications this browser does not own must be refused
// rather than stored, so it cannot quietly unlock a stranger's post here.
const intruder = await boot('/me', {
  client: 'e2eauthor0000001',
  session: token,
  editKeys: { [itemId]: created.json.secret },
  accessKeys: {},
});
const intruderPanel = panelWithTextarea(intruder.view, 'Ключи доступа');
findAll(intruderPanel, (el) => el.tagName === 'TEXTAREA')[0].value = JSON.stringify({ openId: 'guess', zzzzzzzz: 'guess' });
buttonWithLabel(intruderPanel, 'Импорт').click();
await new Promise((r) => setTimeout(r, 40));
check('a foreign key is not stored',
  Object.keys(JSON.parse(intruder.local.get('cheatlab.access') || '{}')).length === 0,
  String(intruder.local.get('cheatlab.access')));
check('and the refusal says why', intruder.toast().includes('своих публикаций'), intruder.toast());

// Malformed input has to be reported, not stored, and must not throw - a throw
// here would take the whole page down over a bad paste.
const broken = await boot('/me', {
  client: 'e2eauthor0000001',
  session: token,
  editKeys: { [itemId]: created.json.secret },
  accessKeys: {},
});
const brokenPanel = panelWithTextarea(broken.view, 'Ключи доступа');
findAll(brokenPanel, (el) => el.tagName === 'TEXTAREA')[0].value = '{ not json';
buttonWithLabel(brokenPanel, 'Импорт').click();
await new Promise((r) => setTimeout(r, 40));
check('broken JSON is refused', Object.keys(JSON.parse(broken.local.get('cheatlab.access') || '{}')).length === 0);
check('and the message names the problem', broken.toast().includes('JSON'), broken.toast());

// A well-formed object with a bad value is a different mistake from bad syntax
// and should say so, rather than the generic "not JSON".
const wrongShape = await boot('/me', {
  client: 'e2eauthor0000001',
  session: token,
  editKeys: { [itemId]: created.json.secret },
  accessKeys: {},
});
const shapePanel = panelWithTextarea(wrongShape.view, 'Ключи доступа');
findAll(shapePanel, (el) => el.tagName === 'TEXTAREA')[0].value = JSON.stringify({ [itemId]: 42 });
buttonWithLabel(shapePanel, 'Импорт').click();
await new Promise((r) => setTimeout(r, 40));
check('a non-string value is refused', Object.keys(JSON.parse(wrongShape.local.get('cheatlab.access') || '{}')).length === 0);
check('and names the offending entry', wrongShape.toast().includes('плохая запись'), wrongShape.toast());

/* --------------------------------------------------- unlocking through the UI */

// Everything above seeded localStorage to get an open item. This drives the
// lock screen itself, because that is the flow a reader actually has: guess,
// get told no, try again, and only then does the body appear and the key stay.
const guesser = await boot(`/i/${itemId}`, { client: 'e2efan0000000001', session: fan.json.token });
const lockForm = findAll(guesser.view, (el) => el.tagName === 'FORM'
  && textOf(el).join(' ').includes('Публикация под ключом'))[0];
const keyInput = findAll(lockForm, (el) => el.tagName === 'INPUT')[0];
check('the lock screen offers a key field and handles submit',
  Boolean(lockForm) && Boolean(keyInput) && lockForm.listeners.get('submit').length === 1);

keyInput.value = 'wrong-key';
lockForm.submit();
await new Promise((r) => setTimeout(r, 60));
const wrongNotice = findAll(guesser.view, (el) => (el.attributes || {}).role === 'alert')[0];
check('a wrong key is rejected in place', textOf(wrongNotice || new TextNode('')).join(' ').includes('Неверный ключ'),
  textOf(wrongNotice || new TextNode('')).join(' ') || 'no alert element');
check('and the body is still not shown', !textOf(guesser.view).join(' ').includes('print("секрет")'));
check('and a wrong guess is not remembered',
  Object.keys(JSON.parse(guesser.local.get('cheatlab.access') || '{}')).length === 0,
  String(guesser.local.get('cheatlab.access')));

// The retry uses the same form, still on the same page, so nothing is reloaded.
const retryInput = findAll(guesser.view, (el) => el.tagName === 'INPUT' && el.attributes.type === 'password')[0];
retryInput.value = 'e2e-secret-key';
findAll(guesser.view, (el) => el.tagName === 'FORM'
  && textOf(el).join(' ').includes('Публикация под ключом'))[0].submit();
await new Promise((r) => setTimeout(r, 120));
check('the right key opens the body', textOf(guesser.view).join(' ').includes('print("секрет")'),
  textOf(guesser.view).join(' ').slice(0, 200));
check('and is remembered for next time',
  JSON.parse(guesser.local.get('cheatlab.access') || '{}')[itemId] === 'e2e-secret-key',
  String(guesser.local.get('cheatlab.access')));

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
if (failures.length) process.exitCode = 1;
