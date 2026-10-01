/**
 * Cloudinary storage, the game chip and the raised limits.
 * Run with: node --experimental-sqlite worker/test/storage.test.mjs
 *
 * Bytes move off Workers KV, and the thing worth proving is that both paths
 * still work: without the Cloudinary secrets the upload has to land in KV and
 * keep serving from there, and with them the Worker has to sign an upload, keep
 * the bytes out of its own heap, and answer a takedown with a destroy.
 *
 * Cloudinary itself is not reachable from a test, so fetch is stood in for
 * rather than mocked out at the module boundary: the real signing code runs, the
 * real FormData is built, and the stub asserts on what the Worker sent. That is
 * what makes "it sent a signature" a real claim rather than a tautology.
 */
import { makeEnv, call } from './harness.mjs';
import worker from '../src/index.js';
import { BlobStore, KV_MAX_PUT_BYTES } from '../src/blobs.js';
import { cloudinaryReady, previewUrl, thumbUrl, transformed, publicIdFor, resourceTypeOf } from '../src/cloudinary.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

async function t(name, fn) {
  // Several tests publish more than one item from one client id, and the caps
  // under test here are the size ones, so the daily budget is lifted here rather
  // than in each test.
  const env = makeEnv({ REG_NEW_ITEMS_PER_DAY: '50', ANON_NEW_ITEMS_PER_DAY: '50' });
  try {
    await fn(env);
  } catch (err) {
    fail++;
    failures.push(`${name} threw: ${err.stack || err.message}`);
  }
}

const PNG = new TextEncoder().encode('\x89PNG\r\n\x1a\n' + 'a'.repeat(512));

/** Publishes an item and returns it with its edit secret. */
async function publish(env, extra = {}) {
  const res = await call(worker, env, '/api/items', {
    method: 'POST',
    autoCaptcha: true,
    body: JSON.stringify({ type: 'paste', title: 'storage subject', body: 'code', ...extra }),
  });
  if (res.status !== 201) throw new Error(`publish failed: ${res.status} ${res.text.slice(0, 200)}`);
  return res.json;
}

/** Stands in for the Cloudinary API and records every call. */
function stubCloudinary(calls) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.includes('api.cloudinary.com')) return real(url, init);
    const form = init.body;
    const fields = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
    calls.push({ href, fields, file: form.get('file') });
    if (href.includes('/destroy')) {
      return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    }
    // `auto` upload infers the resource type from what is being sent, and then
    // reports it back in both the body and the delivery url - which is the
    // invariant the destroy path leans on, so the stub has to honour it rather
    // than guess from a filename. The type comes off the file itself, the way
    // Cloudinary reads it.
    const file = form.get('file');
    const type = /^(image|video)\//.test(file?.type || '') ? file.type.split('/')[0] : 'raw';
    return new Response(JSON.stringify({
      secure_url: `https://res.cloudinary.com/testcloud/${type}/upload/${fields.public_id}.${fields.format || 'bin'}`,
      public_id: fields.public_id,
      resource_type: type,
      format: 'png',
      bytes: 1024,
      width: 800,
      height: 600,
    }), { status: 200 });
  };
  return () => { globalThis.fetch = real; };
}

const cloudEnv = (over = {}) => makeEnv({
  REG_NEW_ITEMS_PER_DAY: '50',
  ANON_NEW_ITEMS_PER_DAY: '50',
  CLOUDINARY_CLOUD_NAME: 'testcloud',
  CLOUDINARY_API_KEY: '1234567890',
  CLOUDINARY_API_SECRET: 'super-secret',
  CLOUDINARY_SALT: 'pepper',
  ...over,
});

/* ------------------------------------------------------------ configuration */

await t('a half-configured Cloudinary falls back to KV instead of failing', async (env) => {
  const cases = [
    { CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k' },
    { CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' },
    { CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', CLOUDINARY_SALT: 'p' },
  ];
  for (const [i, partial] of cases.entries()) {
    const e = makeEnv(partial);
    check(`partial config ${i} is not ready`, cloudinaryReady(e) === false, JSON.stringify(partial));
  }
  check('all four is ready', cloudinaryReady(cloudEnv()) === true);
  check('no config at all is not ready', cloudinaryReady(env) === false);
});

await t('the salt changes the public id, so a url is not computable from the file', async () => {
  const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const one = await publicIdFor(cloudEnv({ CLOUDINARY_SALT: 'one' }), digest);
  const two = await publicIdFor(cloudEnv({ CLOUDINARY_SALT: 'two' }), digest);
  check('two salts give two public ids for the same bytes', one !== two, `${one} / ${two}`);
  check('the id is 40 hex characters', /^[0-9a-f]{40}$/.test(one), one);
  check('the id is not the digest', !one.startsWith(digest.slice(0, 12)));
  check('the same salt gives the same id', (await publicIdFor(cloudEnv({ CLOUDINARY_SALT: 'one' }), digest)) === one);
});

/* ----------------------------------------------------------------- KV path */

await t('without the secrets an upload still lands in KV and serves from it', async (env) => {
  const created = await publish(env);
  const up = await call(worker, env, `/api/items/${created.item.id}/files`, {
    method: 'POST', body: PNG, headers: { 'x-filename': 'local.png', 'content-length': String(PNG.length) },
  });
  check('upload 201', up.status === 201, `got ${up.status} ${up.text.slice(0, 120)}`);
  check('bytes are in KV', env.BUCKET.map.size === 1, `${env.BUCKET.map.size}`);
  check('no url handed to the client', !up.json?.file?.url, JSON.stringify(up.json?.file));
  check('preview points back at the Worker', up.json?.file?.preview === `/m/${up.json?.file?.id}`);
  const dl = await call(worker, env, `/f/${up.json.file.id}`);
  check('served from KV with 200', dl.status === 200, `got ${dl.status}`);
  const dl2 = await call(worker, env, `/f/${up.json.file.id}`, {
    headers: { range: 'bytes=0-9' },
  });
  check('range still served on the KV path', dl2.status === 206, `got ${dl2.status}`);
});

/* --------------------------------------------------------- Cloudinary path */

await t('an upload with the secrets set goes to Cloudinary, not to KV', async (env) => {
  const calls = [];
  const restore = stubCloudinary(calls);
  const cenv = cloudEnv();
  try {
    const created = await publish(cenv);
    const up = await call(worker, cenv, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'shot.png', 'content-length': String(PNG.length) },
    });
    check('upload 201', up.status === 201, `got ${up.status} ${up.text.slice(0, 160)}`);
    check('nothing written to KV', cenv.BUCKET.map.size === 0, `${cenv.BUCKET.map.size}`);
    check('one upload call', calls.length === 1, `${calls.length}`);
    check('auto/upload is used so Cloudinary picks the resource type',
      calls[0]?.href === 'https://api.cloudinary.com/v1_1/testcloud/auto/upload', calls[0]?.href);
    check('the api key is sent, not the secret',
      calls[0]?.fields?.api_key === '1234567890' && !JSON.stringify(calls[0]?.fields).includes('super-secret'));
    check('a signature is sent', /^[0-9a-f]{40}$/.test(calls[0]?.fields?.signature || ''), calls[0]?.fields?.signature);
    check('the public id is not the sha256', calls[0]?.fields?.public_id !== '' && !calls[0].fields.public_id.startsWith('e3b0'));
    check('an image gets eager renditions', String(calls[0]?.fields?.eager || '').includes('c_limit,w_1600'), calls[0]?.fields?.eager);
    check('overwrite is set so a re-upload is one asset', calls[0]?.fields?.overwrite === 'true');

    const file = up.json.file;
    check('the row carries the cdn url', String(file.url || '').startsWith('https://res.cloudinary.com/'), file.url);
    check('preview is a transformed url', file.preview !== file.url && file.preview.includes('c_limit,w_1400'), file.preview);
    check('thumb is a small rendition', file.thumb.includes('c_fill,w_320'), file.thumb);
  } finally { restore(); }
});

await t('serving a CDN file redirects instead of copying bytes', async (env) => {
  const calls = [];
  const restore = stubCloudinary(calls);
  const cenv = cloudEnv();
  try {
    const created = await publish(cenv);
    const up = await call(worker, cenv, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'shot.png', 'content-length': String(PNG.length) },
    });
    const id = up.json.file.id;
    const dl = await call(worker, cenv, `/f/${id}`);
    check('download 302', dl.status === 302, `got ${dl.status}`);
    check('points at the asset', (dl.res.headers.get('location') || '').includes('res.cloudinary.com'), dl.res.headers.get('location'));
    const media = await call(worker, cenv, `/m/${id}`);
    check('media 302', media.status === 302, `got ${media.status}`);
    check('media points at the preview rendition', (media.res.headers.get('location') || '').includes('c_limit,w_1400'), media.res.headers.get('location'));
    const raw = await call(worker, cenv, `/f/${id}/raw`);
    check('raw 302', raw.status === 302, `got ${raw.status}`);
    check('redirect is not cached', (dl.res.headers.get('cache-control') || '').includes('no-store'));
  } finally { restore(); }
});

await t('a takedown destroys the asset, not just the row', async (env) => {
  const calls = [];
  const restore = stubCloudinary(calls);
  const cenv = cloudEnv({ ADMIN_IDS: 'u_admin00000000001' });
  try {
    const created = await publish(cenv);
    const up = await call(worker, cenv, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'shot.png', 'content-length': String(PNG.length) },
    });
    const publicId = calls[0].fields.public_id;
    const del = await call(worker, cenv, `/api/files/${up.json.file.id}`, { method: 'DELETE', secret: created.secret });
    check('file deleted', del.status === 200, `got ${del.status}`);
    const destroys = calls.filter((c) => c.href.includes('/destroy'));
    check('destroy called once', destroys.length === 1, `${destroys.length}`);
    check('destroy names the public id', destroys[0]?.fields?.public_id === publicId, destroys[0]?.fields?.public_id);
    check('destroy is signed too', /^[0-9a-f]{40}$/.test(destroys[0]?.fields?.signature || ''));
    // `auto` is an upload-time alias for inferring the type from the bytes being
    // sent. A destroy sends no bytes, so Cloudinary rejects auto/destroy and the
    // asset survives a takedown. The type has to be named explicitly.
    check('destroy names the resource type', destroys[0]?.href.endsWith('/image/destroy'),
      destroys[0]?.href);
  } finally { restore(); }
});

await t('destroy names the right type for each kind of file', async (env) => {
  const cases = [
    { name: 'shot.png', mime: 'image/png', want: 'image' },
    // A gif is a still to a browser but an animated asset to Cloudinary. Either
    // way it is an `image` resource under an auto upload, and the point is that
    // the delete reaches for the same one the upload landed in.
    { name: 'mood.gif', mime: 'image/gif', want: 'image' },
    { name: 'clip.mp4', mime: 'video/mp4', want: 'video' },
    { name: 'pack.zip', mime: 'application/zip', want: 'raw' },
    { name: 'notes.pdf', mime: 'application/pdf', want: 'raw' },
    // An unknown extension still arrives as a concrete type - the guard above
    // requires an extension, and mimeOf falls back to octet-stream - so there is
    // no upload that produces an empty mime to defend against here.
    { name: 'thing.qqq', mime: 'application/octet-stream', want: 'raw' },
  ];
  for (const c of cases) {
    const calls = [];
    const restore = stubCloudinary(calls);
    const cenv = cloudEnv({ ADMIN_IDS: 'u_admin00000000001' });
    try {
      const created = await publish(cenv);
      const headers = { 'x-filename': c.name, 'content-length': String(PNG.length) };
      if (c.mime) headers['content-type'] = c.mime;
      const up = await call(worker, cenv, `/api/items/${created.item.id}/files`, {
        method: 'POST', body: PNG, headers,
      });
      if (!up.json.file) {
        check(`${c.name || '(unnamed)'} uploads`, false, `status ${up.status}: ${up.text.slice(0, 160)}`);
        continue;
      }
      await call(worker, cenv, `/api/files/${up.json.file.id}`, { method: 'DELETE', secret: created.secret });
      const destroys = calls.filter((x) => x.href.includes('/destroy'));
      check(`${c.name || '(unnamed)'} is destroyed as ${c.want}`,
        destroys.length === 1 && destroys[0].href.endsWith(`/${c.want}/destroy`),
        destroys[0]?.href || 'no destroy call');
    } finally { restore(); }
  }
});

await t('the destroy type comes from where the asset actually lives', () => {
  // The url is the record of what Cloudinary was told, so it outranks the mime.
  // This matters because the two can disagree: an asset uploaded as `video` with
  // an image mime, or a row whose mime was never written at all.
  const image = 'https://res.cloudinary.com/testcloud/image/upload/abc/shot.png';
  const video = 'https://res.cloudinary.com/testcloud/video/upload/abc/clip';
  const raw = 'https://res.cloudinary.com/testcloud/raw/upload/pack-1_2.zip';
  check('a url beats a contradicting mime',
    resourceTypeOf(video, 'image/png') === 'video', resourceTypeOf(video, 'image/png'));
  check('and a url alone is enough', resourceTypeOf(image, '') === 'image' && resourceTypeOf(raw, '') === 'raw');
  check('the mime is the fallback when there is no usable url',
    resourceTypeOf('', 'image/webp') === 'image' && resourceTypeOf('', 'video/quicktime') === 'video',
    `${resourceTypeOf('', 'image/webp')}/${resourceTypeOf('', 'video/quicktime')}`);
  // A url naming a type the admin API has no endpoint for must not be echoed
  // back, or the destroy 404s and the asset leaks.
  check('an unusable type in the url falls through to the mime',
    resourceTypeOf('https://res.cloudinary.com/testcloud/auto/upload/x.png', 'application/zip') === 'raw',
    resourceTypeOf('https://res.cloudinary.com/testcloud/auto/upload/x.png', 'application/zip'));
  check('with nothing to go on it is a raw file, never auto',
    resourceTypeOf('', '') === 'raw' && resourceTypeOf('not a url', '') === 'raw',
    `${resourceTypeOf('', '')}/${resourceTypeOf('not a url', '')}`);
});

await t('a delete still lands when the destroy fails', async (env) => {
  // Cloudinary being unreachable must not decide whether a takedown happens.
  // Once the row is gone the bytes are unreachable through the site anyway, so
  // holding the delete hostage to a third party would leave removed content
  // sitting in the feed.
  const calls = [];
  const restore = stubCloudinary(calls);
  const cenv = cloudEnv();
  try {
    const created = await publish(cenv);
    const up = await call(worker, cenv, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'shot.png', 'content-length': String(PNG.length) },
    });
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/destroy')) throw new Error('cloudinary is down');
      return real(url, init);
    };
    const del = await call(worker, cenv, `/api/files/${up.json.file.id}`, { method: 'DELETE', secret: created.secret });
    check('the file row is gone anyway', del.status === 200, `got ${del.status}: ${del.text.slice(0, 120)}`);
    const gone = await call(worker, cenv, `/api/items/${created.item.id}`);
    check('and the post no longer advertises the file', !gone.json.files?.length, JSON.stringify(gone.json.files));
  } finally { restore(); }
});

await t('a shared asset survives until the last reference is gone', async (env) => {
  const calls = [];
  const restore = stubCloudinary(calls);
  const cenv = cloudEnv();
  try {
    const a = await publish(cenv);
    const b = await publish(cenv);
    const upA = await call(worker, cenv, `/api/items/${a.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'one.png', 'content-length': String(PNG.length) },
    });
    const upB = await call(worker, cenv, `/api/items/${b.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'two.png', 'content-length': String(PNG.length) },
    });
    check('both posts reference the same public id',
      calls[0].fields.public_id === calls[1].fields.public_id,
      `${calls[0].fields.public_id} / ${calls[1].fields.public_id}`);
    await call(worker, cenv, `/api/files/${upA.json.file.id}`, { method: 'DELETE', secret: a.secret });
    check('asset kept while the second post still has it', calls.filter((c) => c.href.includes('/destroy')).length === 0);
    await call(worker, cenv, `/api/files/${upB.json.file.id}`, { method: 'DELETE', secret: b.secret });
    check('asset destroyed after the last reference', calls.filter((c) => c.href.includes('/destroy')).length === 1);
    check('upB was a real row', upB.status === 201);
  } finally { restore(); }
});

await t('a cloudinary outage is an error, not a file that 500s later', async (env) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.cloudinary.com')) return new Response('nope', { status: 500 });
    return real(url, init);
  };
  const cenv = cloudEnv();
  try {
    const created = await publish(cenv);
    const up = await call(worker, cenv, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'shot.png', 'content-length': String(PNG.length) },
    });
    check('upload fails loudly', up.status >= 500, `got ${up.status}`);
    check('no row was written', (await call(worker, cenv, `/api/items/${created.item.id}`, { secret: created.secret }))
      .json?.item?.files?.length === 0);
  } finally {
    globalThis.fetch = real;
  }
});

/* ------------------------------------------------------------------ limits */

await t('a file may be 50 MB for a registered author once the store can hold it', async (env) => {
  // With the secrets in place the bytes go to Cloudinary, so the provider has to
  // be stubbed here: the point of this test is the ceiling, not the upload.
  const calls = [];
  const restore = stubCloudinary(calls);
  try {
    const env50 = cloudEnv({ MAX_FILE_MB: '50', WRITE_CAP: '900' });
    const created = await publish(env50);
    // Declared only: the Worker must trust the header enough to refuse, and the
    // buffer stays tiny, so this proves the ceiling without writing 50 MB.
    const over = await call(worker, env50, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'big.zip', 'content-length': String(51 * 1024 * 1024) },
    });
    check('a declared 51 MB file is refused', over.status === 413, `got ${over.status}`);
    check('the refusal names the cap', over.json?.maxBytes === 50 * 1024 * 1024, JSON.stringify(over.json));
    const ok = await call(worker, env50, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: PNG, headers: { 'x-filename': 'ok.zip', 'content-length': String(50 * 1024 * 1024) },
    });
    check('a 50 MB declaration is accepted', ok.status === 201, `got ${ok.status} ${ok.text.slice(0, 120)}`);
  } finally { restore(); }

  // The same deployment without the secrets cannot take 50 MB, and has to say so
  // rather than accept the request and fail at the provider's write.
  const kvEnv = makeEnv({ REG_NEW_ITEMS_PER_DAY: '50', ANON_NEW_ITEMS_PER_DAY: '50', MAX_FILE_MB: '50' });
  const kvCreated = await publish(kvEnv);
  const kvOver = await call(worker, kvEnv, `/api/items/${kvCreated.item.id}/files`, {
    method: 'POST', body: PNG, headers: { 'x-filename': 'big.zip', 'content-length': String(30 * 1024 * 1024) },
  });
  check('a 30 MB file is refused while the store is kv', kvOver.status === 413, `got ${kvOver.status}`);
  check('that refusal names the kv ceiling, not the configured 50 MB',
    kvOver.json?.maxBytes === KV_MAX_PUT_BYTES, JSON.stringify(kvOver.json));
});

await t('up to 60 files may hang off one item', async (env) => {
  const e = makeEnv({ REG_NEW_ITEMS_PER_DAY: '50', ANON_NEW_ITEMS_PER_DAY: '50', MAX_FILES: '60' });
  const created = await publish(e);
  let last = 0;
  for (let i = 0; i < 60; i++) {
    const r = await call(worker, e, `/api/items/${created.item.id}/files`, {
      method: 'POST', body: new Uint8Array(PNG.byteLength + i), headers: { 'x-filename': `f${i}.txt` },
    });
    last = r.status;
  }
  check('the 60th file is accepted', last === 201, `got ${last}`);
  const over = await call(worker, e, `/api/items/${created.item.id}/files`, {
    method: 'POST', body: PNG, headers: { 'x-filename': 'f60.txt' },
  });
  check('the 61st is refused', over.status === 409, `got ${over.status}`);
});

/* -------------------------------------------------------------- game chips */

await t('an item records which game it is for', async (env) => {
  const created = await publish(env, {
    gameId: '2753915549',
    gameName: 'Blox Fruits',
    gameAuthor: 'Gamer Robot',
    gameCover: 'https://tr.rbxcdn.com/30DAY-AvatarHeadshot.png',
    keySystem: 'KRN',
  });
  const item = created.item;
  check('game id kept', item.game?.id === '2753915549', JSON.stringify(item.game));
  check('game name kept', item.game?.name === 'Blox Fruits', item.game?.name);
  check('game author kept', item.game?.author === 'Gamer Robot', item.game?.author);
  check('cover kept', item.game?.cover === 'https://tr.rbxcdn.com/30DAY-AvatarHeadshot.png', item.game?.cover);
  check('key system kept', item.keySystem === 'KRN', item.keySystem);
});

await t('a paste with no game reports no game rather than an empty object', async (env) => {
  const created = await publish(env);
  check('game is null', created.item.game === null, JSON.stringify(created.item.game));
  check('no key system', created.item.keySystem === '', created.item.keySystem);
});

await t('game fields are capped, stripped and validated', async (env) => {
  const long = 'x'.repeat(500);
  const created = await publish(env, {
    gameId: long, gameName: long, gameAuthor: long, keySystem: long,
  });
  check('an absurd id is dropped', created.item.game === null, JSON.stringify(created.item.game));
  check('an absurd key system is cut', created.item.keySystem.length === 40, `${created.item.keySystem.length}`);

  const evil = await publish(env, { gameId: '1', gameCover: 'javascript:alert(1)' });
  check('a javascript: cover is refused', evil.item.game.cover === '', evil.item.game.cover);
  const data = await publish(env, { gameId: '1', gameCover: 'data:image/png;base64,AAAA' });
  check('a data: cover is refused', data.item.game.cover === '', data.item.game.cover);
  const ok = await publish(env, { gameId: '1', gameCover: 'https://cdn.example.com/cover.png?v=2' });
  check('an https cover is kept', ok.item.game.cover.includes('cover.png'), ok.item.game.cover);
  const badExt = await publish(env, { gameId: '1', gameCover: 'https://cdn.example.com/cover.html' });
  // A url ending in `.html` is kept, and this is deliberate. It cannot do
  // anything: the cover is only ever the `src` of an <img>, and a browser that
  // fetches an HTML document there decodes nothing and runs nothing - the
  // difference between that and a real problem is the scheme, not the suffix.
  // Refusing it by filename is what broke every Roblox cover, whose urls end in
  // `Png/noFilter`. The checks that matter are the ones above plus the
  // attribute-breakout characters in the next test.
  check('a cover whose path is not an image is the browser\'s problem, not ours',
    badExt.item.game.cover === 'https://cdn.example.com/cover.html', badExt.item.game.cover);
});

await t('editing a paste can change and clear the game', async (env) => {
  const created = await publish(env, { gameId: '11', gameName: 'Old', keySystem: 'A' });
  const changed = await call(worker, env, `/api/items/${created.item.id}`, {
    method: 'PATCH', secret: created.secret,
    body: JSON.stringify({ gameId: '22', gameName: 'New', gameAuthor: 'Someone', keySystem: 'B' }),
  });
  check('name replaced', changed.json?.item?.game?.name === 'New', JSON.stringify(changed.json?.item?.game));
  check('author replaced', changed.json?.item?.game?.author === 'Someone', changed.json?.item?.game?.author);
  check('key system replaced', changed.json?.item?.keySystem === 'B', changed.json?.item?.keySystem);

  const cleared = await call(worker, env, `/api/items/${created.item.id}`, {
    method: 'PATCH', secret: created.secret, body: JSON.stringify({ gameId: '', keySystem: '' }),
  });
  check('the game is gone, not merged', cleared.json?.item?.game === null, JSON.stringify(cleared.json?.item?.game));
  check('the key system is gone', cleared.json?.item?.keySystem === '', cleared.json?.item?.keySystem);
  check('a patch that says nothing about games leaves it alone',
    (await call(worker, env, `/api/items/${created.item.id}`, {
      method: 'PATCH', secret: created.secret, body: JSON.stringify({ title: 'renamed' }),
    })).json?.item?.keySystem === '');
});

await t('a feed shows the game chip without leaking anything else', async (env) => {
  await publish(env, { gameId: '777', gameName: 'Chip', gameAuthor: 'Author', keySystem: 'K' });
  const feed = await call(worker, env, '/api/items?limit=10');
  const row = feed.json.items.find((i) => i.game?.id === '777');
  check('the chip is in the feed', !!row, JSON.stringify(feed.json.items.map((i) => i.game)));
  check('no secret in the chip', !JSON.stringify(row.game).includes('secret_hash'));
  check('files of a public post are listed as before', Array.isArray(row.files));
});

/* ------------------------------------------------------------- url helpers */

await t('transformations are only applied where they mean something', async () => {
  const img = 'https://res.cloudinary.com/c/image/upload/abc123.png';
  check('image preview', previewUrl(img).includes('/upload/c_limit,w_1400') && previewUrl(img).endsWith('/abc123.png'), previewUrl(img));
  check('image thumb', thumbUrl(img).includes('c_fill,w_320'), thumbUrl(img));
  const raw = 'https://res.cloudinary.com/c/raw/upload/abc123.zip';
  check('raw is left alone', thumbUrl(raw) === raw, thumbUrl(raw));
  check('a non-cloudinary url is left alone', transformed('https://example.com/a.png', 'c_limit') === 'https://example.com/a.png');
  check('an empty url is left alone', previewUrl('') === '');
});

/* ---------------------------------------------------------- game lookup -- */

/**
 * Stands in for the three Roblox endpoints the lookup uses and counts hits, so
 * the cache can be proved rather than assumed: a second identical request has to
 * be served from KV without touching Roblox again.
 */
function stubRoblox(hits) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!/roblox\.com/.test(href)) return real(url, init);
    hits.push(href);
    if (href.includes('/universes/v1/places/')) {
      const place = href.split('/places/')[1].split('/')[0];
      if (place !== '1818') return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ universeId: 909090 }), { status: 200 });
    }
    if (href.includes('/v1/games?')) {
      return new Response(JSON.stringify({ data: [{
        name: 'Fake Game', description: 'd',
        creator: { name: 'Fake Studio', userName: 'FakeStudio' },
        playing: 12, visits: 3456,
      }] }), { status: 200 });
    }
    if (href.includes('/games/icons')) {
      return new Response(JSON.stringify({
        data: [{ targetId: 909090, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/icon.png' }],
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

await t('a Roblox place id resolves to a chip, and the answer is cached', async (env) => {
  const hits = [];
  const restore = globalThis.fetch;
  stubRoblox(hits);
  try {
    const first = await call(worker, env, '/api/games/roblox/1818');
    check('200', first.status === 200, `${first.status} ${first.text.slice(0, 160)}`);
    check('name filled', first.json?.gameName === 'Fake Game', JSON.stringify(first.json));
    check('author filled', first.json?.gameAuthor === 'Fake Studio', JSON.stringify(first.json));
    check('cover filled', first.json?.gameCover === 'https://tr.rbxcdn.com/icon.png', JSON.stringify(first.json));
    // The chip stores the universe id, not the place id that was typed: the
    // universe is what survives a game's place being replaced or a private
    // place existing alongside the public one.
    check('id is the universe', first.json?.gameId === '909090', `${first.json?.gameId}`);
    check('not cached on a miss', first.json?.cached === false);
    const callsAfterFirst = hits.length;

    const second = await call(worker, env, '/api/games/roblox/1818');
    check('second 200', second.status === 200);
    check('served from cache', second.json?.cached === true, JSON.stringify(second.json));
    check('upstream not called again', hits.length === callsAfterFirst, `${hits.length - callsAfterFirst} extra calls`);
  } finally {
    globalThis.fetch = restore;
  }
});

await t('a universe id is accepted without a place lookup succeeding', async (env) => {
  const hits = [];
  const restore = globalThis.fetch;
  stubRoblox(hits);
  try {
    const r = await call(worker, env, '/api/games/roblox/909090');
    check('200', r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
    check('name filled', r.json?.gameName === 'Fake Game', JSON.stringify(r.json));
  } finally {
    globalThis.fetch = restore;
  }
});

await t('a game that does not exist is a 404, not a chip with holes', async (env) => {
  const hits = [];
  const restore = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    hits.push(String(url));
    return new Response('{}', { status: 404 });
  };
  try {
    const r = await call(worker, env, '/api/games/roblox/424242');
    check('404', r.status === 404, `got ${r.status} ${r.text.slice(0, 160)}`);
    check('says so in Russian', /не найдена/i.test(String(r.json?.error)), JSON.stringify(r.json));
  } finally {
    globalThis.fetch = restore;
  }
});

await t('a slow Roblox does not hang the request', async (envIn) => {
  // A stub that never resolves is the only honest way to prove the deadline
  // exists: without the abort signal the call would wait for the test runner
  // itself, which is a long time to wait for a failing test.
  const env = makeEnv({ ...envIn, ROBLOX_TIMEOUT_MS: '150' });
  const restore = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  // AbortSignal.timeout does not hold the event loop open on its own, so without
  // this the process would exit with the test still pending - which is exactly
  // what an unanswered request looks like from the outside.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    const started = Date.now();
    const r = await call(worker, env, '/api/games/roblox/777');
    check('still answers', r.status === 404, `got ${r.status}`);
    check('answers on the deadline, not on a test timeout', Date.now() - started < 2000, `${Date.now() - started}ms`);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = restore;
  }
});

await t('a game chip survives the round trip and shows up on the item', async (env) => {
  const created = await publish(env, {
    type: 'script', language: 'luau',
    gameId: '909090', gameName: 'Fake Game', gameAuthor: 'Fake Studio',
    gameCover: 'https://tr.rbxcdn.com/icon.png', keySystem: 'Moon',
  });
  check('game kept', created.item?.game?.name === 'Fake Game', JSON.stringify(created.item?.game));
  check('author kept', created.item?.game?.author === 'Fake Studio');
  check('cover kept', created.item?.game?.cover === 'https://tr.rbxcdn.com/icon.png');
  check('key system kept', created.item?.keySystem === 'Moon', JSON.stringify(created.item?.keySystem));

  const read = await call(worker, env, `/api/items/${created.item.id}`);
  check('still there after a reload', read.json?.item?.game?.name === 'Fake Game', JSON.stringify(read.json?.item?.game));
  check('key system still there', read.json?.item?.keySystem === 'Moon');
});

await t('a chip cannot smuggle a dangerous cover url into the page', async (env) => {
  const created = await publish(env, {
    type: 'script', language: 'luau',
    gameId: '1', gameName: 'X', gameAuthor: 'Y', gameCover: 'javascript:alert(1)',
  });
  check('cover dropped', created.item?.game?.cover === '', JSON.stringify(created.item?.game));
  check('name still kept', created.item?.game?.name === 'X', JSON.stringify(created.item?.game));
});

await t('a game page lists that game\'s posts and only those', async (env) => {
  // Three posts: two about one game, one about another, one about none. Without
  // the odd one out a filter that ignored its argument would look right, and
  // without the second game a filter that returned a game's first post would too.
  const a1 = await publish(env, {
    type: 'script', language: 'luau', title: 'под первую игру',
    gameId: '111', gameName: 'First', gameAuthor: 'Studio One',
  });
  const a2 = await publish(env, {
    type: 'script', language: 'luau', title: 'ещё под первую игру',
    gameId: '111', gameName: 'First', gameAuthor: 'Studio One',
  });
  const b1 = await publish(env, {
    type: 'script', language: 'luau', title: 'под вторую игру',
    gameId: '222', gameName: 'Second', gameAuthor: 'Studio Two',
  });
  const none = await publish(env, { type: 'script', language: 'luau', title: 'вообще без игры' });

  const page = await call(worker, env, '/api/items?game=111&limit=60');
  check('both posts of that game are listed', page.status === 200 && page.json.items.length === 2,
    `${page.status} ${JSON.stringify(page.json?.items?.map((i) => i.title))}`);
  check('and nothing else is',
    page.json.items.every((i) => i.game?.id === '111'),
    JSON.stringify(page.json?.items?.map((i) => [i.title, i.game?.id])));
  check('the count is the game\'s, not the site\'s', page.json.total === 2, `${page.json.total}`);

  const other = await call(worker, env, '/api/items?game=222&limit=60');
  check('the other game lists its own post only',
    other.json.items.length === 1 && other.json.items[0].id === b1.item.id,
    JSON.stringify(other.json?.items?.map((i) => i.title)));
  check('the second post of the first game is not on it',
    !other.json.items.some((i) => i.id === a2.item.id));

  // A game nobody has posted about is an empty page, not an error and not the
  // whole feed - the empty state is what the view renders for it.
  const empty = await call(worker, env, '/api/items?game=999');
  check('a game with no posts is an empty list, not the whole feed',
    empty.status === 200 && empty.json.items.length === 0 && empty.json.total === 0,
    `${empty.status} ${JSON.stringify(empty.json)}`);

  // A game id that is present but not a number is a mistake, and answering it
  // with the whole feed is the worst possible answer: the caller cannot tell
  // "this filter matched nothing" from "this filter was ignored".
  for (const query of ['game=abc', 'game=111x', 'game=1;DROP', 'game=-1', 'game=1.5']) {
    const listed = await call(worker, env, `/api/items?${query}`);
    check(`?${query} is refused instead of quietly dropping the filter`,
      listed.status === 400, `${listed.status} ${listed.text.slice(0, 80)}`);
  }
  // An id that is a number but no game's is simply an empty page, while a blank
  // value means the caller did not ask about a game at all and gets the feed.
  for (const query of ['game=', 'game=%20']) {
    const listed = await call(worker, env, `/api/items?${query}&limit=60`);
    check(`?${query} is the same as not filtering by game at all`,
      listed.status === 200 && listed.json.items.length === 4, `${listed.status} ${listed.json?.items?.length}`);
  }
  const zero = await call(worker, env, '/api/items?game=0');
  check('a numeric id nobody used is an empty page, not the feed',
    zero.status === 200 && zero.json.items.length === 0, `${zero.status} ${zero.json?.items?.length}`);

  // The filter has to compose with the rest of the query, not replace it.
  const both = await call(worker, env, '/api/items?game=111&type=script&limit=60');
  check('a game page still honours the type filter',
    both.json.items.every((i) => i.type === 'script' && i.game?.id === '111'),
    JSON.stringify(both.json?.items?.map((i) => [i.type, i.game?.id])));
  const wrongType = await call(worker, env, '/api/items?game=111&type=paste&limit=60');
  check('and can be emptied by it', wrongType.json.items.length === 0, JSON.stringify(wrongType.json?.items));
  // The post that mentions no game is on no game's page, and is still on the feed.
  const onFeed = await call(worker, env, '/api/items?limit=60');
  check('a post with no game is still on the feed itself',
    onFeed.json.items.some((i) => i.id === none.item.id), `${onFeed.json.items.length} on the feed`);
  check('and on neither of the game pages',
    !page.json.items.some((i) => i.id === none.item.id) && !other.json.items.some((i) => i.id === none.item.id));
  check('the first post is still reachable by id', a1.item.id.length > 0);
});

await t('a real Roblox cover url survives, because it has no file extension', async (env) => {
  // Taken from the live thumbnails API, which answers with a format token at the
  // end of the path rather than a filename:
  //   https://tr.rbxcdn.com/180DAY-…/150/150/GameIcon6/Png/noFilter
  // A validator that insists on `.png` throws away every cover this Worker
  // fetched, and the only trace is a chip with no picture and no error.
  const real = 'https://tr.rbxcdn.com/180DAY-371b5546509ab0eb0fe7f05d37bf34be/150/150/GameIcon6/Png/noFilter';
  const created = await publish(env, {
    type: 'script', language: 'luau',
    gameId: '2753915549', gameName: 'Blox Fruits', gameAuthor: 'Gamer Robot',
    gameCover: real,
  });
  check('the cover url is kept as it came', created.item?.game?.cover === real,
    JSON.stringify(created.item?.game?.cover));
  const read = await call(worker, env, `/api/items/${created.item.id}`);
  check('and survives a reload', read.json?.item?.game?.cover === real,
    JSON.stringify(read.json?.item?.game?.cover));
});

await t('a cover url is refused for its scheme, not for its filename', async (env) => {
  // Each of these is a way of getting something other than a picture into the
  // <img> the chip renders. The two that matter most are the executable schemes.
  const refused = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'vbscript:msgbox(1)',
    'http://tr.rbxcdn.com/icon.png',
    '//tr.rbxcdn.com/icon.png',
    'https://x/"><script>alert(1)</script>',
    "https://x/'onerror='alert(1)",
    'https://x/ icon.png',
    'https://x/\nicon.png',
    'https://',
    'not a url at all',
  ];
  for (const cover of refused) {
    const created = await publish(env, {
      type: 'script', language: 'luau', gameId: '5', gameName: 'X', gameAuthor: 'Y', gameCover: cover,
    });
    check(`${JSON.stringify(cover).slice(0, 44)} is dropped`, created.item?.game?.cover === '',
      JSON.stringify(created.item?.game?.cover));
  }
  // The chip itself is still usable without a cover: an author who typed nothing,
  // or a lookup that returned no icon, is not a reason to lose the game.
  const bare = await publish(env, { type: 'script', language: 'luau', gameId: '5', gameName: 'X' });
  check('a chip with no cover at all is still kept', bare.item?.game?.name === 'X'
    && bare.item?.game?.cover === '', JSON.stringify(bare.item?.game));
});

await t('the advertised file size is what the store can actually take', async (env) => {
  // Without Cloudinary the upload path is KV, whose own ceiling is below
  // MAX_FILE_MB. Advertising MAX_FILE_MB there would let the browser pre-approve a
  // 30 MB file that the store then refuses mid-upload, which reads as a server
  // fault rather than as a limit.
  const kv = await call(worker, env, '/api/config');
  check('kv mode says so', kv.json.storage === 'kv', JSON.stringify(kv.json.storage));
  check('kv mode caps at the kv ceiling', kv.json.limits.maxFileBytes === KV_MAX_PUT_BYTES,
    `${kv.json.limits.maxFileBytes} vs ${KV_MAX_PUT_BYTES}`);
  check('the kv ceiling is under the kv hard limit', KV_MAX_PUT_BYTES < 25 * 1024 * 1024,
    String(KV_MAX_PUT_BYTES));
  check('kv store reports the same ceiling', new BlobStore(env).maxPutBytes === KV_MAX_PUT_BYTES);

  const cloud = await call(worker, cloudEnv(), '/api/config');
  check('cloud mode says so', cloud.json.storage === 'cloudinary', JSON.stringify(cloud.json.storage));
  check('cloud mode advertises the configured cap',
    cloud.json.limits.maxFileBytes === 50 * 1024 * 1024, String(cloud.json.limits.maxFileBytes));
  check('the cloud store does not impose its own ceiling',
    new BlobStore(cloudEnv()).maxPutBytes === Infinity);

  // A half-configured deployment must not claim 50 MB either: that is exactly the
  // state where the secrets were typed and only one of them took.
  const half = await call(worker, makeEnv({ CLOUDINARY_CLOUD_NAME: 'testcloud', MAX_FILE_MB: '50' }), '/api/config');
  check('a partial cloudinary config is treated as kv', half.json.storage === 'kv',
    JSON.stringify(half.json.storage));
  check('a partial config does not advertise the cloudinary cap',
    half.json.limits.maxFileBytes === KV_MAX_PUT_BYTES, String(half.json.limits.maxFileBytes));

  // And a smaller MAX_FILE_MB still wins: the configured cap is a ceiling, not a
  // suggestion to raise when the store allows more.
  const small = await call(worker, cloudEnv({ MAX_FILE_MB: '2' }), '/api/config');
  check('a smaller configured cap is not overridden by the store',
    small.json.limits.maxFileBytes === 2 * 1024 * 1024, String(small.json.limits.maxFileBytes));
  const smallKv = await call(worker, makeEnv({ MAX_FILE_MB: '2' }), '/api/config');
  check('the same holds on kv', smallKv.json.limits.maxFileBytes === 2 * 1024 * 1024,
    String(smallKv.json.limits.maxFileBytes));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
