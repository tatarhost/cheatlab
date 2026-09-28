/**
 * Local verification harness for the Worker.
 *
 * Workers cannot be run without `wrangler`, but the port can still be verified
 * end to end by standing in two bindings:
 *   - D1   -> node:sqlite with a statement-compatible adapter
 *   - R2   -> an in-memory bucket that honours offset/length ranges
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

/* ------------------------------------------------------------------- R2 shim */

class R2Shim {
  constructor() {
    this.map = new Map();
  }

  static key(sha) {
    return `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  }

  async head(key) {
    const v = this.map.get(key);
    return v ? { size: v.byteLength } : null;
  }

  async put(key, value) {
    this.map.set(key, new Uint8Array(value));
  }

  async get(key, { range } = {}) {
    const v = this.map.get(key);
    if (!v) return null;
    if (!range) return { body: v, size: v.byteLength };
    const slice = v.subarray(range.offset, range.offset + range.length);
    return { body: slice, size: slice.byteLength };
  }

  async delete(key) {
    this.map.delete(key);
  }
}

/* --------------------------------------------------------------------- env */

export function makeEnv(overrides = {}) {
  return {
    DB: new D1Shim(),
    BUCKET: new R2Shim(),
    MAX_FILE_MB: '25',
    MAX_TEXT_KB: '256',
    MAX_FILES: '20',
    TITLE_MAX: '120',
    LABEL_MAX: '24',
    WRITE_CAP: '30',
    READ_CAP: '240',
    ALLOW_ORIGIN: '*',
    SITE_URL: 'https://tatarhost.github.io/cheatlab',
    DENY_EXT: '',
    DENY_SHA: '',
    WEBHOOK_URL: '',
    ...overrides,
  };
}

const clientId = 'testclient0123456789abcdef';

export function request(path, { method = 'GET', body, headers = {}, id = clientId, secret } = {}) {
  const h = new Headers(headers);
  if (id) h.set('x-cheatlab-client', id);
  if (secret) h.set('x-cheatlab-secret', secret);
  return new Request(`https://api.cheatlab.test${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : new Uint8Array(body)),
  });
}

export async function call(worker, env, path, opts) {
  const res = await worker.fetch(request(path, opts), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not a json endpoint */ }
  return { res, text, json, status: res.status };
}
