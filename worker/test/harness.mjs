/**
 * Local verification harness for the Worker.
 *
 * Workers cannot be run without `wrangler`, but the port can still be verified
 * end to end by standing in two bindings:
 *   - D1 -> node:sqlite with a statement-compatible adapter
 *   - KV -> an in-memory namespace honouring prefix list and offset/length ranges
 *
 * This exercises the real fetch() handler and the real SQL, so route wiring,
 * rate limiting, secret checks and range serving are all covered.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------- D1 shim */

class D1Shim {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(join(HERE, '..', 'schema.sql'), 'utf8'));
  }

  prepare(sql) {
    const db = this.db;
    let stmt = null;
    let bound = [];
    const compile = () => (stmt ||= db.prepare(sql));
    return {
      bind(...vals) {
        bound = vals;
        return this;
      },
      async first() {
        const row = compile().get(...bound);
        return row ? { ...row } : null;
      },
      async all() {
        return { results: compile().all(...bound).map((r) => ({ ...r })), success: true };
      },
      async run() {
        const r = compile().run(...bound);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
    };
  }
}

/* -------------------------------------------------------------------- KV shim */

/**
 * Mirrors the slice of the Workers KV surface BlobStore uses: put, delete,
 * list-by-prefix and get, where get returns an ArrayBuffer for a binary value
 * and honours an offset/length range.
 *
 * The text case is here because the platform really does distinguish the two: a
 * value stored as a string comes back as a string from a plain `get`, and only
 * `get(key, 'text')` stringifies a binary one. A shim that always returned an
 * ArrayBuffer would quietly let a string-vs-bytes bug through, since
 * `String(arrayBuffer)` yields "[object ArrayBuffer]" rather than the JSON that
 * was actually stored.
 */
class KvShim {
  constructor() {
    this.map = new Map();
  }

  async put(key, value) {
    this.map.set(key, value);
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list({ prefix = '', limit } = {}) {
    const keys = [];
    for (const name of this.map.keys()) {
      if (name.startsWith(prefix)) keys.push({ name });
    }
    keys.sort();
    return { keys: limit ? keys.slice(0, limit) : keys };
  }

  async get(key, opts) {
    const v = this.map.get(key);
    if (v === undefined || v === null) return null;
    const wantsText = opts === 'text' || (opts && typeof opts === 'object' && opts.type === 'text');
    if (typeof v === 'string') {
      // The platform has no range option for text values, so neither does this.
      if (wantsText || !opts) return v;
      return new TextEncoder().encode(v).buffer;
    }
    const range = opts && typeof opts === 'object' ? opts.range : null;
    const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
    if (wantsText) return new TextDecoder().decode(bytes);
    if (!range) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const slice = bytes.subarray(range.offset, range.offset + range.length);
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  }
}

/* --------------------------------------------------------------------- env */

export function makeEnv(overrides = {}) {
  return {
    DB: new D1Shim(),
    BUCKET: new KvShim(),
    MAX_FILE_MB: '50',
    MAX_TEXT_KB: '256',
    MAX_FILES: '60',
    TITLE_MAX: '120',
    LABEL_MAX: '24',
    WRITE_CAP: '90',
    READ_CAP: '240',
    ALLOW_ORIGIN: '*',
    SITE_URL: 'https://tatarhost.github.io/cheatlab',
    DENY_EXT: '',
    DENY_SHA: '',
    WEBHOOK_URL: '',
    // Signs captcha handles. Set as a Worker secret in production; present here
    // so the tests exercise the real signed path rather than the fallback.
    CAPTCHA_SECRET: 'test-captcha-secret',
    // Tests must not pay 4M hashes per proof of work. 8 bits is ~256 hashes, so
    // the same code path runs and the assertions still mean something. The
    // production value lives in wrangler.toml.
    POW_BITS: '8',
    // The shipped daily caps. A suite that publishes many items raises these
    // explicitly so an unrelated test is not blocked by the anti-abuse policy.
    ANON_NEW_ITEMS_PER_DAY: '1',
    REG_NEW_ITEMS_PER_DAY: '12',
    ...overrides,
  };
}

const clientId = 'testclient0123456789abcdef';

export function request(path, opts = {}) {
  const { method = 'GET', body, headers = {}, id, client, secret, session } = opts;
  const h = new Headers(headers);
  // `client` reads better at call sites that create a second identity; `id` is
  // the historical name. An explicit `id: null` means "send no client header",
  // which several tests rely on, so a present-but-falsy value must not fall back
  // to the default client.
  const clientHeader = 'id' in opts ? id : (client || clientId);
  if (clientHeader) h.set('x-cheatlab-client', clientHeader);
  if (secret) h.set('x-cheatlab-secret', secret);
  if (session) h.set('x-cheatlab-session', session);
  return new Request(`https://api.cheatlab.test${path}`, {
    method,
    headers: h,
    // An object body is JSON-encoded here, matching how the app sends one. Only
    // fall back to raw bytes for callers passing a binary payload (uploads).
    body: body === undefined
      ? undefined
      : typeof body === 'string'
        ? body
        : body instanceof Uint8Array || body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : JSON.stringify(body),
  });
}

/**
 * Solves the arithmetic question the server actually asked.
 *
 * The answer is no longer in the token - the Worker keeps it in D1 - so a test
 * that wants to publish anonymously has to do the same work a person does. This
 * is also the check that the CAPTCHA still means something: if the questions
 * become non-arithmetic, this fails loudly rather than silently passing.
 */
export function answerQuestion(q) {
  const m = /(\d+)\s*\*\s*(\d+)\s*([+-])\s*(\d+)/.exec(q);
  if (m) {
    const [, a, b, op, c] = m;
    const product = Number(a) * Number(b);
    return String(op === '+' ? product + Number(c) : product - Number(c));
  }
  const letters = /«(.+)»/.exec(q);
  if (letters) return String([...letters[1]].length);
  throw new Error(`cannot solve captcha question: ${q}`);
}

/**
 * Fetches a captcha and returns the token plus the answer the Worker expects.
 * Exported so suites that are not testing the captcha itself can still publish
 * anonymously, and so the auth suite can assert on the real challenge.
 */
export async function solveCaptcha(worker, env, opts = {}) {
  // `autoCaptcha` is dropped and the method forced to GET: leaving it in place
  // would have this function ask itself for a captcha to answer a captcha.
  const res = await call(worker, env, '/api/auth/captcha', { ...opts, method: 'GET', autoCaptcha: false, body: undefined });
  if (res.status !== 200) throw new Error(`captcha endpoint returned ${res.status}`);
  const { token, q } = res.json;
  return { token, answer: answerQuestion(q), question: q };
}

/**
 * With `autoCaptcha`, a POST that carries no captcha token gets one solved and
 * attached before the request goes out. Used by the pre-existing suite, whose
 * subject is media and range serving rather than the anti-abuse policy, so it
 * does not have to re-implement the challenge for every publish.
 */
export async function call(worker, env, path, opts = {}) {
  let body = opts.body;
  if (opts.autoCaptcha && (opts.method || 'GET') === 'POST' && !opts.session) {
    const c = await solveCaptcha(worker, env, opts);
    const parsed = typeof body === 'string' ? JSON.parse(body || '{}') : { ...(body || {}) };
    body = { ...parsed, captchaToken: c.token, captchaAnswer: c.answer };
  }
  const res = await worker.fetch(request(path, { ...opts, body }), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not a json endpoint */ }
  return { res, text, json, status: res.status };
}
