/**
 * Worker behaviour tests. Run with: node worker/test/worker.test.mjs
 */
import { makeEnv, call as rawCall, solveCaptcha, request } from './harness.mjs';
import worker from '../src/index.js';

/**
 * Anonymous publishing now requires a captcha (see auth.test.mjs). This suite
 * covers media, ranges and storage, not the anti-abuse policy, so rather than
 * hand a captcha to every call site, `call` here solves one automatically for
 * anonymous POSTs to /api/items. The auth suite calls the harness directly and
 * therefore still sees the real 403.
 */
async function call(worker_, env_, path, opts = {}) {
  const method = opts.method || 'GET';
  const needsCaptcha =
    method === 'POST' && path === '/api/items' && !opts.session && !opts.captchaToken;
  if (!needsCaptcha) return rawCall(worker_, env_, path, opts);
  // Only the identity headers may carry over: forwarding the call's own method
  // or body would turn this into POST /api/auth/captcha, which is not a route.
  const c = await solveCaptcha(worker_, env_, { client: opts.client, id: opts.id });
  // A body that does not parse is the point of some tests (malformed JSON), so
  // it is passed through untouched rather than throwing here.
  let parsed = null;
  try {
    parsed = JSON.parse(typeof opts.body === 'string' ? opts.body || '{}' : JSON.stringify(opts.body || {}));
  } catch { /* deliberately malformed */ }
  if (parsed === null) return rawCall(worker_, env_, path, opts);
  return rawCall(worker_, env_, path, {
    ...opts,
    body: { ...parsed, captchaToken: c.token, captchaAnswer: c.answer },
  });
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

async function t(name, fn) {
  // These tests publish many items on purpose (listing, dedup, range serving).
  // The shipped anonymous cap is one item a day, which would make them untestable
  // for reasons unrelated to what they check, so the cap is raised here. The cap
  // itself is asserted in auth.test.mjs at its real default.
  const env = makeEnv({ ANON_NEW_ITEMS_PER_DAY: '500' });
  try {
    await fn(env);
  } catch (err) {
    fail++;
    failures.push(`${name} threw: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ service */

await t('GET / advertises the API', async (env) => {
  const r = await call(worker, env, '/');
  check('root status', r.status === 200, `got ${r.status}`);
  check('root service', r.json?.service === 'CHEATLAB API', r.text.slice(0, 120));
  check('root lists media types', ['image', 'video', 'file'].every((x) => r.json?.types?.includes(x)));
});

await t('CORS preflight is allowed', async (env) => {
  const res = await worker.fetch(new Request('https://api.cheatlab.test/api/items', { method: 'OPTIONS' }), env);
  check('preflight 204', res.status === 204, `got ${res.status}`);
  check('preflight origin', res.headers.get('Access-Control-Allow-Origin') === '*');
  check('preflight has no body', (await res.text()) === '');

  // A cross-origin POST from the site is preflighted because of the custom
  // headers. If any of these are missing the browser blocks the request before
  // it reaches a handler, so assert on every header the front end actually sends.
  const allowed = (res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
  for (const h of ['content-type', 'x-cheatlab-client', 'x-cheatlab-secret', 'x-filename']) {
    check(`preflight allows ${h}`, allowed.includes(h), `got "${allowed}"`);
  }
  const methods = (res.headers.get('Access-Control-Allow-Methods') || '').toUpperCase();
  for (const m of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
    check(`preflight allows ${m}`, methods.includes(m), `got "${methods}"`);
  }
});

await t('unknown endpoint 404s as json', async (env) => {
  const r = await call(worker, env, '/api/nope');
  check('404 status', r.status === 404, `got ${r.status}`);
  check('404 json', r.json?.error === 'no such endpoint', r.text.slice(0, 120));
});

/* ---------------------------------------------------------------- publishing */

let shared = null;

await t('create item', async (env) => {
  const r = await call(worker, env, '/api/items', {
    method: 'POST',
    body: JSON.stringify({ type: 'script', title: 'Speed boost', body: 'print(1)', language: 'luau', tags: ['Movement'] }),
  });
  check('create 201', r.status === 201, `got ${r.status} ${r.text.slice(0, 200)}`);
  check('create returns secret', typeof r.json?.secret === 'string' && r.json.secret.length > 10);
  check('create echoes body', r.json?.item?.body === 'print(1)');
  check('create hashes author', /^[a-f0-9]{6}$/.test(r.json?.item?.author || ''), r.json?.item?.author);
  check('create never leaks secret hash', !('secret_hash' in (r.json?.item || {})));
  shared = r.json;
});

await t('create rejects empty title', async (env) => {
  const r = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: '   ' }) });
  check('title required', r.status === 400 && r.json?.error === 'title is required', `${r.status} ${r.text.slice(0, 120)}`);
});

await t('create rejects oversized body', async (env) => {
  const big = 'x'.repeat(300 * 1024);
  const r = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'big', body: big }) });
  check('body too large', r.status === 413, `got ${r.status}`);
});

await t('create requires a client id', async (env) => {
  const r = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'x' }), id: null });
  check('missing client 401', r.status === 401, `got ${r.status}`);
});

/* -------------------------------------------------------------------- upload */

await t('upload a script file', async (env) => {
  const item = await call(worker, env, '/api/items', {
    method: 'POST',
    body: JSON.stringify({ type: 'script', title: 'With file', body: 'see attachment' }),
  });
  const { item: created, secret } = item.json;

  const payload = new TextEncoder().encode('--[[ hi ]]\nprint("hello")\n');
  const up = await call(worker, env, `/api/items/${created.id}/files`, {
    method: 'POST',
    body: payload,
    headers: { 'x-filename': 'exploit.lua', 'content-length': String(payload.byteLength) },
  });
  check('upload 201', up.status === 201, `got ${up.status} ${up.text.slice(0, 200)}`);
  check('upload name preserved', up.json?.file?.name === 'exploit.lua', up.json?.file?.name);
  check('upload mime', up.json?.file?.mime === 'text/plain; charset=utf-8', up.json?.file?.mime);
  check('upload size', up.json?.file?.size === payload.byteLength);

  const view = await call(worker, env, `/api/items/${created.id}`, { secret });
  check('item now has file', view.json?.item?.files?.length === 1, JSON.stringify(view.json?.item?.files));
  check('item file sha truncated to 16', view.json?.item?.files?.[0]?.sha256?.length === 16);
  check('item fileSize summed', view.json?.item?.fileSize === payload.byteLength);

  const fileId = up.json.file.id;
  const dl = await call(worker, env, `/f/${fileId}`);
  check('download 200', dl.status === 200, `got ${dl.status}`);
  check('download disposition attachment', (dl.res.headers.get('Content-Disposition') || '').startsWith('attachment'));
  check('download body matches', dl.text.includes('print("hello")'));
  check('download etag is sha', (dl.res.headers.get('ETag') || '').startsWith('"'));
  check('accept-ranges advertised', dl.res.headers.get('Accept-Ranges') === 'bytes');

  shared = { itemId: created.id, fileId, secret };
});

await t('upload dedupes identical content', async (env) => {
  const a = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'A' }) });
  const b = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'B' }) });
  const bytes = new TextEncoder().encode('same content');
  for (const item of [a.json.item, b.json.item]) {
    await call(worker, env, `/api/items/${item.id}/files`, {
      method: 'POST', body: bytes, headers: { 'x-filename': 'same.txt' },
    });
  }
  const size = env.BUCKET.map.size;
  check('one R2 object for two identical uploads', size === 1, `got ${size} objects`);
});

await t('upload guard neutralises path traversal', async (env) => {
  const item = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'guard' }) });
  const id = item.json.item.id;

  // rejected outright: no usable extension at all
  const noext = await call(worker, env, `/api/items/${id}/files`, {
    method: 'POST', body: new Uint8Array([1, 2, 3]), headers: { 'x-filename': 'noext' },
  });
  check('rejects extensionless name', noext.status === 422 || noext.status === 400, `got ${noext.status} ${noext.text.slice(0, 100)}`);

  // path separators are neutralised by safeFilename before the plugin runs, so
  // the traversal never reaches storage
  const traversal = await call(worker, env, `/api/items/${id}/files`, {
    method: 'POST', body: new TextEncoder().encode('ok'), headers: { 'x-filename': '../escape.lua' },
  });
  const stored = traversal.json?.file?.name || '';
  check('traversal name stored sanitised', traversal.status === 201 && stored === '__escape.lua', `${traversal.status} ${stored}`);
  check('no slashes survive', !/[\\/]/.test(stored), stored);
  check('no dot-dot survives', !stored.includes('..'), stored);

  // the R2 key is derived from the content hash, never from the name
  for (const key of env.BUCKET.map.keys()) {
    check('r2 key is hash-shaped', /^blobs\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key), key);
  }
});

await t('empty upload is refused', async (env) => {
  const item = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'empty' }) });
  const r = await call(worker, env, `/api/items/${item.json.item.id}/files`, {
    method: 'POST', body: new Uint8Array(0), headers: { 'x-filename': 'empty.txt' },
  });
  check('empty file 400', r.status === 400 && r.json?.error === 'empty file', `${r.status} ${r.text.slice(0, 100)}`);
});

await t('max files per item is enforced', async (env) => {
  const limited = makeEnv({ MAX_FILES: '2' });
  const item = await call(worker, limited, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'cap' }) });
  const id = item.json.item.id;
  for (let i = 0; i < 2; i++) {
    const r = await call(worker, limited, `/api/items/${id}/files`, {
      method: 'POST', body: new TextEncoder().encode(`file ${i}`), headers: { 'x-filename': `f${i}.txt` },
    });
    check(`upload ${i} ok`, r.status === 201, `${r.status} ${r.text.slice(0, 120)}`);
  }
  const over = await call(worker, limited, `/api/items/${id}/files`, {
    method: 'POST', body: new TextEncoder().encode('file 3'), headers: { 'x-filename': 'f3.txt' },
  });
  check('third upload 409', over.status === 409, `got ${over.status}`);
});

await t('oversized upload is refused', async (env) => {
  const small = makeEnv({ MAX_FILE_MB: '0.002' }); // ~2 KB
  const item = await call(worker, small, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'big' }) });
  const bytes = new Uint8Array(8 * 1024);
  const r = await call(worker, small, `/api/items/${item.json.item.id}/files`, {
    method: 'POST', body: bytes, headers: { 'x-filename': 'x.txt', 'content-length': String(bytes.byteLength) },
  });
  check('too large 413', r.status === 413, `got ${r.status}`);
  check('maxBytes reported', typeof r.json?.maxBytes === 'number', JSON.stringify(r.json));
  check('nothing written to R2', small.BUCKET.map.size === 0, `${small.BUCKET.map.size}`);
});

/* -------------------------------------------------------------- media & range */

await t('image and video posts are served for preview', async (env) => {
  // 1x1 transparent PNG
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

  for (const [type, name, mime, magic] of [
    ['image', 'shot.png', 'image/png', png],
    ['video', 'clip.mp4', 'video/mp4', Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4, 5, 6, 7, 8])],
  ]) {
    const item = await call(worker, env, '/api/items', {
      method: 'POST', body: JSON.stringify({ type, title: `a ${type}`, body: 'description' }),
    });
    const up = await call(worker, env, `/api/items/${item.json.item.id}/files`, {
      method: 'POST', body: magic, headers: { 'x-filename': name },
    });
    check(`${type} upload 201`, up.status === 201, `${up.status} ${up.text.slice(0, 120)}`);
    check(`${type} mime correct`, up.json?.file?.mime === mime, up.json?.file?.mime);

    const media = await call(worker, env, `/m/${up.json.file.id}`);
    check(`${type} media 200`, media.status === 200, `got ${media.status}`);
    check(`${type} media content-type`, media.res.headers.get('Content-Type') === mime, media.res.headers.get('Content-Type'));
    check(`${type} media inline`, media.res.headers.get('Content-Disposition') === 'inline');

    // re-fetch for the byte comparison: call() has already consumed the body
    const again = await worker.fetch(request(`/m/${up.json.file.id}`), env);
    const bytes = new Uint8Array(await again.arrayBuffer());
    check(`${type} media bytes intact`, bytes.byteLength === magic.byteLength, `${bytes.byteLength} vs ${magic.byteLength}`);
    check(`${type} media bytes equal`, bytes.every((b, i) => b === magic[i]));

    // raw of a binary type must not be sniffable as html/text
    const raw = await call(worker, env, `/f/${up.json.file.id}/raw`);
    check(`${type} raw forced to octet-stream`, raw.res.headers.get('Content-Type') === 'application/octet-stream', raw.res.headers.get('Content-Type'));
  }
});

await t('video range requests are satisfiable', async (env) => {
  const size = 64 * 1024;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;

  const item = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ type: 'video', title: 'seekable' }) });
  const up = await call(worker, env, `/api/items/${item.json.item.id}/files`, {
    method: 'POST', body: bytes, headers: { 'x-filename': 'big.mp4' },
  });
  const id = up.json.file.id;

  const whole = await worker.fetch(request(`/m/${id}`), env);
  check('full 200', whole.status === 200, `got ${whole.status}`);

  const part = await worker.fetch(request(`/m/${id}`, { headers: { range: 'bytes=100-199' } }), env);
  check('partial 206', part.status === 206, `got ${part.status}`);
  check('content-range correct', part.headers.get('Content-Range') === `bytes 100-199/${size}`, part.headers.get('Content-Range'));
  // A ranged response is produced by a different branch than the full one, and
  // scrubbing a video that comes back as application/octet-stream fails.
  check('partial keeps media content-type', part.headers.get('Content-Type') === 'video/mp4', part.headers.get('Content-Type'));
  check('partial length 100', Number(part.headers.get('Content-Length')) === 100, part.headers.get('Content-Length'));
  const got = new Uint8Array(await part.arrayBuffer());
  check('partial bytes correct', got[0] === 100 % 251 && got[99] === 199 % 251, `${got[0]},${got[99]}`);

  const open = await worker.fetch(request(`/m/${id}`, { headers: { range: 'bytes=1000-' } }), env);
  check('open-ended range 206', open.status === 206, `got ${open.status}`);

  const suffix = await worker.fetch(request(`/m/${id}`, { headers: { range: 'bytes=-50' } }), env);
  check('suffix range 206', suffix.status === 206, `got ${suffix.status}`);
  check('suffix length 50', Number(suffix.headers.get('Content-Length')) === 50, suffix.headers.get('Content-Length'));

  const past = await worker.fetch(request(`/m/${id}`, { headers: { range: 'bytes=999999999-' } }), env);
  check('unsatisfiable 416', past.status === 416, `got ${past.status}`);
});

await t('ETag yields 304', async (env) => {
  const item = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'etag' }) });
  const up = await call(worker, env, `/api/items/${item.json.item.id}/files`, {
    method: 'POST', body: new TextEncoder().encode('cache me'), headers: { 'x-filename': 'e.txt' },
  });
  const first = await call(worker, env, `/f/${up.json.file.id}`);
  const etag = first.res.headers.get('ETag');
  const second = await worker.fetch(request(`/f/${up.json.file.id}`, { headers: { 'if-none-match': etag } }), env);
  check('304 on match', second.status === 304, `got ${second.status}`);
});

/* ------------------------------------------------------------------ raw text */

await t('raw text endpoint', async (env) => {
  const item = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'raw', body: 'print("raw")' }) });
  const r = await call(worker, env, `/r/${item.json.item.id}`);
  check('raw 200', r.status === 200, `got ${r.status}`);
  check('raw content-type text', r.res.headers.get('Content-Type') === 'text/plain; charset=utf-8', r.res.headers.get('Content-Type'));
  check('raw body', r.text === 'print("raw")', r.text);
  check('raw no-store', r.res.headers.get('Cache-Control') === 'no-store');
});

await t('raw text file is not forced to octet-stream', async (env) => {
  const item = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'txt' }) });
  const up = await call(worker, env, `/api/items/${item.json.item.id}/files`, {
    method: 'POST', body: new TextEncoder().encode('hello'), headers: { 'x-filename': 'a.txt' },
  });
  const raw = await call(worker, env, `/f/${up.json.file.id}/raw`);
  check('txt raw keeps text type', raw.res.headers.get('Content-Type').startsWith('text/plain'), raw.res.headers.get('Content-Type'));
});

/* ------------------------------------------------------------------- listing */

await t('listing, filtering and search', async (env) => {
  const mk = (title, body, tags, type = 'paste') =>
    call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ type, title, body, tags }) });

  await mk('Alpha lua script', 'local x = 1', ['Lua'], 'script');
  await mk('Beta image post', 'a picture', ['Media'], 'image');
  await mk('Gamma notes', 'plain text here', ['Notes'], 'paste');

  const all = await call(worker, env, '/api/items');
  check('lists all', all.json?.total === 3, `total ${all.json?.total}`);
  check('list items trimmed', all.json?.items?.length === 3);
  check('list uses preview not body', 'preview' in all.json.items[0] && !('body' in all.json.items[0]));

  const byType = await call(worker, env, '/api/items?type=script');
  check('filter by type', byType.json?.total === 1, `total ${byType.json?.total}`);

  const badType = await call(worker, env, '/api/items?type=bogus');
  check('unknown type 400', badType.status === 400, `got ${badType.status}`);

  const byTag = await call(worker, env, '/api/items?tag=media');
  check('filter by tag', byTag.json?.total === 1, `total ${byTag.json?.total}`);

  const search = await call(worker, env, '/api/items?q=Gamma');
  check('search by title', search.json?.total === 1, `total ${search.json?.total}`);

  const byBody = await call(worker, env, '/api/items?q=plain');
  check('search by body', byBody.json?.total === 1, `total ${byBody.json?.total}`);

  const limited = await call(worker, env, '/api/items?limit=2');
  check('limit respected', limited.json?.items?.length === 2, `${limited.json?.items?.length}`);
  const page2 = await call(worker, env, '/api/items?limit=2&offset=2');
  check('offset respected', page2.json?.items?.length === 1, `${page2.json?.items?.length}`);

  for (const sort of ['new', 'old', 'hot']) {
    const r = await call(worker, env, `/api/items?sort=${sort}`);
    check(`sort ${sort} works`, r.status === 200 && r.json.items.length === 3, `${r.status}`);
  }
});

await t('LIKE wildcards in search are escaped', async (env) => {
  await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'a_b', body: 'x' }) });
  await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'axb', body: 'x' }) });
  const r = await call(worker, env, '/api/items?q=a_b');
  check('underscore is literal', r.json?.total === 1, `total ${r.json?.total}`);
  const pct = await call(worker, env, '/api/items?q=%25');
  check('percent is literal', pct.status === 200, `got ${pct.status}`);
});

/* ------------------------------------------------------------------- secrets */

await t('edit requires the secret', async (env) => {
  const created = await call(worker, env, '/api/items', {
    method: 'POST', body: JSON.stringify({ title: 'secret', body: 'v1' }),
  });
  const { item, secret } = created.json;

  const noSecret = await call(worker, env, `/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'hacked' }) });
  check('patch without secret 403', noSecret.status === 403, `got ${noSecret.status}`);

  const wrong = await call(worker, env, `/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'hacked' }), secret: 'wrong-secret-value' });
  check('patch with wrong secret 403', wrong.status === 403, `got ${wrong.status}`);

  const ok = await call(worker, env, `/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'renamed', tags: ['New'] }), secret });
  check('patch with secret 200', ok.status === 200, `${ok.status} ${ok.text.slice(0, 150)}`);
  check('patch applied title', ok.json?.item?.title === 'renamed', ok.json?.item?.title);
  check('patch applied tags', ok.json?.item?.tags?.[0] === 'new', JSON.stringify(ok.json?.item?.tags));

  const noTitle = await call(worker, env, `/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: '  ' }), secret });
  check('patch cannot blank title', noTitle.status === 400, `got ${noTitle.status}`);

  const del = await call(worker, env, `/api/items/${item.id}`, { method: 'DELETE', secret });
  check('delete with secret 200', del.status === 200, `got ${del.status}`);
  const gone = await call(worker, env, `/api/items/${item.id}`);
  check('deleted item 404', gone.status === 404, `got ${gone.status}`);
});

await t('other clients cannot upload to an item', async (env) => {
  const created = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'mine' }) });
  const r = await call(worker, env, `/api/items/${created.json.item.id}/files`, {
    method: 'POST', body: new TextEncoder().encode('x'), headers: { 'x-filename': 'x.txt' }, id: 'someoneelse0123456789',
  });
  check('foreign upload 403', r.status === 403, `got ${r.status}`);
});

await t('me lists only my own items', async (env) => {
  await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'mine' }) });
  await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'theirs' }), id: 'otherclient9876543210abcd' });
  const r = await call(worker, env, '/api/me');
  check('me 200', r.status === 200, `got ${r.status}`);
  check('me scoped to client', r.json?.items?.length === 1 && r.json.items[0].title === 'mine', JSON.stringify(r.json?.items?.map((i) => i.title)));
  const anon = await call(worker, env, '/api/me', { id: null });
  check('me without client 401', anon.status === 401, `got ${anon.status}`);
});

/* ------------------------------------------------------------------- deleting */

await t('deleting an item removes its blobs', async (env) => {
  const created = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'cleanup' }) });
  const { item, secret } = created.json;
  await call(worker, env, `/api/items/${item.id}/files`, {
    method: 'POST', body: new TextEncoder().encode('unique payload 12345'), headers: { 'x-filename': 'c.txt' },
  });
  check('blob stored', env.BUCKET.map.size === 1, `${env.BUCKET.map.size}`);
  await call(worker, env, `/api/items/${item.id}`, { method: 'DELETE', secret });
  check('blob removed', env.BUCKET.map.size === 0, `${env.BUCKET.map.size}`);
  const f = await call(worker, env, `/api/items/${item.id}`);
  check('item gone', f.status === 404);
});

await t('shared blobs survive until the last reference goes', async (env) => {
  const bytes = new TextEncoder().encode('shared bytes for two items');
  const a = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'A' }) });
  const b = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'B' }) });
  for (const x of [a.json, b.json]) {
    await call(worker, env, `/api/items/${x.item.id}/files`, {
      method: 'POST', body: bytes, headers: { 'x-filename': 'shared.txt' },
    });
  }
  check('deduped to one object', env.BUCKET.map.size === 1, `${env.BUCKET.map.size}`);
  await call(worker, env, `/api/items/${a.json.item.id}`, { method: 'DELETE', secret: a.json.secret });
  check('blob kept while referenced', env.BUCKET.map.size === 1, `${env.BUCKET.map.size}`);
  await call(worker, env, `/api/items/${b.json.item.id}`, { method: 'DELETE', secret: b.json.secret });
  check('blob removed after last ref', env.BUCKET.map.size === 0, `${env.BUCKET.map.size}`);
});

/* ------------------------------------------------------------------- deletes */

await t('deleting a file', async (env) => {
  const created = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'f' }) });
  const { item, secret } = created.json;
  const up = await call(worker, env, `/api/items/${item.id}/files`, {
    method: 'POST', body: new TextEncoder().encode('delete me'), headers: { 'x-filename': 'd.txt' },
  });

  const noSecret = await call(worker, env, `/api/files/${up.json.file.id}`, { method: 'DELETE' });
  check('file delete without secret 403', noSecret.status === 403, `got ${noSecret.status}`);

  const ok = await call(worker, env, `/api/files/${up.json.file.id}`, { method: 'DELETE', secret });
  check('file delete 200', ok.status === 200, `got ${ok.status}`);
  const after = await call(worker, env, `/f/${up.json.file.id}`);
  check('file gone', after.status === 404, `got ${after.status}`);
  check('blob removed', env.BUCKET.map.size === 0);
});

/* ----------------------------------------------------------------- downloads */

await t('download counter increments only on attachment', async (env) => {
  const created = await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'dl' }) });
  const up = await call(worker, env, `/api/items/${created.json.item.id}/files`, {
    method: 'POST', body: new TextEncoder().encode('counted'), headers: { 'x-filename': 'c.txt' },
  });
  await call(worker, env, `/f/${up.json.file.id}`);
  await call(worker, env, `/f/${up.json.file.id}`);
  await call(worker, env, `/f/${up.json.file.id}/raw`);
  const view = await call(worker, env, `/api/items/${created.json.item.id}`);
  check('two attachment downloads', view.json?.item?.files?.[0]?.downloads === 2, `${view.json?.item?.files?.[0]?.downloads}`);
});

/* --------------------------------------------------------------------- stats */

await t('stats and plugins', async (env) => {
  await call(worker, env, '/api/items', { method: 'POST', body: JSON.stringify({ type: 'image', title: 'pic' }) });
  const stats = await call(worker, env, '/api/stats');
  check('stats 200', stats.status === 200, `got ${stats.status}`);
  check('stats counts items', stats.json?.items === 1, JSON.stringify(stats.json));
  check('stats buckets by media type', stats.json?.images === 1, JSON.stringify(stats.json));
  check('stats zeroed keys present', stats.json?.files === 0 && stats.json?.bytes === 0);

  const plugins = await call(worker, env, '/api/plugins');
  check('three plugins loaded', plugins.json?.loaded?.length === 3, JSON.stringify(plugins.json?.loaded?.map((p) => p.name)));
  check('no plugin failures', plugins.json?.failed?.length === 0, JSON.stringify(plugins.json?.failed));

  const config = await call(worker, env, '/api/config');
  check('config advertises media types', ['image', 'video', 'file'].every((x) => config.json?.types?.includes(x)), JSON.stringify(config.json?.types));
  check('config exposes limits', config.json?.limits?.maxFileBytes === 24 * 1024 * 1024, `${config.json?.limits?.maxFileBytes}`);
});

/* ------------------------------------------------------------------- plugins */

await t('denylist blocks configured extensions', async (env) => {
  const blocked = makeEnv({ DENY_EXT: 'exe,dll' });
  const item = await call(worker, blocked, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'blocked' }) });
  const r = await call(worker, blocked, `/api/items/${item.json.item.id}/files`, {
    method: 'POST', body: new TextEncoder().encode('MZ'), headers: { 'x-filename': 'bad.exe' },
  });
  check('denied ext 422', r.status === 422, `got ${r.status} ${r.text.slice(0, 150)}`);
  check('denial reason names plugin', r.json?.reasons?.[0]?.plugin === 'denylist', JSON.stringify(r.json?.reasons));
  check('nothing written to R2', blocked.BUCKET.map.size === 0);
});

/* ---------------------------------------------------------------- rate limit */

await t('write rate limit kicks in', async (env) => {
  const capped = makeEnv({ WRITE_CAP: '3' });
  let last;
  for (let i = 0; i < 5; i++) {
    last = await call(worker, capped, '/api/items', { method: 'POST', body: JSON.stringify({ title: `r${i}` }) });
  }
  check('rate limited after cap', last.status === 429, `got ${last.status}`);
  check('rate limit message', /limit/.test(last.json?.error || ''), last.json?.error);
});

await t('rate limit is per client', async (env) => {
  const capped = makeEnv({ WRITE_CAP: '1' });
  const a = await call(worker, capped, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'a' }) });
  const b = await call(worker, capped, '/api/items', { method: 'POST', body: JSON.stringify({ title: 'b' }), id: 'secondclient1234567890' });
  check('first ok', a.status === 201, `got ${a.status}`);
  check('second client unaffected', b.status === 201, `got ${b.status}`);
});

await t('read rate limit kicks in', async (env) => {
  const capped = makeEnv({ READ_CAP: '2' });
  await call(worker, capped, '/api/items');
  await call(worker, capped, '/api/items');
  const third = await call(worker, capped, '/api/items');
  check('read limited', third.status === 429, `got ${third.status}`);
  check('slow down message', third.json?.error === 'slow down', third.json?.error);
});

/* ----------------------------------------------------------------- hardening */

await t('security headers on json', async (env) => {
  const r = await call(worker, env, '/api/stats');
  check('nosniff', r.res.headers.get('X-Content-Type-Options') === 'nosniff');
  check('no-referrer', r.res.headers.get('Referrer-Policy') === 'no-referrer');
});

await t('CORS origin is configurable', async (env) => {
  const strict = makeEnv({ ALLOW_ORIGIN: 'https://tatarhost.github.io' });
  const r = await call(worker, strict, '/api/stats');
  check('configured origin echoed', r.res.headers.get('Access-Control-Allow-Origin') === 'https://tatarhost.github.io', r.res.headers.get('Access-Control-Allow-Origin'));
});

await t('malformed json is rejected', async (env) => {
  const r = await call(worker, env, '/api/items', { method: 'POST', body: '{not json' });
  check('bad json 400', r.status === 400, `got ${r.status}`);
  check('bad json message', r.json?.error === 'invalid json', r.json?.error);
});

await t('head request resolves like get', async (env) => {
  const res = await worker.fetch(new Request('https://api.cheatlab.test/api/stats', { method: 'HEAD', headers: { 'x-cheatlab-client': 'testclient0123456789abcdef' } }), env);
  check('HEAD 200', res.status === 200, `got ${res.status}`);
});

/* ---------------------------------------------------------------------- done */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
