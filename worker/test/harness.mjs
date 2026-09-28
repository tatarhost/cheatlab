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
 * list-by-prefix and get, where get returns an ArrayBuffer and honours an
 * offset/length range. Returning an ArrayBuffer rather than a stream is
 * deliberate - it is what the shim hands to Response, so a body that works here
 * works on the platform.
 */
class KvShim {
  constructor() {
    this.map = new Map();
  }

  async put(key, value) {
    this.map.set(key, new Uint8Array(value));
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
    if (!v) return null;
    const range = opts && typeof opts === 'object' ? opts.range : null;
    if (!range) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    const slice = v.subarray(range.offset, range.offset + range.length);
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
  }
}

/* --------------------------------------------------------------------- env */

export function makeEnv(overrides = {}) {
  return {
    DB: new D1Shim(),
    BUCKET: new KvShim(),
    MAX_FILE_MB: '24',
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
