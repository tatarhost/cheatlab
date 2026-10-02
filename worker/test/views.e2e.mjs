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
   *
   * The event carries `target` and `currentTarget` pointing at this element,
   * because that is what a dispatched event has and because the app reads its
   * value out of `e.target` in every input handler. An event without a target
   * would make those handlers throw rather than read the field, and the failure
   * would look like a broken form instead of a broken stub.
   */
  fire(type, extra = {}) {
    let prevented = false;
    const event = {
      type, target: this, currentTarget: this,
      preventDefault() { prevented = true; },
      ...extra,
    };
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
   *
   * The property wins over the attribute everywhere, because that is the order a
   * browser resolves them in, and the app assigns `value` as a property. Reading
   * the attribute alone would report every freshly built field as empty, and a
   * SELECT would answer with the empty string no matter what its first option
   * said - which is how a whole moderation queue can come back empty.
   */
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const first = this.children.find((c) => c && c.tagName === 'OPTION');
      return first ? first.value : '';
    }
    if (this.tagName === 'OPTION' || this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
      return this.getAttribute('value') ?? this.textContent;
    }
    return '';
  }
  set value(v) { this._value = String(v); }
  /**
   * Reflected attributes, the way a browser keeps property and attribute in step.
   *
   * The carousel assigns `img.src` and the app assigns `a.href`; a browser
   * mirrors both into the attribute, so a test that reads only the attribute
   * sees no image at all - a carousel that loaded every picture would look
   * exactly like one that loaded none. Reading through these accessors keeps the
   * stub honest about which of the two the view used.
   */
  get src() { return this.getAttribute('src') ?? ''; }
  set src(v) { this.setAttribute('src', String(v)); }
  get href() { return this.getAttribute('href') ?? ''; }
  set href(v) { this.setAttribute('href', String(v)); }
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
 * Whether an element carries a class.
 *
 * Both places a class can live are read. The app's `h()` assigns `className`,
 * which is the property a real browser mirrors back into the `class` attribute -
 * a stub cannot mirror anything, so a test that looked at one of the two would
 * see nothing on half the tree.
 */
function hasClass(el, name) {
  const raw = `${el.className || ''} ${(el.attributes || {}).class || ''}`;
  return raw.split(/\s+/).includes(name);
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
const fanId = fan.json.user.id;
await as('e2efan0000000001', `/api/items/${itemId}/like`, { method: 'POST', session: fan.json.token });
await as('e2efan0000000001', `/api/users/${authorId}/follow`, { method: 'POST', session: fan.json.token });

/* --------------------------------------------------------- gallery seed -- */

/**
 * Five images on one post, a game and a key system.
 *
 * Five rather than two or three, because the number of pictures is what the
 * lazy loading is about: on a three-picture post "loads what it shows" and
 * "loads three up front" are the same claim, and a carousel that quietly
 * downloaded all twenty of a twenty-screenshot post would still pass. The
 * count also puts dots and the counter under a case that is neither empty nor
 * trivially small.
 */
const gallery = await as('e2eauthor0000001', '/api/items', {
  method: 'POST', session: token,
  body: {
    type: 'image', title: 'галерея снимков', body: 'подпись к скриншотам',
    gameId: '909090', gameName: 'Fake Game', gameAuthor: 'Fake Studio',
    gameCover: 'https://tr.rbxcdn.com/icon.png', keySystem: 'Moon',
  },
});
if (gallery.status !== 201) throw new Error(`seed: gallery ${gallery.status} ${gallery.text}`);
const galleryId = gallery.json.item.id;
const GALLERY_SHOTS = ['one.png', 'two.png', 'three.png', 'four.png', 'five.png'];
const shotIds = {};
for (const [i, name] of GALLERY_SHOTS.entries()) {
  const shot = new TextEncoder().encode('\x89PNG\r\n\x1a\n' + String(i).repeat(64));
  const up = await as('e2eauthor0000001', `/api/items/${galleryId}/files`, {
    method: 'POST', body: shot, headers: { 'x-filename': name, 'content-length': String(shot.length) },
  });
  if (up.status !== 201) throw new Error(`seed: upload ${name} ${up.status} ${up.text}`);
  shotIds[name] = up.json.file.id;
}
/** The id the server gave a file by name, or '' if that upload never landed. */
const fileIdOf = (name) => shotIds[name] || '';
const oneShot = await as('e2eauthor0000001', '/api/items', {
  method: 'POST', session: token,
  body: { type: 'image', title: 'одиночный снимок', body: 'всего один' },
});
const singleId = oneShot.json.item.id;
const lone = new TextEncoder().encode('\x89PNG\r\n\x1a\n' + 'l'.repeat(64));
await as('e2eauthor0000001', `/api/items/${singleId}/files`, {
  method: 'POST', body: lone, headers: { 'x-filename': 'solo.png', 'content-length': String(lone.length) },
});

// A second post about the same game, so the game's page has more than one row
// and can be told apart from a page that just echoes whatever it was given.
const secondAboutGame = await as('e2eauthor0000001', '/api/items', {
  method: 'POST', session: token,
  body: {
    type: 'script', title: 'второй скрипт под ту же игру', body: 'print(2)',
    gameId: '909090', gameName: 'Fake Game', gameAuthor: 'Fake Studio',
  },
});
const secondGameId = secondAboutGame.json.item.id;

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
  // Sockets opened while this page ran, so a test can inspect the address the
  // view built without the harness having to speak the WebSocket protocol.
  const sockets = [];
  // Which requests, if any, should fail as a dropped connection would, and which
  // should be held open instead. See `net` on the returned page.
  const net = { down: '', hold: '', release: null };
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

  const canvasCalls = [];
  const sandboxImage = {
    // The dimensions the next decoded picture will report, and the sizes the
    // fake encoder will report per output type. A type that is missing from
    // `encoded` encodes to null, which is what a real canvas does when it cannot
    // produce that format - that path needs covering too.
    next: { width: 1920, height: 1080 },
    encoded: { 'image/png': 900_000, 'image/jpeg': 400_000, 'image/webp': 300_000 },
    closed: 0,
    decodeFails: false,
    calls: canvasCalls,
  };
  function makeCanvas() {
    const ctx = {
      fillStyle: '',
      fillRect(...a) { canvasCalls.push({ op: 'fillRect', args: a, fillStyle: ctx.fillStyle }); },
      drawImage(...a) { canvasCalls.push({ op: 'drawImage', args: a }); },
    };
    const canvas = new Element('canvas');
    canvas.getContext = (kind) => (kind === '2d' ? ctx : null);
    canvas.toBlob = (cb, type, quality) => {
      canvasCalls.push({ op: 'toBlob', type, quality, width: canvas.width, height: canvas.height });
      const size = sandboxImage.encoded[type];
      const blob = size == null ? null : new Blob([new Uint8Array(size)], { type });
      queueMicrotask(() => cb(blob));
    };
    return canvas;
  }
  const createImageBitmap = async () => {
    if (sandboxImage.decodeFails) throw new Error('undecodable');
    const d = sandboxImage.next;
    return { width: d.width, height: d.height, close() { sandboxImage.closed++; } };
  };

  const document = {
    documentElement: new Element('html'),
    body: byId.get('app'),
    head: new Element('head'),
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (t) => (t === 'canvas' ? makeCanvas() : new Element(t)),
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
    Blob, File, URLSearchParams, createImageBitmap,
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
      if (net.down && new URL(r.url).pathname.includes(net.down)) {
        // What a browser reports when the request never reached anybody.
        throw new TypeError('Failed to fetch');
      }
      if (net.hold && new URL(r.url).pathname.includes(net.hold)) {
        // Parked mid-flight, so a test can do what a person does while a slow
        // post is still on its way: open a different conversation.
        await new Promise((resolve) => { net.release = resolve; });
      }
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
    requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
    // The live socket, recorded rather than opened. A real handshake needs a
    // Durable Object and a real 101, which a stub cannot provide; what the view
    // does here is the same either way - ask for a ticket, build the address,
    // and open. Recording it means a test can assert the address was built from
    // the API origin rather than the page origin, which is the part that is
    // actually wrong when it is wrong.
    WebSocket: class RecordingSocket {
      constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
      send(v) { this.sent.push(v); }
      close() { this.closed = true; }
    },
    addEventListener: () => {}, removeEventListener: () => {},
    scrollTo: () => {}, scrollBy: () => {},
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

  vm.createContext(sandbox);
  await vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
  // The app's own router, so a test can move the page between conversations the
  // way a link does. Reached by name rather than by reaching into the context:
  // asking the page to navigate is what a reader does, poking its internals is
  // not.
  const navigateInPage = vm.runInContext('navigate', sandbox);
  // boot() -> route() -> api() against the real Worker is several awaits deep,
  // so poll the view until it stops growing instead of guessing a delay. An
  // empty view after the deadline is itself a failure the checks below report.
  await settle();
  return {
    text: textOf(view).join(' '),
    // Re-reads the view after an action. `text` is a snapshot taken at boot, so
    // it cannot see anything a click or a submit rendered afterwards.
    read: () => textOf(view).join(' '),
    hrefs: hrefsOf(view),
    view,
    local,
    // The image pipeline, for the tests that call downscaleImage() directly. The
    // fake encoder is reachable so a test can decide what re-encoding "costs" -
    // the function's job is to respond to that, and a stub that always answered
    // the same size could not tell a decision from a coincidence.
    image: sandboxImage,
    downscale: (file) => sandbox.downscaleImage(file),
    /** Queues the answers the next prompt()/confirm() calls will receive. */
    answer: (...v) => answers.push(...v),
    toast: () => textOf(byId.get('toast')).join(' '),
    /** Every socket the view opened, in order. */
    sockets: () => sockets.slice(),
    /**
     * The network, for taking it away and for slowing it down.
     *
     * A send can fail for reasons that have nothing to do with rights - the
     * connection drops, a deploy is in flight - and that is the case the
     * composer's put-back exists for, so it has to be reachable. Set `net.down`
     * to a path fragment and requests matching it fail the way a browser reports
     * a dropped fetch, rather than being answered from a stub: a stubbed 500 would
     * be the server's error to render, not the network's.
     *
     * `net.hold` parks matching requests instead, for the question of what
     * happens to work that finishes after the reader has moved on. Call
     * `net.release()` to let the held request proceed.
     */
    net,
    /** Moves the page the way clicking a link would. */
    go: (href) => navigateInPage(href),
    /**
     * Waits for pending microtasks and timers.
     *
     * A click handler that posts and then re-renders is several awaits deep, so a
     * check that runs immediately after `fire()` reads the view before the view
     * has been told. `fire` returning a promise would be the obvious fix and the
     * wrong one: it would make the harness wait for handlers that a real browser
     * does not wait for either, hiding a genuinely broken async handler behind a
     * harness that happened to be patient.
     *
     * At boot the same wait covers the render chain, so a deep view gets the same
     * generous drain rather than a poll that stops early on a stable tree.
     */
    settle,
  };

  /**
   * Lets queued work run until nothing is left pending. The view is the only
   * signal that anything happened, so the loop watches it change and stops when a
   * full pass produces no change at all - a real settle, not a fixed sleep.
   */
  async function settle(passes = 40) {
    // A fixed drain, not a "did the tree change" poll. Stability in the DOM is
    // not evidence that no work is pending: the first paint of a room happens
    // before its POST has even left, so a poll that stops on a stable child count
    // stops exactly in the middle of the action it was called to wait for. Draining
    // timers lets every already-queued continuation run to its next await.
    for (let i = 0; i < passes; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
  }
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

/* ------------------------------------------------- gallery, chips, games -- */

/** The first element matching `predicate`, in render order. */
const firstEl = (node, predicate) => findAll(node, predicate)[0] || null;

/** The text of the red notice a failed view renders, or '' if it rendered fine. */
const alertText = (node) => textOf(
  findAll(node, (el) => (el.attributes || {}).role === 'alert')[0] || new TextNode(''),
).join(' ').trim();

// ---------------------------------------------------------------------------
// Downscaling before upload
//
// The pixels are the encoder's business, not this suite's: what is worth pinning
// down is the set of decisions app.js makes around them - whether to touch a file
// at all, which format wins, whether the original survives, and whether the
// filename follows the new type. The last one is not cosmetic: the server infers
// a file from its extension, so a re-encode that keeps the old extension hands the
// gallery a picture it will refuse to render.
const img = await boot('/new', { client: 'e2eauthor0000001', session: token });
const photo = (name, type, size) => new File([new Uint8Array(size)], name, { type });
const reset = (over = {}) => {
  img.image.next = { width: 1920, height: 1080 };
  img.image.encoded = { 'image/png': 900_000, 'image/jpeg': 400_000, 'image/webp': 300_000 };
  img.image.closed = 0;
  img.image.decodeFails = false;
  img.image.calls.length = 0;
  Object.assign(img.image, over);
};

reset({ next: { width: 4000, height: 3000 } });
const big = await img.downscale(photo('menu shot.png', 'image/png', 4_000_000));
check('a big picture is shrunk', big.changed, JSON.stringify(big));
check('to 1920 on the long edge, keeping the shape',
  big.file.type === 'image/webp' && /1920×1440/.test(big.note), `${big.file.type} ${big.note}`);
check('and the name follows the new type, because the server reads the extension',
  big.file.name === 'menu shot.webp', big.file.name);
check('the decoded bitmap is released', img.image.closed === 1, `${img.image.closed}`);

// A png keeps its own alpha, so the white fill only happens on the path that
// flattens: a picture with transparency going out as jpeg, where the transparent
// areas would otherwise come out black.
reset({ next: { width: 4000, height: 3000 }, encoded: { 'image/jpeg': 300_000, 'image/webp': 900_000 } });
const flattened = await img.downscale(photo('logo.webp', 'image/webp', 4_000_000));
const ops = img.image.calls.map((c) => c.op);
check('a transparent picture is flattened onto white before it becomes a jpeg',
  flattened.file.type === 'image/jpeg'
  && img.image.calls.some((c) => c.op === 'fillRect' && c.fillStyle === '#fff')
  && ops.indexOf('fillRect') < ops.indexOf('drawImage'),
  `${flattened.file.type} ${ops.join(',')}`);
check('and the flattened jpeg is named as one', flattened.file.name === 'logo.jpg', flattened.file.name);

reset({ next: { width: 1200, height: 900 } });
const small = await img.downscale(photo('icon.png', 'image/png', 400_000));
check('a picture that is already small enough is left alone', !small.changed && small.file.size === 400_000,
  `${small.changed} ${small.file.size}`);
check('and is not decoded at all', img.image.calls.length === 0, JSON.stringify(img.image.calls));

// The animated and vector cases have to be bypassed rather than "handled": one
// frame of a gif is a wrong picture, not a smaller one. The decoder here
// deliberately works, because a test that made decoding fail would pass whether
// or not the bypass exists - it would only be proving that a broken picture
// survives, which is a different claim. What is asserted is that these types
// never reach the canvas.
reset({ next: { width: 4000, height: 3000 } });
const gif = await img.downscale(photo('loop.gif', 'image/gif', 9_000_000));
const svg = await img.downscale(photo('logo.svg', 'image/svg+xml', 90_000));
check('an animated gif is never re-encoded, even though it is huge',
  !gif.changed && gif.file.size === 9_000_000, JSON.stringify(gif));
check('nor is a vector', !svg.changed && svg.file.size === 90_000, JSON.stringify(svg));
check('and neither is decoded, which is why a size of 9 MB is not a problem',
  img.image.closed === 0 && img.image.calls.length === 0,
  `${img.image.closed} closed, ${img.image.calls.length} canvas calls`);

reset({ decodeFails: true });
const undecodable = await img.downscale(photo('broken.png', 'image/png', 500_000));
check('a file that claims to be an image but will not decode is passed through',
  !undecodable.changed && undecodable.file.size === 500_000, JSON.stringify(undecodable));

// Re-encoding has to earn its place. A picture large enough to be re-encoded but
// not large enough to be resized is the only case where "did it shrink?" is the
// only thing deciding the answer - below the leave-alone size the function
// returns before it ever reaches the canvas, and above the long edge a resize
// makes it changed whatever the encoder says.
reset({ next: { width: 1600, height: 1200 }, encoded: { 'image/png': 3_000_000 } });
const notWorthIt = await img.downscale(photo('flat.png', 'image/png', 2_000_000));
check('a re-encode that does not pay for itself is discarded',
  !notWorthIt.changed && notWorthIt.file.size === 2_000_000, JSON.stringify(notWorthIt));
reset({ next: { width: 1600, height: 1200 }, encoded: { 'image/png': 900_000 } });
const worthIt = await img.downscale(photo('flat.png', 'image/png', 2_000_000));
check('but a genuine saving is taken even with no resize',
  worthIt.changed && worthIt.file.size === 900_000, JSON.stringify(worthIt));

// WebP wins only by enough to be worth the quality difference. The bar is 20%
// against whichever format was encoded first - for a png source that is the png,
// so the jpeg figures here are not what decides it; setting them makes the test
// readable rather than load-bearing.
reset({ next: { width: 4000, height: 3000 }, encoded: { 'image/png': 400_000, 'image/jpeg': 900_000, 'image/webp': 330_000 } });
const closeCall = await img.downscale(photo('flat.png', 'image/png', 4_000_000));
check('a webp that only shaves 17% is not worth the quality difference',
  closeCall.file.type === 'image/png', closeCall.file.type);
reset({ next: { width: 4000, height: 3000 }, encoded: { 'image/png': 900_000, 'image/jpeg': 400_000, 'image/webp': 300_000 } });
const clearWin = await img.downscale(photo('flat.png', 'image/png', 4_000_000));
check('but one that halves the size is taken', clearWin.file.type === 'image/webp', clearWin.file.type);

// A canvas that cannot produce the requested format returns null, and the
// fallback chain has to survive that rather than uploading a zero-byte file.
reset({ next: { width: 4000, height: 3000 }, encoded: { 'image/png': 900_000 } });
const noWebp = await img.downscale(photo('shot.png', 'image/png', 4_000_000));
check('a png whose webp fails to encode still becomes a png',
  noWebp.changed && noWebp.file.type === 'image/png' && noWebp.file.name === 'shot.png',
  `${noWebp.file.type} ${noWebp.file.name}`);
reset({ next: { width: 4000, height: 3000 }, encoded: {} });
const nothing = await img.downscale(photo('shot.png', 'image/png', 4_000_000));
check('and a canvas that encodes nothing leaves the original in place',
  !nothing.changed && nothing.file.size === 4_000_000, JSON.stringify(nothing));

// A jpeg keeps its extension as .jpg, not .jpeg, because mimeOf on the server is
// the thing that has to recognise it.
reset({ next: { width: 4000, height: 3000 }, encoded: { 'image/jpeg': 300_000, 'image/webp': 900_000 } });
const jpeg = await img.downscale(photo('wall.jpg', 'image/jpeg', 4_000_000));
check('a jpeg that wins as a jpeg keeps a name the server can read',
  jpeg.file.type === 'image/jpeg' && jpeg.file.name === 'wall.jpg', `${jpeg.file.type} ${jpeg.file.name}`);

const galleryView = await boot(`/i/${galleryId}`, { client: 'e2eguest000000001' });
// A view that throws renders a notice and nothing else, so every assertion below
// would report a confusing empty page. This one names the real cause.
check('the gallery post renders without an error notice', !alertText(galleryView.view), alertText(galleryView.view));
check('the gallery post renders its caption', galleryView.text.includes('подпись к скриншотам'), galleryView.text.slice(0, 200));
check('five pictures make a carousel',
  Boolean(firstEl(galleryView.view, (el) => hasClass(el, 'carousel'))),
  galleryView.text.slice(0, 200));
const counter = firstEl(galleryView.view, (el) => hasClass(el, 'carousel-count'));
check('the carousel says how many there are',
  textOf(counter || new TextNode('')).join(' ').includes('1 / 5'),
  textOf(counter || new TextNode('')).join(' ') || 'no counter');
const dots = findAll(galleryView.view, (el) => hasClass(el, 'carousel-dot'));
check('and offers one dot per picture', dots.length === 5, `${dots.length} dots`);
check('and marks which one is showing',
  dots.filter((d) => (d.attributes || {})['aria-current'] === 'true').length === 1,
  dots.map((d) => (d.attributes || {})['aria-current']).join(','));
const sources = findAll(galleryView.view, (el) => el.tagName === 'IMG' && (el.attributes || {}).src);
/**
 * Which of the five pictures have actually been asked for, by name.
 *
 * Re-read from the tree on every call rather than kept in a list: the whole point
 * of the lazy loader is that the set grows, and a snapshot taken once would
 * report the same three names after every arrow press.
 */
const loadedNames = () => {
  const fetched = findAll(galleryView.view, (el) => el.tagName === 'IMG'
    && String((el.attributes || {}).src || '').includes('/m/'))
    .map((img) => String(img.attributes.src));
  return GALLERY_SHOTS.filter((name) => fetched.some((src) => src.includes(fileIdOf(name))));
};
check('the picture on screen and the two an arrow press would reach are fetched',
  loadedNames().join(',') === 'one.png,two.png,five.png', loadedNames().join(','));
check('and the cover is not one of the gallery pictures',
  sources.filter((img) => String(img.attributes.src).includes('rbxcdn')).length === 1,
  sources.map((img) => String(img.attributes.src).slice(-24)).join(' | '));

// The code is the reason the post exists and the pictures illustrate it, so the
// order is asserted on the rendered tree rather than on a class name: a reader
// should meet the script before the screenshots either way the markup is written.
const codeBox = firstEl(galleryView.view, (el) => hasClass(el, 'code'));
const carousel = firstEl(galleryView.view, (el) => hasClass(el, 'carousel'));
const renderOrder = [];
const walk = (el) => {
  if (el === codeBox) renderOrder.push('code');
  if (el === carousel) renderOrder.push('gallery');
  for (const child of el.children || []) walk(child);
};
walk(galleryView.view);
check('the code is rendered above the gallery',
  renderOrder.indexOf('code') !== -1 && renderOrder.indexOf('code') < renderOrder.indexOf('gallery'),
  renderOrder.join(' -> '));

// The arrows are the control a reader reaches for first, so they are exercised
// rather than only counted. The counter is the visible state, and the number of
// fetched pictures is the one that proves the carousel is really walking the
// post rather than redrawing the same picture with a new number on it.
const carouselRoot = firstEl(galleryView.view, (el) => hasClass(el, 'carousel'));
const nextBtn = findAll(galleryView.view, (el) => el.tagName === 'BUTTON'
  && (el.attributes || {})['aria-label'] === 'Следующее фото')[0];
check('the next arrow is a real button', Boolean(nextBtn) && nextBtn.listeners.get('click').length === 1);
const shownCounter = () => textOf(firstEl(galleryView.view, (el) => hasClass(el, 'carousel-count')) || new TextNode('')).join(' ');

nextBtn.click();
check('the next arrow moves the counter', shownCounter().includes('2 / 5'), shownCounter());
check('the picture it lands on was already fetched, and only its new neighbour is added',
  loadedNames().join(',') === 'one.png,two.png,three.png,five.png', loadedNames().join(','));
check('and the dot follows', dots[1].getAttribute('aria-current') === 'true'
  && dots[0].getAttribute('aria-current') === 'false',
  dots.map((d) => d.getAttribute('aria-current')).join(','));
check('and only one dot is current at a time',
  dots.filter((d) => d.getAttribute('aria-current') === 'true').length === 1);

nextBtn.click();
check('a second press reaches the third picture', shownCounter().includes('3 / 5'), shownCounter());
check('and the post is now fully fetched, once the reader has walked a third of the way in',
  loadedNames().length === GALLERY_SHOTS.length, loadedNames().join(','));

carouselRoot.fire('keydown', { key: 'ArrowLeft' });
check('the left arrow key steps back', shownCounter().includes('2 / 5'), shownCounter());
carouselRoot.fire('keydown', { key: 'End' });
check('an unrelated key is left alone', shownCounter().includes('2 / 5'), shownCounter());

dots[4].click();
check('a dot jumps straight to its picture', shownCounter().includes('5 / 5'), shownCounter());
check('and wraps no further than the last one', dots[4].getAttribute('aria-current') === 'true');
nextBtn.click();
check('past the last picture it comes back to the first', shownCounter().includes('1 / 5'), shownCounter());

const singleView = await boot(`/i/${singleId}`, { client: 'e2eguest000000001' });
check('a single picture gets no carousel',
  findAll(singleView.view, (el) => hasClass(el, 'carousel')).length === 0,
  'carousel chrome present on a one-image post');
check('but is still rendered', singleView.text.includes('всего один'), singleView.text.slice(0, 200));

check('the post shows its game', galleryView.text.includes('Fake Game'), galleryView.text.slice(0, 300));
check('and the studio', galleryView.text.includes('Fake Studio'), galleryView.text.slice(0, 300));
check('and the key system', galleryView.text.includes('Ключевая система') && galleryView.text.includes('Moon'),
  galleryView.text.slice(0, 300));
const chipLinks = hrefsOf(galleryView.view).filter((href) => href.endsWith('/games/909090'));
check('the chip links to the game page', chipLinks.length >= 1, chipLinks.join(', ') || hrefsOf(galleryView.view).slice(0, 14).join(', '));
const coverSrcs = findAll(galleryView.view, (el) => el.tagName === 'IMG' && String(el.attributes.src || '').includes('rbxcdn'));
check('the cover is drawn', coverSrcs.length >= 1, `${coverSrcs.length} covers`);

// The feed row carries the chip too, so a game's presence is visible before the
// post is opened.
const feedWithGame = await boot('/search?q=галерея', { client: 'e2eguest000000001' });
check('the feed row carries the game', feedWithGame.text.includes('Fake Game'), feedWithGame.text.slice(0, 300));
check('and links to it', hrefsOf(feedWithGame.view).some((href) => href.endsWith('/games/909090')),
  hrefsOf(feedWithGame.view).slice(0, 12).join(', '));

// A post with no game has no chip and no empty gap where one would be.
check('a post with no game has no chip', !singleView.text.includes('Fake Game'), singleView.text.slice(0, 300));

const gamePage = await boot('/games/909090', { client: 'e2eguest000000001' });
check('the game page lists only that game\'s posts',
  gamePage.text.includes('галерея снимков') && gamePage.text.includes('второй скрипт под ту же игру'),
  gamePage.text.slice(0, 400));
check('and leaves other posts out', !gamePage.text.includes('открытая заметка'), gamePage.text.slice(0, 400));
check('the game page is headed by the chip', gamePage.text.includes('Fake Game'), gamePage.text.slice(0, 300));

// A game with a chip but no posts yet. The page still has to be a page and not
// an error: the lookup is allowed to fail here - the Worker has no Roblox
// network in this harness - and the list is not conditional on it.
const unposted = await boot('/games/777777', { client: 'e2eguest000000001' });
check('a game with no posts renders an empty page, not an error',
  !alertText(unposted.view) && unposted.read().includes('Ничего не нашлось'),
  `alert=${JSON.stringify(alertText(unposted.view))} text=${unposted.read().slice(0, 200)}`);

const publishForm = await boot('/new', { client: 'e2eauthor0000001', session: token });
check('the publish form has a game panel', publishForm.text.includes('Игра'), publishForm.text.slice(0, 400));
check('and a key system panel', publishForm.text.includes('Ключевая система'), publishForm.text.slice(0, 400));
check('and takes a game id', publishForm.text.includes('ID игры'), publishForm.text.slice(0, 400));
check('the form mentions the new quota', publishForm.text.includes('двенадцать'), publishForm.text.slice(-400));
const field = (view, id) => findAll(view.view, (el) => el.tagName === 'INPUT'
  && String((el.attributes || {}).id || '') === id)[0] || null;
check('the form has somewhere to type a cover by hand', Boolean(field(publishForm, 'f-game-cover')),
  'no cover field in the game panel');
check('and a key system field', Boolean(field(publishForm, 'f-key-system')), 'no key system field');

// Hand-typing a game, with no lookup at all. This is the case the lookup exists
// to make rare: a private place, a game Roblox will not name, an author who just
// knows the id. If the chip only ever came from the lookup button, this would
// publish a post with the fields visibly filled in and nothing attached to them.
const typed = await boot('/new', { client: 'e2eauthor0000001', session: token });
const typedId = field(typed, 'f-game-id');
const typedName = field(typed, 'f-game-name');
const typedAuthor = field(typed, 'f-game-author');
const typedCover = field(typed, 'f-game-cover');
typedId.value = '515151';
typedId.fire('input');
check('an id alone is not enough for a chip', !typed.read().includes('Ручная игра'),
  'a chip appeared from an id with no name');
typedName.value = 'Ручная игра';
typedName.fire('input');
check('an id and a name typed by hand do make a chip', typed.read().includes('Ручная игра'),
  typed.read().slice(-400));
// The chip links to the id alone. That is what makes a hand-written chip useful:
// the destination resolves the name and cover through the same lookup the
// publish form uses, so a game nobody has posted about yet still has a page. The
// risk being guarded against is the opposite one - a link that carries the name
// it was typed with, which would let a link claim to be a different game.
const gameHrefs = hrefsOf(typed.view).filter((href) => href.includes('/games/'));
check('the chip links to the id and nothing else',
  gameHrefs.length === 1 && gameHrefs[0].endsWith('/games/515151') && !gameHrefs[0].includes('?'),
  gameHrefs.join(', ') || 'no game link at all');
typedAuthor.value = 'Someone';
typedAuthor.fire('input');
typedCover.value = 'https://tr.rbxcdn.com/manual/Png/noFilter';
typedCover.fire('input');
const typedTitle = findAll(typed.view, (el) => el.tagName === 'INPUT'
  && String((el.attributes || {}).id || '') === 'f-title')[0];
if (typedTitle) { typedTitle.value = 'написанная игра'; typedTitle.fire('input'); }
const typedBody = findAll(typed.view, (el) => el.tagName === 'TEXTAREA')[0];
if (typedBody) { typedBody.value = 'print("руками")'; typedBody.fire('input'); }
const typedKeySystem = field(typed, 'f-key-system');
if (typedKeySystem) { typedKeySystem.value = 'Wave'; typedKeySystem.fire('input'); }
const typedForm = findAll(typed.view, (el) => el.tagName === 'FORM')[0];
if (typedForm) typedForm.submit();
await new Promise((r) => setTimeout(r, 150));
const typedItem = await call(worker, env, '/api/items?limit=60');
const stored = typedItem.json.items.find((i) => i.title === 'написанная игра');
check('the hand-written game is actually published', Boolean(stored),
  JSON.stringify(typedItem.json.items.map((i) => i.title)));
check('with the id and name that were typed', stored?.game?.id === '515151' && stored?.game?.name === 'Ручная игра',
  JSON.stringify(stored?.game));
check('and the studio and cover', stored?.game?.author === 'Someone'
  && stored?.game?.cover === 'https://tr.rbxcdn.com/manual/Png/noFilter', JSON.stringify(stored?.game));
check('and the key system', stored?.keySystem === 'Wave', JSON.stringify(stored?.keySystem));

// Clearing the name has to take the chip away again, or a post carries a game
// the author has just decided it is not about.
const cleared = await boot('/new', { client: 'e2eauthor0000001', session: token });
const clearedName = field(cleared, 'f-game-name');
const clearedId = field(cleared, 'f-game-id');
clearedId.value = '616161';
clearedId.fire('input');
clearedName.value = 'Временная';
clearedName.fire('input');
check('the chip is there while both fields are filled', cleared.read().includes('Временная'),
  cleared.read().slice(-300));
clearedName.value = '';
clearedName.fire('input');
check('and gone as soon as the name is cleared', !cleared.read().includes('Временная'),
  cleared.read().slice(-300));

const editGallery = await boot(`/edit/${galleryId}`, {
  client: 'e2eauthor0000001', session: token,
  editKeys: { [galleryId]: gallery.json.secret },
});
check('the editor comes back with the game filled in', editGallery.text.includes('Fake Game'), editGallery.text.slice(0, 400));
// The key system lives in an input, so it is read the way a person reads it -
// as the field's value - rather than as page text, which never contains it.
const keySystemField = findAll(editGallery.view, (el) => el.tagName === 'INPUT'
  && String((el.attributes || {}).id || '') === 'f-key-system')[0];
check('and the key system in its field', keySystemField?.value === 'Moon', `got ${JSON.stringify(keySystemField?.value)}`);
const gameIdField = findAll(editGallery.view, (el) => el.tagName === 'INPUT'
  && String((el.attributes || {}).id || '') === 'f-game-id')[0];
check('and the game id in its field', gameIdField?.value === '909090', `got ${JSON.stringify(gameIdField?.value)}`);

/* ------------------------------------------------------------------ chat */

// The chat tab has to work as a view, not just as an endpoint: a tab that
// renders nothing while the API is fine is still a broken tab. Every assertion
// below reads the real `public/app.js`, driven by a real Worker.
const channel = await as('e2eauthor0000001', '/api/chats', {
  method: 'POST', session: token, body: { kind: 'channel', title: 'Общий чат', topic: 'всё о проектах' },
});
check('seed: a channel can be made', channel.status === 201, `${channel.status} ${channel.text.slice(0, 160)}`);
const channelId = channel.json.chat.id;

const posted = await as('e2eauthor0000001', `/api/chats/${channelId}/messages`, {
  method: 'POST', session: token, body: { body: 'первое сообщение' },
});
check('seed: a message can be posted', posted.status === 201, `${posted.status} ${posted.text.slice(0, 160)}`);

const chatList = await boot('/chat', { client: 'e2eauthor0000001', session: token });
check('the chat tab lists the room', chatList.text.includes('Общий чат'), chatList.text.slice(0, 300));
check('and offers to make another', chatList.text.includes('Создать'), chatList.text.slice(0, 300));

const chatRoom = await boot(`/chat/${channelId}`, { client: 'e2eauthor0000001', session: token });
check('the room shows its title', chatRoom.text.includes('Общий чат'), chatRoom.text.slice(0, 300));
check('the message that was posted is there', chatRoom.text.includes('первое сообщение'), chatRoom.text.slice(0, 400));
check('and it says what kind of room this is', chatRoom.text.includes('Канал'), chatRoom.text.slice(0, 300));

// The composer is the whole point of a chat, so it is driven the way a person
// drives it: the field is given a value and the form is submitted.
const composer = findAll(chatRoom.view, (el) => el.tagName === 'FORM'
  && findAll(el, (kid) => String((kid.attributes || {}).id || '') === 'chat-input').length > 0)[0];
check('there is a composer', !!composer, chatRoom.text.slice(0, 300));
const chatField = findAll(chatRoom.view, (el) => String((el.attributes || {}).id || '') === 'chat-input')[0];
chatField.value = 'ответ из теста';
composer.fire('submit', { preventDefault() {} });
// The submit handler is async - it posts, then re-renders - and `fire` returns
// whether the event was prevented, not a promise for the handler, exactly as a
// real `dispatchEvent` does not wait for `onsubmit` either. The wait is explicit
// here for that reason.
await chatRoom.settle();
const afterSend = await as('e2eauthor0000001', `/api/chats/${channelId}`, { session: token });
check('submitting the composer stores the message',
  (afterSend.json.messages || []).some((m) => m.body === 'ответ из теста'),
  JSON.stringify((afterSend.json.messages || []).map((m) => m.body)));
// ...and the view shows it, rather than only the database having it. A send that
// works and a view that never refreshes is the more common bug of the two.
check('and the room shows the message that was just sent',
  chatRoom.read().includes('ответ из теста'), chatRoom.read().slice(-300));

// A file on its own is a message with no words. Driven through the real control
// rather than by setting the client's state, because the picker is the only part
// a person can actually get wrong.
const findForm = () => findAll(chatRoom.view, (el) => el.tagName === 'FORM'
  && findAll(el, (kid) => String((kid.attributes || {}).id || '') === 'chat-input').length > 0)[0];
const findField = () => findAll(chatRoom.view, (el) => String((el.attributes || {}).id || '') === 'chat-input')[0];
const findPicker = () => findAll(chatRoom.view, (el) => el.tagName === 'INPUT'
  && String((el.attributes || {}).type || '') === 'file')[0];
check('the composer has a file picker', !!findPicker(), chatRoom.read().slice(-300));

findPicker().fire('change', { target: { files: [new File([new Uint8Array(64)], 'смета.txt', { type: 'text/plain' })], value: '' } });
await chatRoom.settle();
check('a picked file is shown before it is sent, and can be taken back',
  chatRoom.read().includes('смета.txt'), chatRoom.read().slice(-300));
const drop = findAll(chatRoom.view, (el) => el.tagName === 'BUTTON'
  && String((el.attributes || {}).title || '') === 'Убрать файл')[0];
check('with a way to remove it', !!drop, chatRoom.read().slice(-300));

findForm().fire('submit', { preventDefault() {} });
await chatRoom.settle();
const afterFile = await as('e2eauthor0000001', `/api/chats/${channelId}`, { session: token });
const carrier = (afterFile.json.messages || []).find((m) => (m.files || []).some((f) => f.name === 'смета.txt'));
check('sending the picker stores a file on a message with no words',
  !!carrier && carrier.body === '', JSON.stringify((afterFile.json.messages || []).slice(-2)));
check('and the room draws it once it is stored', chatRoom.read().includes('смета.txt'), chatRoom.read().slice(-300));
check('with the field left empty for the next thing to be said',
  findField()?.value === '', JSON.stringify(findField()?.value));

// A file on its own is a message with no words, and it is created before the file
// is uploaded. So an upload that fails leaves an empty row behind, and the room
// must not be left with a bubble that says nothing - on screen now, or on the
// next reload.
const lostUpload = await boot(`/chat/${channelId}`, { client: 'e2eauthor0000001', session: token });
const pickerOf = (page) => findAll(page.view, (el) => el.tagName === 'INPUT'
  && String((el.attributes || {}).type || '') === 'file')[0];
pickerOf(lostUpload).fire('change', { target: { files: [new File([new Uint8Array(64)], 'пропал.txt', { type: 'text/plain' })], value: '' } });
await lostUpload.settle();
check('the file is waiting to go', lostUpload.read().includes('пропал.txt'), lostUpload.read().slice(-300));
// Only the upload fails; the message itself is created, which is the situation
// the retraction exists for.
lostUpload.net.down = '/files';
findAll(lostUpload.view, (el) => el.tagName === 'FORM' && hasClass(el, 'chat-composer'))[0]
  .fire('submit', { preventDefault() {} });
await lostUpload.settle();
check('the sender is told the upload failed', /не загрузил|не отправ|ошибк|failed/i.test(lostUpload.toast()),
  lostUpload.toast());
check('and the file comes back to try again',
  lostUpload.read().includes('пропал.txt'), lostUpload.read().slice(-400));
check('while no empty bubble is left in the room',
  !lostUpload.read().includes('сообщение удалено'), lostUpload.read().slice(-400));
const afterLost = await as('e2eauthor0000001', `/api/chats/${channelId}`, { session: token });
check('and nothing was left in the room on the server either',
  !(afterLost.json.messages || []).some((m) => !m.deleted && !String(m.body || '').trim() && !(m.files || []).length),
  (afterLost.json.messages || []).map((m) => `${m.deleted ? 'deleted' : m.body || (m.files || []).map((f) => f.name).join()}`).join(' | '));
const reloaded = await boot(`/chat/${channelId}`, { client: 'e2eauthor0000001', session: token });
check('a reload shows no trace of it either',
  !reloaded.read().includes('сообщение удалено') && !reloaded.read().includes('пропал.txt'),
  reloaded.read().slice(-400));

// A message body must never become markup. The server stores it as text and the
// client builds a text node, so a tag in the body has to survive as characters.
await as('e2eauthor0000001', `/api/chats/${channelId}/messages`, {
  method: 'POST', session: token, body: { body: '<img src=x onerror=alert(1)>' },
});
const hostile = await boot(`/chat/${channelId}`, { client: 'e2eauthor0000001', session: token });
check('a tag in a message is shown, not executed',
  hostile.text.includes('<img src=x onerror=alert(1)>'), hostile.text.slice(0, 400));
check('and no element was built from it',
  findAll(hostile.view, (el) => el.tagName === 'IMG'
    && String((el.attributes || {}).src || '') === 'x').length === 0,
  'an IMG with src=x was built from message text');

/* --------------------------------------------------------------- starting a DM */

// A direct message needs a person, and the thing a person has is a name. So the
// field takes a name, finds the people it matches and asks, instead of posting
// the typed text at an endpoint that only understands ids.
//
// Two accounts match "fan", on purpose: a field that resolved a name to the most
// popular stranger and opened a conversation with them would be worse than useless.
const fan2 = await register('e2efan2000000001', 'fan2');
if (fan2.status !== 201) throw new Error(`seed: fan2 register ${fan2.status} ${fan2.text}`);
await as('e2eauthor0000001', `/api/users/${fanId}/follow`, { method: 'POST', session: token });
await as('e2eauthor0000001', `/api/users/${fan2.json.user.id}/follow`, { method: 'POST', session: token });
await as('e2efan2000000001', `/api/users/${authorId}/follow`, { method: 'POST', session: fan2.json.token });

const dmFormFor = (page) => findAll(page.view, (el) => el.tagName === 'FORM'
  && findAll(el, (kid) => String((kid.attributes || {}).placeholder || '').includes('личного чата')).length > 0)[0];
const chipsFor = (page) => findAll(page.view, (el) => el.tagName === 'BUTTON' && hasClass(el, 'chat-chip'));
const typeAndSubmit = async (page, value) => {
  const form = dmFormFor(page);
  findAll(form, (el) => el.tagName === 'INPUT')[0].value = value;
  form.fire('submit', { preventDefault() {} });
  await page.settle();
  return chipsFor(page);
};

const dmPage = await boot('/chat', { client: 'e2eauthor0000001', session: token });
check('there is a form for starting one', !!dmFormFor(dmPage), dmPage.text.slice(0, 300));
const hits = await typeAndSubmit(dmPage, '@fan');
check('a name that matches two people asks instead of guessing',
  hits.length === 2, `${hits.length}`);
check('naming both of them', ['fan', 'fan2'].every((n) => hits.some((b) => textOf(b).join(' ').includes(n))),
  hits.map((b) => textOf(b).join(' ')).join(' | '));

const fanChip = hits.find((b) => textOf(b).join(' ').trim() === 'fan');
fanChip.click();
await dmPage.settle();
const dms = await as('e2eauthor0000001', '/api/chats', { session: token });
const withFan = (dms.json.chats || []).find((c) => c.kind === 'dm' && c.title === 'fan');
check('picking the person opens the conversation with them', !!withFan,
  JSON.stringify((dms.json.chats || []).map((c) => c.title)));
const dmRoom = await boot(`/chat/${withFan.id}`, { client: 'e2eauthor0000001', session: token });
check('and it opens there', dmRoom.read().includes('fan'), dmRoom.read().slice(0, 300));
// The heading is the conversation's own name. "Личный чат" appears below it as
// the kind, which is right, so the title is read from the heading rather than
// from the page text.
const dmHeading = findAll(dmRoom.view, (el) => el.tagName === 'H1')[0];
check('titled after them, not "Личный чат"',
  textOf(dmHeading)[0] === 'fan', textOf(dmHeading).join(' '));

const dmPage2 = await boot('/chat', { client: 'e2eauthor0000001', session: token });
const sole = await typeAndSubmit(dmPage2, 'fan2');
check('a name that matches one person goes straight there, with nothing to choose',
  sole.length === 0, `${sole.length}`);
const dms2 = await as('e2eauthor0000001', '/api/chats', { session: token });
check('and that is the right person',
  (dms2.json.chats || []).some((c) => c.kind === 'dm' && c.title === 'fan2'),
  JSON.stringify((dms2.json.chats || []).map((c) => c.title)));

/* ------------------------------------------------------- the live connection */

// The socket is recorded rather than opened, because a real handshake needs a
// Durable Object and a real 101. What is still checked is the part that is the
// view's own responsibility: where it dials, what it puts in the query, and what
// it does with a frame when one arrives. A relative URL here is the exact bug a
// static host produces, and it is invisible until the tab is opened on the site
// rather than under the harness.
const opened = hostile.sockets();
check('the room opened one socket', opened.length === 1, `${opened.length}`);
const wsUrl = new URL(String(opened[0]?.url || 'https://nope/'));
// The scheme becomes `wss` on the way; what matters is that the host is the API
// host and the page's own origin is not in the address anywhere.
check('and it dialled the API host, not the page',
  wsUrl.host === 'api.cheatlab.test' && wsUrl.protocol === 'wss:', String(opened[0]?.url));
check('addressing this room', wsUrl.pathname === `/api/chats/${channelId}/ws`, wsUrl.pathname);
check('with the room named in the query, so a mismatched path cannot be used',
  wsUrl.searchParams.get('id') === channelId, String(wsUrl.search));
check('and with a ticket that is not the session token',
  /^[A-Za-z0-9_-]{20,120}$/.test(wsUrl.searchParams.get('ticket') || '')
  && wsUrl.searchParams.get('ticket') !== token, String(wsUrl.search));

// A frame is how somebody else's message arrives. Delivering one exercises the
// same path the Durable Object drives, minus the socket.
const live = { t: 'msg', m: { id: 'frm000000000001', convId: channelId, userId: 'u_someoneelse', nick: 'другой', body: 'пришло по сокету', createdAt: Date.now() } };
opened[0].onmessage({ data: JSON.stringify(live) });
await hostile.settle();
check('a frame from the socket is shown', hostile.read().includes('пришло по сокету'), hostile.read().slice(-300));
// Two tabs, one room, and a reconnect that replays: the row must land once.
opened[0].onmessage({ data: JSON.stringify(live) });
await hostile.settle();
check('and the same frame twice is still one message',
  hostile.read().split('пришло по сокету').length === 2, `${hostile.read().split('пришло по сокету').length - 1}`);

/* ------------------------------------------------------------- the composer */

// Somebody typing is the only user of the composer who is doing nothing when a
// message arrives. The composer is rebuilt on every render, so a draft held only
// in the field would be destroyed by somebody else talking.
const typing = await boot(`/chat/${channelId}`, { client: 'e2eauthor0000001', session: token });
const typeInto = (page, value) => {
  const field = findAll(page.view, (el) => el.tagName === 'INPUT'
    && String((el.attributes || {}).id || '') === 'chat-input')[0];
  field.value = value;
  field.fire('input');
  return field;
};
const composerField = (page) => findAll(page.view, (el) => el.tagName === 'INPUT'
  && String((el.attributes || {}).id || '') === 'chat-input')[0];

typeInto(typing, 'черновик, который не должен пропасть');
check('the draft is there while typing', composerField(typing).value === 'черновик, который не должен пропасть',
  composerField(typing).value);
typing.sockets()[0].onmessage({ data: JSON.stringify({ t: 'msg', m: { id: 'frm000000000002', convId: channelId, userId: 'u_someoneelse', nick: 'другой', body: 'пока я пишу', createdAt: Date.now() } }) });
await typing.settle();
check('an arriving message does not take the draft with it',
  composerField(typing).value === 'черновик, который не должен пропасть', composerField(typing).value);
check('while the message itself is shown', typing.read().includes('пока я пишу'), typing.read().slice(-300));

// A send that is refused must leave the words where they were. Before this the
// restore wrote to the input node that the clearing render had already thrown
// away, so a send that failed lost the message silently - the worst possible
// moment to lose it, because the person had already decided it was worth saying.
//
// The failure is a dropped connection, not a rights refusal: this is a room the
// author can post in, and a browser can drop that post for a hundred reasons the
// server never heard about.
const offline = await boot(`/chat/${channelId}`, { client: 'e2eauthor0000001', session: token });
typeInto(offline, 'это не уйдёт');
offline.net.down = '/messages';
findAll(offline.view, (el) => el.tagName === 'FORM' && hasClass(el, 'chat-composer'))[0]
  .fire('submit', { preventDefault() {} });
await offline.settle();
check('a send that failed puts the words back', composerField(offline).value === 'это не уйдёт',
  composerField(offline).value);
check('and says so', /не отправлено|Failed|ошибк/i.test(offline.toast()), offline.toast());
const afterDrop = await as('e2eauthor0000001', `/api/chats/${channelId}`, { session: token });
check('while nothing was stored',
  !(afterDrop.json.messages || []).some((m) => m.body === 'это не уйдёт'),
  JSON.stringify((afterDrop.json.messages || []).map((m) => m.body)));

offline.net.down = '';
typeInto(offline, 'теперь уйдёт');
findAll(offline.view, (el) => el.tagName === 'FORM' && hasClass(el, 'chat-composer'))[0]
  .fire('submit', { preventDefault() {} });
await offline.settle();
check('and the retry goes through', composerField(offline).value === '', composerField(offline).value);
const afterRetry = await as('e2eauthor0000001', `/api/chats/${channelId}`, { session: token });
check('with the message stored this time',
  (afterRetry.json.messages || []).some((m) => m.body === 'теперь уйдёт'),
  JSON.stringify((afterRetry.json.messages || []).map((m) => m.body)));

/* ------------------------------------------------------- posts in slow motion */

// A post takes a round trip. Opening another conversation while one is in flight
// is ordinary, and the answer belongs to the room it was sent to - not to the
// room that happens to be open when it comes back.
const group = await as('e2eauthor0000001', '/api/chats', {
  method: 'POST', session: token, body: { kind: 'group', title: 'Другая беседа' },
});
if (group.status !== 201) throw new Error(`seed: group ${group.status} ${group.text}`);
const otherId = group.json.chat.id;

const wanderer = await boot(`/chat/${channelId}`, { client: 'e2eauthor0000001', session: token });
wanderer.net.hold = '/messages';
typeInto(wanderer, 'это уйдёт в первый разговор');
findAll(wanderer.view, (el) => el.tagName === 'FORM' && hasClass(el, 'chat-composer'))[0]
  .fire('submit', { preventDefault() {} });
await new Promise((r) => setTimeout(r, 60));
wanderer.go(`/chat/${otherId}`);
await wanderer.settle();
check('the reader is now in the other conversation',
  wanderer.read().includes('Другая беседа'), wanderer.read().slice(0, 200));
wanderer.net.release();
await wanderer.settle();
check('and the late answer did not land in it',
  !wanderer.read().includes('это уйдёт в первый разговор'), wanderer.read().slice(-400));
const firstRoom = await as('e2eauthor0000001', `/api/chats/${channelId}`, { session: token });
check('while it did go to the room it was sent to',
  (firstRoom.json.messages || []).some((m) => m.body === 'это уйдёт в первый разговор'),
  JSON.stringify((firstRoom.json.messages || []).map((m) => m.body)));
const wandered = await boot(`/chat/${otherId}`, { client: 'e2eauthor0000001', session: token });
check('and reloading that room shows no trace of it',
  !wandered.read().includes('это уйдёт в первый разговор'), wandered.read().slice(-400));

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
if (failures.length) process.exitCode = 1;
