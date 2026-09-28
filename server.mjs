import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { Store } from './lib/store.mjs';
import { BlobStore } from './lib/blobs.mjs';
import { PluginHost } from './lib/plugins.mjs';
import {
  newId, newSecret, secretHash, secretMatches, normaliseClientId,
  str, tags, clamp, safeFilename, mimeOf, formatBytes, isTextExt, now,
} from './lib/util.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = process.env.CL_DATA_DIR || join(ROOT, 'data');

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  maxFileBytes: Number(process.env.CL_MAX_FILE_MB || 25) * 1024 * 1024,
  maxTextBytes: Number(process.env.CL_MAX_TEXT_KB || 256) * 1024,
  maxFilesPerItem: Number(process.env.CL_MAX_FILES || 20),
  titleMax: 120,
  labelMax: 24,
  writeRate: { cap: 30, refillPerSec: 30 / 60 },  // 30 writes per minute per client
  readRate: { cap: 240, refillPerSec: 240 / 60 },
};

const TYPES = new Set(['script', 'paste', 'app']);
const VISIBILITY = new Set(['public', 'unlisted']);
const LANGUAGES = [
  'luau', 'lua', 'python', 'javascript', 'typescript', 'csharp', 'cpp', 'c',
  'java', 'kotlin', 'swift', 'bash', 'powershell', 'html', 'css', 'json',
  'yaml', 'sql', 'glsl', 'text',
];

const store = new Store(DATA_DIR);
const blobs = new BlobStore(join(DATA_DIR, 'blobs'));
await blobs.init();
const plugins = await new PluginHost(join(ROOT, 'plugins')).load();

const buckets = new Map();

function allow(key, { cap, refillPerSec }) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: cap, ts: t }; buckets.set(key, b); }
  b.tokens = Math.min(cap, b.tokens + ((t - b.ts) / 1000) * refillPerSec);
  b.ts = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
}, 60_000).unref();

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

function send(res, status, body, headers = {}) {
  const payload = body === undefined || body === null ? '' : body;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  res.writeHead(status, {
    'Content-Length': buf.length,
    ...SECURITY_HEADERS,
    ...headers,
  });
  if (res.req?.method === 'HEAD') return res.end();
  res.end(buf);
}

const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

const fail = (res, status, error, extra = {}) => sendJson(res, status, { error, ...extra });

function readBody(req, limit) {
  return new Promise((resolve, reject_) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c) => {
      if (overflow) return;
      size += c.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        const err = new Error('payload too large');
        err.code = 'TOO_LARGE';
        reject_(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!overflow) resolve(Buffer.concat(chunks)); });
    req.on('error', reject_);
  });
}

async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error('invalid json');
    err.code = 'BAD_JSON';
    throw err;
  }
}

function clientOf(req) {
  return normaliseClientId(req.headers['x-cheatlab-client']);
}

function ctxOf(req) {
  return { ip: req.socket.remoteAddress || '', req, client: clientOf(req) };
}

const authorTag = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 6);

function decodeHeaderName(value) {
  if (typeof value !== 'string') return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

function publicItem(row, { full = false } = {}) {
  if (!row) return null;
  const files = store.listFiles(row.id);
  const base = {
    id: row.id,
    type: row.type,
    title: row.title,
    language: row.language,
    tags: row.tags ? row.tags.split(' ') : [],
    author: authorTag(row.author),
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
  if (full) base.body = row.body;
  else base.preview = row.body.slice(0, 240);
  return base;
}

function ownItem(req, res, row) {
  const id = clientOf(req);
  if (!id) { fail(res, 401, 'missing client id'); return false; }
  if (row.author !== id) { fail(res, 403, 'not the author'); return false; }
  return true;
}

function ownSecret(req, res, row) {
  const secret = req.headers['x-cheatlab-secret'];
  if (typeof secret !== 'string' || !secretMatches(secret, row.secret_hash)) {
    fail(res, 403, 'edit secret required');
    return false;
  }
  return true;
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/config$/, async (req, res) => {
  sendJson(res, 200, {
    name: 'CHEATLAB',
    types: [...TYPES],
    languages: LANGUAGES,
    limits: {
      maxFileBytes: CONFIG.maxFileBytes,
      maxTextBytes: CONFIG.maxTextBytes,
      maxFilesPerItem: CONFIG.maxFilesPerItem,
      titleMax: CONFIG.titleMax,
    },
    auth: 'device',
    plugins: plugins.describe(),
  });
});

route('GET', /^\/api\/stats$/, async (req, res) => sendJson(res, 200, store.stats()));

route('GET', /^\/api\/plugins$/, async (req, res) => sendJson(res, 200, plugins.describe()));

route('GET', /^\/api\/me$/, async (req, res) => {
  const id = clientOf(req);
  if (!id) return fail(res, 401, 'missing client id');
  store.touchClient(id);
  const mine = store.listItems({ author: id, limit: 100 });
  sendJson(res, 200, {
    author: authorTag(id),
    items: mine.items.map((r) => publicItem(r)),
    files: store.filesOfAuthor(id),
  });
});

route('GET', /^\/api\/items$/, async (req, res, _m, url) => {
  if (!allow(`r:${clientOf(req) || req.socket.remoteAddress}`, CONFIG.readRate)) return fail(res, 429, 'slow down');
  const q = url.searchParams;
  const type = q.get('type') || '';
  if (type && !TYPES.has(type)) return fail(res, 400, 'unknown type');
  const { items, total } = store.listItems({
    type,
    q: str(q.get('q'), 80),
    tag: str(q.get('tag'), 24).toLowerCase(),
    author: str(q.get('author'), 64),
    sort: ['new', 'hot', 'old'].includes(q.get('sort')) ? q.get('sort') : 'new',
    limit: clamp(Number(q.get('limit')) || 30, 1, 60),
    offset: Math.max(0, Number(q.get('offset')) || 0),
  });
  sendJson(res, 200, { total, items: items.map((r) => publicItem(r)) });
});

route('POST', /^\/api\/items$/, async (req, res) => {
  const id = clientOf(req);
  if (!id) return fail(res, 401, 'missing client id');
  if (!allow(`w:${id}`, CONFIG.writeRate)) return fail(res, 429, 'write limit reached, try later');

  let payload;
  try {
    payload = await readJson(req, CONFIG.maxTextBytes);
  } catch (err) {
    return fail(res, err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  const type = TYPES.has(payload.type) ? payload.type : 'paste';
  const title = str(payload.title, CONFIG.titleMax);
  if (!title) return fail(res, 400, 'title is required');
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (Buffer.byteLength(body) > CONFIG.maxTextBytes) return fail(res, 413, 'body too large');

  const draft = {
    type,
    title,
    body,
    language: LANGUAGES.includes(payload.language) ? payload.language : 'text',
    tags: tags(payload.tags),
    visibility: VISIBILITY.has(payload.visibility) ? payload.visibility : 'public',
  };

  const { value, rejections } = await plugins.run('item:create', draft, ctxOf(req));
  if (rejections.length) return fail(res, 422, 'rejected', { reasons: rejections });

  const secret = newSecret();
  const t = now();
  const row = store.createItem({
    id: newId(8),
    ...value,
    tags: value.tags.join(' '),
    author: id,
    author_label: str(payload.authorLabel, CONFIG.labelMax),
    secret_hash: secretHash(secret),
    created_at: t,
    updated_at: t,
  });
  store.touchClient(id);

  await plugins.run('item:published', publicItem(row), ctxOf(req));
  sendJson(res, 201, { item: publicItem(row, { full: true }), secret });
});

route('GET', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (req, res, m) => {
  const row = store.getItem(m[1]);
  if (!row) return fail(res, 404, 'not found');
  store.incItemHits(m[1]);
  sendJson(res, 200, { item: publicItem(store.getItem(m[1]), { full: true }) });
});

route('PATCH', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (req, res, m) => {
  const row = store.getItem(m[1]);
  if (!row) return fail(res, 404, 'not found');
  if (!ownSecret(req, res, row)) return;
  if (!allow(`w:${clientOf(req)}`, CONFIG.writeRate)) return fail(res, 429, 'write limit reached, try later');

  let payload;
  try {
    payload = await readJson(req, CONFIG.maxTextBytes);
  } catch (err) {
    return fail(res, err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  const patch = { updated_at: now() };
  if (payload.title !== undefined) {
    const title = str(payload.title, CONFIG.titleMax);
    if (!title) return fail(res, 400, 'title is required');
    patch.title = title;
  }
  if (payload.body !== undefined) {
    if (typeof payload.body !== 'string' || Buffer.byteLength(payload.body) > CONFIG.maxTextBytes) return fail(res, 413, 'body too large');
    patch.body = payload.body;
  }
  if (payload.language !== undefined && LANGUAGES.includes(payload.language)) patch.language = payload.language;
  if (payload.tags !== undefined) patch.tags = tags(payload.tags).join(' ');
  if (payload.visibility !== undefined && VISIBILITY.has(payload.visibility)) patch.visibility = payload.visibility;

  const updated = store.updateItem(m[1], patch);
  await plugins.run('item:update', publicItem(updated, { full: true }), ctxOf(req));
  sendJson(res, 200, { item: publicItem(updated, { full: true }) });
});

route('DELETE', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (req, res, m) => {
  const row = store.getItem(m[1]);
  if (!row) return fail(res, 404, 'not found');
  if (!ownSecret(req, res, row)) return;
  for (const f of store.listFiles(m[1])) {
    store.deleteFile(f.id);
    if (store.otherRefsToSha(f.sha256, f.id) === 0) await blobs.remove(f.sha256);
  }
  store.deleteItem(m[1]);
  await plugins.run('item:delete', publicItem(row), ctxOf(req));
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/items\/([A-Za-z0-9]{4,16})\/files$/, async (req, res, m) => {
  const row = store.getItem(m[1]);
  if (!row) return fail(res, 404, 'not found');
  const client = clientOf(req);
  if (row.author !== client) return fail(res, 403, 'not the author');
  if (!allow(`w:${client}`, CONFIG.writeRate)) return fail(res, 429, 'write limit reached, try later');
  if (store.listFiles(m[1]).length >= CONFIG.maxFilesPerItem) return fail(res, 409, 'file limit reached for this item');

  const name = safeFilename(decodeHeaderName(req.headers['x-filename']));
  const file = { id: newId(10), item_id: m[1], name, mime: mimeOf(name), size: 0, sha256: '', author: client, created_at: now() };

  const { value, rejections } = await plugins.run('file:upload', file, ctxOf(req));
  if (rejections.length) return fail(res, 422, 'rejected', { reasons: rejections });
  if (!value.name) return fail(res, 400, 'invalid filename');

  let stored;
  try {
    stored = await blobs.put(req, CONFIG.maxFileBytes);
  } catch (err) {
    if (err.code === 'TOO_LARGE') {
      return fail(res, 413, 'file too large', { maxBytes: err.maxBytes });
    }
    return fail(res, 400, err.message);
  }
  if (stored.size === 0) return fail(res, 400, 'empty file');

  Object.assign(value, { size: stored.size, sha256: stored.sha, mime: mimeOf(value.name) });
  const saved = store.addFile(value);

  const after = await plugins.run('file:stored', saved, ctxOf(req));
  if (after.rejections.length) {
    store.deleteFile(saved.id);
    if (store.otherRefsToSha(saved.sha256, saved.id) === 0) await blobs.remove(saved.sha256);
    return fail(res, 422, 'rejected', { reasons: after.rejections });
  }

  store.updateItem(m[1], { updated_at: now() });
  sendJson(res, 201, { file: { id: saved.id, name: saved.name, size: saved.size, mime: saved.mime, downloads: 0 } });
});

route('DELETE', /^\/api\/files\/([A-Za-z0-9]{4,16})$/, async (req, res, m) => {
  const file = store.getFile(m[1]);
  if (!file) return fail(res, 404, 'not found');
  const row = store.getItem(file.itemId);
  if (!row) return fail(res, 404, 'not found');
  if (!ownSecret(req, res, row)) return;
  store.deleteFile(m[1]);
  if (store.otherRefsToSha(file.sha256, m[1]) === 0) await blobs.remove(file.sha256);
  await plugins.run('file:delete', file, ctxOf(req));
  sendJson(res, 200, { ok: true });
});

function serveFile(req, res, file, { inline }) {
  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  const headers = {
    'Content-Type': file.mime,
    'Content-Disposition': disposition,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': `"${file.sha256}"`,
  };
  if (inline && !isTextExt(file.name.split('.').pop() ? `.${file.name.split('.').pop().toLowerCase()}` : '')) {
    headers['Content-Type'] = 'application/octet-stream';
  }
  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, { ETag: headers.ETag, 'Cache-Control': headers['Cache-Control'] });
    return res.end();
  }
  if (!inline) store.incFileDownloads(file.id);

  const size = file.size;
  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && inline) {
    let start = m[1] === '' ? null : Number(m[1]);
    let end = m[2] === '' ? null : Number(m[2]);
    if (start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; }
    if (start === null) start = 0;
    if (end === null || end >= size) end = size - 1;
    if (start <= end && start < size) {
      res.writeHead(206, {
        ...SECURITY_HEADERS,
        'Content-Type': file.mime,
        'Content-Disposition': disposition,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return blobs.createReadStream(file.sha256, { start, end }).pipe(res);
    }
  }

  headers['Content-Length'] = size;
  res.writeHead(200, { ...SECURITY_HEADERS, ...headers });
  blobs.createReadStream(file.sha256).pipe(res);
}

route('GET', /^\/f\/([A-Za-z0-9]{4,16})$/, async (req, res, m) => {
  const file = store.getFile(m[1]);
  if (!file) return fail(res, 404, 'not found');
  serveFile(req, res, file, { inline: false });
});

route('GET', /^\/f\/([A-Za-z0-9]{4,16})\/raw$/, async (req, res, m) => {
  const file = store.getFile(m[1]);
  if (!file) return fail(res, 404, 'not found');
  serveFile(req, res, file, { inline: true });
});

route('GET', /^\/r\/([A-Za-z0-9]{4,16})$/, async (req, res, m) => {
  const row = store.getItem(m[1]);
  if (!row) return fail(res, 404, 'not found');
  store.incItemHits(m[1]);
  send(res, 200, row.body, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
});

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors *",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel.split(/[/\\]/).includes('..')) return fail(res, 400, 'bad path');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep) && file !== PUBLIC_DIR) return fail(res, 400, 'bad path');

  let body;
  let served = file;
  try {
    body = await readFile(file);
  } catch {
    if (pathname.includes('.')) return fail(res, 404, 'not found');
    served = join(PUBLIC_DIR, 'index.html');
    try {
      body = await readFile(served);
    } catch {
      return fail(res, 500, 'frontend missing');
    }
  }
  const type = STATIC_TYPES[extname(served).toLowerCase()] || 'application/octet-stream';
  send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP });
}

const server = http.createServer(async (req, res) => {
  res.req = req;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-cheatlab-client, x-cheatlab-secret, x-filename',
      'Access-Control-Max-Age': '86400',
    });
  }

  if (pathname.startsWith('/api/') || pathname.startsWith('/f/') || pathname.startsWith('/r/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    for (const r of routes) {
      if (r.method !== req.method && !(req.method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      try {
        await r.handler(req, res, m, url);
      } catch (err) {
        if (!res.headersSent) fail(res, 500, 'server error', { detail: err.message });
        else res.end();
      }
      return;
    }
    return fail(res, 404, 'no such endpoint');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
  await serveStatic(req, res, pathname);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  const s = store.stats();
  process.stdout.write(
    `CHEATLAB  http://${CONFIG.host === '0.0.0.0' ? 'localhost' : CONFIG.host}:${CONFIG.port}\n` +
    `  data     ${DATA_DIR}\n` +
    `  items    ${s.items} (${s.scripts} scripts, ${s.pastes} pastes, ${s.apps} apps)\n` +
    `  files    ${s.files} (${formatBytes(s.bytes)})\n` +
    `  plugins  ${plugins.plugins.map((p) => p.name).join(', ') || 'none'}` +
    `${plugins.failed.length ? `  FAILED: ${plugins.failed.map((f) => `${f.file} (${f.error})`).join('; ')}` : ''}\n` +
    `  access   open, no geo / ASN / VPN gating\n`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); store.close(); process.exit(0); });
}
