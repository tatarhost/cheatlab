import { Store } from './store.js';
import { BlobStore } from './blobs.js';
import { PluginHost } from './plugins.js';
import {
  newId, newSecret, secretHash, secretMatches, normaliseClientId, authorTag,
  str, tags, clamp, safeFilename, mimeOf, isTextExt, extOf, now, sha256,
} from './util.js';

const TYPES = new Set(['script', 'paste', 'app', 'image', 'video', 'file']);
const VISIBILITY = new Set(['public', 'unlisted']);
const LANGUAGES = [
  'luau', 'lua', 'python', 'javascript', 'typescript', 'csharp', 'cpp', 'c',
  'java', 'kotlin', 'swift', 'bash', 'powershell', 'html', 'css', 'json',
  'yaml', 'sql', 'glsl', 'text',
];

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function config(env) {
  return {
    maxFileBytes: Number(env.MAX_FILE_MB || 25) * 1024 * 1024,
    maxTextBytes: Number(env.MAX_TEXT_KB || 256) * 1024,
    maxFilesPerItem: Number(env.MAX_FILES || 20),
    titleMax: Number(env.TITLE_MAX || 120),
    labelMax: Number(env.LABEL_MAX || 24),
    writeCap: Number(env.WRITE_CAP || 30),
    readCap: Number(env.READ_CAP || 240),
    allowOrigin: env.ALLOW_ORIGIN || '*',
  };
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });

const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

function clientOf(request) {
  return normaliseClientId(request.headers.get('x-cheatlab-client'));
}

function ctxOf(request, env) {
  return { request, client: clientOf(request), env };
}

function decodeHeaderName(value) {
  if (!value) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

async function readJson(request, limit) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) {
    const err = new Error('payload too large');
    err.code = 'TOO_LARGE';
    throw err;
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > limit) {
    const err = new Error('payload too large');
    err.code = 'TOO_LARGE';
    throw err;
  }
  if (!raw.byteLength) return {};
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    const err = new Error('invalid json');
    err.code = 'BAD_JSON';
    throw err;
  }
}

function publicItem(row, files, tag) {
  if (!row) return null;
  const base = {
    id: row.id,
    type: row.type,
    title: row.title,
    language: row.language,
    tags: row.tags ? row.tags.split(' ') : [],
    author: tag,
    authorLabel: row.author_label || null,
    visibility: row.visibility,
    hits: row.hits,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    files: files.map(({ id, name, size, mime, sha256, downloads, createdAt }) => ({
      id, name, size, mime, sha256: sha256.slice(0, 16), downloads, createdAt,
    })),
    fileSize: files.reduce((a, f) => a + f.size, 0),
  };
  return base;
}

/** Two-step: files + hashed author tag are both async now. */
async function itemView(store, row, { full = false } = {}) {
  if (!row) return null;
  const files = await store.listFiles(row.id);
  const tag = await authorTag(row.author);
  const base = publicItem(row, files, tag);
  if (full) base.body = row.body;
  else base.preview = row.body.slice(0, 240);
  return base;
}

async function ownSecret(request, row) {
  const secret = request.headers.get('x-cheatlab-secret');
  return secretMatches(secret, row.secret_hash);
}

/* ------------------------------------------------------------------ routes */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/config$/, async (request, env) => {
  const c = config(env);
  return json({
    name: 'CHEATLAB',
    types: [...TYPES],
    languages: LANGUAGES,
    limits: {
      maxFileBytes: c.maxFileBytes,
      maxTextBytes: c.maxTextBytes,
      maxFilesPerItem: c.maxFilesPerItem,
      titleMax: c.titleMax,
    },
    auth: 'device',
    plugins: env.PLUGINS.describe(),
  });
});

route('GET', /^\/api\/stats$/, async (_r, env) => json(await env.STORE.stats()));

route('GET', /^\/api\/plugins$/, async (_r, env) => json(env.PLUGINS.describe()));

route('GET', /^\/api\/me$/, async (request, env) => {
  const id = clientOf(request);
  if (!id) return fail(401, 'missing client id');
  const { STORE } = env;
  await STORE.touchClient(id);
  const mine = await STORE.listItems({ author: id, limit: 100 });
  const items = await Promise.all(mine.items.map((row) => itemView(STORE, row)));
  return json({
    author: await authorTag(id),
    items,
    files: await STORE.filesOfAuthor(id),
  });
});

route('GET', /^\/api\/items$/, async (request, env, _m, url) => {
  const { STORE } = env;
  const c = config(env);
  const key = clientOf(request) || url.pathname;
  if (!(await STORE.throttle(key, 'read', { cap: c.readCap, windowMs: 60_000 }))) {
    return fail(429, 'slow down');
  }
  const q = url.searchParams;
  const type = q.get('type') || '';
  if (type && !TYPES.has(type)) return fail(400, 'unknown type');
  const { items, total } = await STORE.listItems({
    type,
    q: str(q.get('q'), 80),
    tag: str(q.get('tag'), 24).toLowerCase(),
    author: str(q.get('author'), 64),
    sort: ['new', 'hot', 'old'].includes(q.get('sort')) ? q.get('sort') : 'new',
    limit: clamp(Number(q.get('limit')) || 30, 1, 60),
    offset: Math.max(0, Number(q.get('offset')) || 0),
  });
  return json({ total, items: await Promise.all(items.map((row) => itemView(STORE, row))) });
});

route('POST', /^\/api\/items$/, async (request, env) => {
  const { STORE } = env;
  const c = config(env);
  const id = clientOf(request);
  if (!id) return fail(401, 'missing client id');
  if (!(await STORE.throttle(id, 'write', { cap: c.writeCap, windowMs: 60_000 }))) {
    return fail(429, 'write limit reached, try later');
  }

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  const type = TYPES.has(payload.type) ? payload.type : 'paste';
  const title = str(payload.title, c.titleMax);
  if (!title) return fail(400, 'title is required');
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (new TextEncoder().encode(body).byteLength > c.maxTextBytes) return fail(413, 'body too large');

  const draft = {
    type,
    title,
    body,
    language: LANGUAGES.includes(payload.language) ? payload.language : 'text',
    tags: tags(payload.tags),
    visibility: VISIBILITY.has(payload.visibility) ? payload.visibility : 'public',
  };

  const { value, rejections } = await env.PLUGINS.run('item:create', draft, ctxOf(request, env));
  if (rejections.length) return fail(422, 'rejected', { reasons: rejections });

  const secret = newSecret();
  const t = now();
  const row = await STORE.createItem({
    id: newId(8),
    ...value,
    tags: value.tags.join(' '),
    author: id,
    author_label: str(payload.authorLabel, c.labelMax),
    secret_hash: await secretHash(secret),
    created_at: t,
    updated_at: t,
  });

  await STORE.touchClient(id);
  const view = await itemView(STORE, row, { full: true });
  await env.PLUGINS.run('item:published', view, ctxOf(request, env));
  return json({ item: view, secret }, 201);
});

route('GET', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (_r, env, m) => {
  const row = await env.STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  await env.STORE.incItemHits(m[1]);
  return json({ item: await itemView(env.STORE, await env.STORE.getItem(m[1]), { full: true }) });
});

route('PATCH', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const { STORE } = env;
  const c = config(env);
  const row = await STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  if (!(await ownSecret(request, row))) return fail(403, 'edit secret required');
  if (!(await STORE.throttle(clientOf(request) || 'anon', 'write', { cap: c.writeCap, windowMs: 60_000 }))) {
    return fail(429, 'write limit reached, try later');
  }

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  const patch = { updated_at: now() };
  if (payload.title !== undefined) {
    const title = str(payload.title, c.titleMax);
    if (!title) return fail(400, 'title is required');
    patch.title = title;
  }
  if (payload.body !== undefined) {
    if (typeof payload.body !== 'string' || new TextEncoder().encode(payload.body).byteLength > c.maxTextBytes) {
      return fail(413, 'body too large');
    }
    patch.body = payload.body;
  }
  if (payload.type !== undefined && TYPES.has(payload.type)) patch.type = payload.type;
  if (payload.language !== undefined && LANGUAGES.includes(payload.language)) patch.language = payload.language;
  if (payload.tags !== undefined) patch.tags = tags(payload.tags).join(' ');
  if (payload.visibility !== undefined && VISIBILITY.has(payload.visibility)) patch.visibility = payload.visibility;

  const updated = await STORE.updateItem(m[1], patch);
  const view = await itemView(STORE, updated, { full: true });
  await env.PLUGINS.run('item:update', view, ctxOf(request, env));
  return json({ item: view });
});

route('DELETE', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const { STORE, BLOBS } = env;
  const row = await STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  if (!(await ownSecret(request, row))) return fail(403, 'edit secret required');

  // snapshot before the files are gone, so the plugin still sees the full item
  const before = await itemView(STORE, row);

  for (const f of await STORE.listFiles(m[1])) {
    await STORE.deleteFile(f.id);
    if ((await STORE.otherRefsToSha(f.sha256, f.id)) === 0) await BLOBS.remove(f.sha256);
  }
  await STORE.deleteItem(m[1]);
  await env.PLUGINS.run('item:delete', before, ctxOf(request, env));
  return json({ ok: true });
});

route('POST', /^\/api\/items\/([A-Za-z0-9]{4,16})\/files$/, async (request, env, m) => {
  const { STORE, BLOBS } = env;
  const c = config(env);
  const row = await STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  const client = clientOf(request);
  if (row.author !== client) return fail(403, 'not the author');
  if (!(await STORE.throttle(client || 'anon', 'write', { cap: c.writeCap, windowMs: 60_000 }))) {
    return fail(429, 'write limit reached, try later');
  }
  if ((await STORE.listFiles(m[1])).length >= c.maxFilesPerItem) {
    return fail(409, 'file limit reached for this item');
  }

  const name = safeFilename(decodeHeaderName(request.headers.get('x-filename')));
  const file = { id: newId(10), item_id: m[1], name, mime: mimeOf(name), size: 0, sha256: '', author: client, created_at: now() };

  const { value, rejections } = await env.PLUGINS.run('file:upload', file, ctxOf(request, env));
  if (rejections.length) return fail(422, 'rejected', { reasons: rejections });
  if (!value.name) return fail(400, 'invalid filename');

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > c.maxFileBytes) return fail(413, 'file too large', { maxBytes: c.maxFileBytes });

  let buffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return fail(413, 'file too large', { maxBytes: c.maxFileBytes });
  }
  if (buffer.byteLength === 0) return fail(400, 'empty file');
  if (buffer.byteLength > c.maxFileBytes) return fail(413, 'file too large', { maxBytes: c.maxFileBytes });

  const sha = await sha256(buffer);
  const stored = await BLOBS.put(buffer, sha);
  Object.assign(value, { size: stored.size, sha256: sha, mime: mimeOf(value.name) });
  const saved = await STORE.addFile(value);

  const after = await env.PLUGINS.run('file:stored', saved, ctxOf(request, env));
  if (after.rejections.length) {
    await STORE.deleteFile(saved.id);
    if ((await STORE.otherRefsToSha(saved.sha256, saved.id)) === 0) await BLOBS.remove(saved.sha256);
    return fail(422, 'rejected', { reasons: after.rejections });
  }

  await STORE.updateItem(m[1], { updated_at: now() });
  return json({ file: { id: saved.id, name: saved.name, size: saved.size, mime: saved.mime, downloads: 0 } }, 201);
});

route('DELETE', /^\/api\/files\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const { STORE, BLOBS } = env;
  const file = await STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  const row = await STORE.getItem(file.itemId);
  if (!row) return fail(404, 'not found');
  if (!(await ownSecret(request, row))) return fail(403, 'edit secret required');

  await STORE.deleteFile(m[1]);
  if ((await STORE.otherRefsToSha(file.sha256, m[1])) === 0) await BLOBS.remove(file.sha256);
  await env.PLUGINS.run('file:delete', file, ctxOf(request, env));
  return json({ ok: true });
});

/* ------------------------------------------------------------ file serving */

function dispositionFor(file, inline) {
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
}

/** Text must never be sniffed as HTML, so non-text inline types are forced to octet-stream. */
function serveType(file, inline) {
  if (inline && !isTextExt(extOf(file.name))) return 'application/octet-stream';
  return file.mime;
}

async function serveFile(request, env, file, { inline }) {
  const etag = `"${file.sha256}"`;
  const headers = {
    'Content-Type': serveType(file, inline),
    'Content-Disposition': dispositionFor(file, inline),
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'Accept-Ranges': 'bytes',
    ...SECURITY_HEADERS,
  };

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': headers['Cache-Control'] } });
  }
  if (!inline) await env.STORE.incFileDownloads(file.id);

  // Explicit range handling: required for video seeking, and clearer than
  // depending on R2's implicit range behaviour.
  const range = request.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    const size = file.size;
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; }
    if (start === null) start = 0;
    if (end === null || end >= size) end = size - 1;
    if (start <= end && start < size) {
      const object = await env.BLOBS.get(file.sha256, { range: { offset: start, length: end - start + 1 } });
      if (object) {
        return new Response(object.body, {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }
    }
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${file.size}` },
    });
  }

  const object = await env.BLOBS.get(file.sha256);
  if (!object) return fail(404, 'file content missing');
  return new Response(object.body, { status: 200, headers: { ...headers, 'Content-Length': String(file.size) } });
}

route('GET', /^\/f\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const file = await env.STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  return serveFile(request, env, file, { inline: false });
});

route('GET', /^\/f\/([A-Za-z0-9]{4,16})\/raw$/, async (request, env, m) => {
  const file = await env.STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  return serveFile(request, env, file, { inline: true });
});

/** Media needs a renderable Content-Type, so raw media is served apart from text. */
route('GET', /^\/m\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const file = await env.STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  const etag = `"${file.sha256}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  await env.STORE.incFileDownloads(file.id);
  const range = request.headers.get('range');
  if (range) return serveFile(request, env, file, { inline: true });
  const object = await env.BLOBS.get(file.sha256);
  if (!object) return fail(404, 'file content missing');
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': file.mime,
      'Content-Disposition': 'inline',
      'Content-Length': String(file.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      'Accept-Ranges': 'bytes',
      ...SECURITY_HEADERS,
    },
  });
});

route('GET', /^\/r\/([A-Za-z0-9]{4,16})$/, async (_r, env, m) => {
  const row = await env.STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  await env.STORE.incItemHits(m[1]);
  return new Response(row.body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
});

route('GET', /^\/$/, async (_r, env) => json({
  service: 'CHEATLAB API',
  docs: 'https://github.com/tatarhost/cheatlab',
  types: [...TYPES],
  endpoints: routes.map((r) => `${r.method} ${r.pattern.source}`),
}));

/* ------------------------------------------------------------------ worker */

/**
 * Custom request headers the site and the embed widget send. A cross-origin
 * request carrying any of these is preflighted, so the preflight response has to
 * echo them back or every write is rejected before it reaches a handler.
 */
const ALLOWED_HEADERS = 'content-type, x-cheatlab-client, x-cheatlab-secret, x-filename';
const ALLOWED_METHODS = 'GET, HEAD, POST, PATCH, DELETE, OPTIONS';

function withCors(response, origin, preflight) {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Vary', 'Origin');
  if (preflight) {
    h.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
    h.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    h.set('Access-Control-Max-Age', '86400');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

/**
 * Workers have no process startup, so the plugin host is built once per isolate
 * on the first request. Module scope is per-isolate, so this cannot leak across
 * tenants and costs one dynamic import per cold start.
 */
let pluginHost = null;

export default {
  async fetch(request, rawEnv) {
    if (!pluginHost) pluginHost = await new PluginHost().load(rawEnv);
    const env = {
      ...rawEnv,
      STORE: new Store(rawEnv.DB),
      BLOBS: new BlobStore(rawEnv.BUCKET),
      PLUGINS: pluginHost,
    };
    const origin = config(env).allowOrigin;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), origin, true);
    }

    const method = request.method === 'HEAD' ? 'GET' : request.method;

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/f/') || url.pathname.startsWith('/r/') || url.pathname.startsWith('/m/') || url.pathname === '/') {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        try {
          return withCors(await r.handler(request, env, m, url), origin);
        } catch (err) {
          return withCors(fail(500, 'server error', { detail: err.message }), origin);
        }
      }
      return withCors(fail(404, 'no such endpoint'), origin);
    }

    return withCors(fail(404, 'no such endpoint'), origin);
  },

  /** Cron trigger: age out the throttle table. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(new Store(env.DB).sweepRate());
  },
};
