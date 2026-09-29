/**
 * Client-contract tests.
 * Run with: node worker/test/client.test.mjs
 *
 * Everything else in the suite calls the worker directly. That is the right way
 * to test a worker, and it is also why two shipping bugs went unnoticed:
 *
 *   - the proof of work was sent in the request body by the browser and read from
 *     headers by the server, so registration could never succeed;
 *   - the session and proof-of-work headers were missing from the CORS
 *     allow-list, so every authenticated call failed in a real browser with a
 *     CORS error and passed in every test.
 *
 * A direct call has no preflight and no browser, so neither is visible here. This
 * file closes that gap by replaying the sequence public/app.js performs, using the
 * client's own algorithms and the exact headers it sets, and by asserting the
 * preflight response covers those headers.
 *
 * The browser's proof-of-work loop is reimplemented here on purpose: importing
 * the server's solver instead would only prove the server agrees with itself.
 */
import { readFileSync } from 'node:fs';
import { makeEnv, call, answerQuestion } from './harness.mjs';
import worker from '../src/index.js';
import {
  PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS, hashPassword, verifyPassword,
} from '../src/accounts.js';

const CLIENT_SRC = new URL('../../public/app.js', import.meta.url);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

async function t(name, fn) {
  const env = makeEnv();
  try {
    await fn(env);
  } catch (err) {
    fail++;
    failures.push(`${name} threw: ${err.message}`);
  }
}

const enc = new TextEncoder();

/** The client id the browser generates once and keeps for the session. */
const CLIENT_ID = 'clientcontract01';
/** A third identity, for "the author's own item, seen from another browser". */
const THREE = 'clientcontract03';

/** The client's solvePow, transcribed from public/app.js. */
async function clientSolvePow(challenge, bits, maxTries = 5e6) {
  for (let nonce = 0; nonce < maxTries; nonce++) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}.${nonce}`)),
    );
    let zeros = 0;
    for (let i = 0; i < digest.length && digest[i] === 0; i++) zeros += 8;
    if (zeros < digest.length * 8 && digest[zeros >> 3]) {
      zeros += Math.clz32(digest[zeros >> 3]) - 24;
    }
    if (zeros >= bits) return String(nonce);
  }
  return null;
}

/**
 * One round trip exactly as api() in public/app.js performs it.
 *
 * `client` is passed as an option rather than folded into `headers`, because the
 * harness sets the client header from its own option and would overwrite a
 * hand-written one. Sessions are bound to the client id, so a mismatch here
 * reads as "login required" for reasons that have nothing to do with the route.
 * `client: null` means "send no client header at all", which the harness spells
 * `id: null` - a present-but-falsy client would silently fall back to its default.
 */
async function clientApi(env, path, { method = 'GET', body, session, secret, headers, client = CLIENT_ID } = {}) {
  const opts = { method, body, session, secret };
  if (client === null) opts.id = null;
  else opts.client = client;
  const withClient = client === null ? { ...(headers || {}) } : { 'x-cheatlab-client': client, ...(headers || {}) };
  return call(worker, env, path, { ...opts, headers: withClient });
}

/** Register through the real route, the way the auth view does it. */
async function clientRegister(env, nick, client = CLIENT_ID) {
  const config = await clientApi(env, '/api/config');
  const bits = Math.min(30, Math.max(8, Number(config.json?.powBits) || 18));
  const { challenge } = (await clientApi(env, '/api/auth/pow')).json;
  const nonce = await clientSolvePow(challenge, bits);
  const res = await call(worker, env, '/api/auth/register', {
    method: 'POST',
    client,
    body: { nick, password: 'Tr0ub4dor-and-3-ducks' },
    headers: {
      'x-cheatlab-client': client,
      'x-cheatlab-pow': challenge,
      'x-cheatlab-pow-nonce': nonce,
    },
  });
  return { res, bits, challenge, nonce };
}

/* --------------------------------------------------------------- the flow -- */

await t('a person can register from the browser and land on a usable session', async (env) => {
  // POW_BITS is lowered in the test env, so this is fast; the difficulty itself
  // is asserted against the advertised value rather than assumed.
  const { res, bits, challenge, nonce } = await clientRegister(env, 'flowuser');
  check('registration accepted', res.status === 201, `got ${res.status} ${res.text.slice(0, 200)}`);
  check('a token is returned', typeof res.json?.token === 'string');
  check('a user is returned', res.json?.user?.nick === 'flowuser', JSON.stringify(res.json?.user));
  check('difficulty came from /api/config', bits >= 8 && bits <= 30, `got ${bits}`);
  check('the nonce was actually solved', typeof nonce === 'string' && nonce.length > 0);
  check('the challenge was solved for', challenge && typeof challenge === 'string');

  // The session header is what every later request carries.
  const me = await clientApi(env, '/api/auth/me', { session: res.json.token });
  check('/api/auth/me resolves the session', me.json?.user?.nick === 'flowuser', me.text.slice(0, 200));
  check('registered quota advertised', me.json?.quota?.newItemsPerDay === 4, `${me.json?.quota?.newItemsPerDay}`);
  check('registered exempt from captcha', me.json?.quota?.captchaOnPost === false);
});

await t('a profile page has everything it renders', async (env) => {
  const a = await clientRegister(env, 'alice');
  check('alice registered', a.res.status === 201, a.res.text.slice(0, 160));
  const alice = a.res.json.user;

  const profile = await clientApi(env, `/api/users/${alice.id}`);
  check('profile loads', profile.status === 200, `${profile.status} ${profile.text.slice(0, 160)}`);
  check('user present', profile.json?.user?.nick === 'alice');
  check('isFollowing present and false', profile.json?.isFollowing === false, `${profile.json?.isFollowing}`);
  check('items is an array', Array.isArray(profile.json?.items));
  // The view reads these directly, so a missing field renders as undefined.
  for (const field of ['id', 'nick', 'bio', 'followers', 'following', 'posts', 'createdAt']) {
    check(`profile has ${field}`, profile.json?.user?.[field] !== undefined, JSON.stringify(profile.json?.user));
  }

  // Bio editing, as the profile form does.
  const patched = await clientApi(env, '/api/auth/me', {
    method: 'PATCH', session: a.res.json.token, body: { bio: 'hello there' },
  });
  check('bio saved', patched.json?.user?.bio === 'hello there', patched.text.slice(0, 160));

  // Follow, as the follow button does: POST then DELETE, reading `following`.
  // Bob is a second browser, so every call he makes carries his own client id.
  const BOB_CLIENT = 'clientcontract02';
  const b = await clientRegister(env, 'bob', BOB_CLIENT);
  check('bob registered', b.res.status === 201, b.res.text.slice(0, 160));
  const bob = b.res.json;

  const follow = await clientApi(env, `/api/users/${alice.id}/follow`, {
    method: 'POST', session: bob.token, client: BOB_CLIENT,
  });
  check('follow accepted', follow.status === 200, `${follow.status} ${follow.text.slice(0, 160)}`);
  check('response reports following', follow.json?.following === true, JSON.stringify(follow.json));

  const after = await clientApi(env, `/api/users/${alice.id}`, { session: bob.token, client: BOB_CLIENT });
  check('profile reflects the follow for the viewer who made it', after.json?.isFollowing === true, `${after.json?.isFollowing}`);
  check('follower count incremented', after.json?.user?.followers === 1, `${after.json?.user?.followers}`);
  // And it must not leak to a signed-out visitor.
  const anon = await clientApi(env, `/api/users/${alice.id}`);
  check('an anonymous visitor is not told who follows', anon.json?.isFollowing === false, `${anon.json?.isFollowing}`);

  const followers = await clientApi(env, `/api/users/${alice.id}/followers`);
  check('followers list loads', followers.status === 200, `${followers.status}`);
  check('bob is listed', followers.json?.users?.some((u) => u.nick === 'bob'), JSON.stringify(followers.json?.users));

  const unfollow = await clientApi(env, `/api/users/${alice.id}/follow`, {
    method: 'DELETE', session: bob.token, client: BOB_CLIENT,
  });
  check('unfollow reports following false', unfollow.json?.following === false, JSON.stringify(unfollow.json));

  // A session is bound to the browser it was issued to, so another client id
  // cannot borrow it. This is what stops a stolen token working elsewhere - and
  // it has to hold when the request simply omits the header, which is the one
  // thing the holder of a stolen token controls.
  const stolen = await clientApi(env, `/api/users/${alice.id}/follow`, {
    method: 'POST', session: bob.token, client: 'someotherclientid1',
  });
  check('the token does not work from another client', stolen.status === 401, `got ${stolen.status}`);

  const noHeader = await clientApi(env, `/api/users/${alice.id}/follow`, {
    method: 'POST', session: bob.token, client: null,
  });
  check('the token does not work with no client id', noHeader.status === 401, `got ${noHeader.status}`);

  const stillWorks = await clientApi(env, '/api/auth/me', { session: bob.token, client: BOB_CLIENT });
  check('and the owner is still signed in', stillWorks.json?.user?.nick === 'bob', JSON.stringify(stillWorks.json?.user));
});

await t('an anonymous visitor can still publish, and is asked to prove it', async (env) => {
  // The flow the publish button runs: post, receive a 403 with a question, answer
  // it, retry once.
  const first = await clientApi(env, '/api/items', {
    method: 'POST', body: { type: 'script', title: 'anon', body: 'print(1)', language: 'python' },
  });
  check('first attempt is refused', first.status === 403, `got ${first.status}`);
  check('the error names the captcha', first.json?.error === 'captcha required', JSON.stringify(first.json));
  // The dialog reads `q`. A `question` key here would render an empty prompt and
  // make publishing impossible for exactly the users it protects.
  check('the challenge carries q', typeof first.json?.captcha?.q === 'string', JSON.stringify(first.json?.captcha));
  check('the challenge carries a token', typeof first.json?.captcha?.token === 'string');
  check('the answer is not in the response', first.json?.captcha?.answer === undefined);

  const answer = answerQuestion(first.json.captcha.q);
  const retry = await clientApi(env, '/api/items', {
    method: 'POST',
    body: {
      type: 'script', title: 'anon', body: 'print(1)', language: 'python',
      captchaToken: first.json.captcha.token, captchaAnswer: answer,
    },
  });
  check('second attempt succeeds', retry.status === 201, `${retry.status} ${retry.text.slice(0, 200)}`);
  check('an edit secret is returned', typeof retry.json?.secret === 'string');
  check('flagged as not registered', retry.json?.registered === false, `${retry.json?.registered}`);
  // Whether the challenge is single-use is asserted in auth.test.mjs: here the
  // daily cap of one anonymous post is reached, so a second post cannot tell a
  // spent captcha apart from an exhausted quota.
});

await t('a registered author publishes without ever seeing a captcha', async (env) => {
  const a = await clientRegister(env, 'author');
  const res = await clientApi(env, '/api/items', {
    method: 'POST', session: a.res.json.token,
    body: { type: 'paste', title: 'from account', body: 'no captcha needed' },
  });
  check('published', res.status === 201, `${res.status} ${res.text.slice(0, 200)}`);
  check('flagged as registered', res.json?.registered === true, `${res.json?.registered}`);

  // It must show up on the profile, which is what the profile view lists.
  const profile = await clientApi(env, `/api/users/${a.res.json.user.id}`);
  check('listed on the profile', profile.json?.items?.length === 1, `${profile.json?.items?.length}`);
  check('post count updated', profile.json?.user?.posts === 1, `${profile.json?.user?.posts}`);
});

await t('the social features the profile links to all require a session', async (env) => {
  const a = await clientRegister(env, 'author');
  const alice = a.res.json.user;
  for (const [method, path] of [
    ['POST', `/api/users/${alice.id}/follow`],
    ['POST', '/api/items/abcdefgh/like'],
    ['POST', '/api/items/abcdefgh/comments'],
  ]) {
    const res = await clientApi(env, path, { method, body: { body: 'hi' } });
    check(`${method} ${path} needs a session`, res.status === 401, `got ${res.status}`);
  }
});

/* ------------------------------------------------------------- access keys -- */

await t('a locked item hides its body and its files until the key is right', async (env) => {
  const a = await clientRegister(env, 'locker');
  const key = 'super-secret-key-42';
  const created = await clientApi(env, '/api/items', {
    method: 'POST', session: a.res.json.token,
    body: {
      type: 'script', title: 'vault', body: 'print("classified")',
      language: 'luau', accessKey: key, keyHint: 'ключ из профиля',
    },
  });
  check('published with a key', created.status === 201, `${created.status} ${created.text.slice(0, 200)}`);
  // The key comes back exactly once, like the edit secret. It is never readable again.
  check('the key is returned once, on publish', created.json?.accessKey === key, JSON.stringify(created.json?.accessKey));
  check('the stored key is never returned', created.json?.item?.accessKey === undefined);
  check('the item reports itself locked', created.json?.item?.locked === true);
  check('the hint is public', created.json?.item?.keyHint === 'ключ из профиля', created.json?.item?.keyHint);
  const id = created.json.item.id;

  // A file behind the same lock: the listing must not even reveal that it exists.
  const payload = new TextEncoder().encode('print("hi")\n');
  const up = await clientApi(env, `/api/items/${id}/files`, {
    method: 'POST', session: a.res.json.token, body: payload,
    headers: { 'x-filename': 'secret.lua', 'content-length': String(payload.byteLength) },
  });
  check('upload 201', up.status === 201, `${up.status} ${up.text.slice(0, 160)}`);
  const fileId = up.json?.file?.id;

  const GUEST = 'lockguest0000001';
  const locked = await clientApi(env, `/api/items/${id}`, { client: GUEST });
  check('a locked item still loads its page', locked.status === 200, `${locked.status}`);
  check('it reports locked', locked.json?.item?.locked === true);
  check('the body is withheld', locked.json?.item?.body === undefined, JSON.stringify(locked.json?.item).slice(0, 200));
  check('the preview is empty too', !locked.json?.item?.preview, `${locked.json?.item?.preview}`);
  check('no files are listed', (locked.json?.item?.files || []).length === 0);
  check('unlocked flag is false', locked.json?.item?.unlocked === false);
  check('the title is still there', locked.json?.item?.title === 'vault');

  // The feed must not leak the body either.
  const feed = await clientApi(env, '/api/items?limit=60', { client: GUEST });
  const inFeed = (feed.json?.items || []).find((i) => i.id === id);
  check('the feed hides it too', inFeed && inFeed.body === undefined && inFeed.preview === '');
  check('the feed still marks it locked', inFeed?.locked === true);

  const wrong = await clientApi(env, `/api/items/${id}`, {
    client: GUEST, headers: { 'x-cheatlab-key': 'nope' },
  });
  check('a wrong key does not open it', wrong.json?.item?.unlocked === false);
  check('a wrong key still hides the body', wrong.json?.item?.body === undefined);

  const viaHeader = await clientApi(env, `/api/items/${id}`, {
    client: GUEST, headers: { 'x-cheatlab-key': key },
  });
  check('the header key opens it', viaHeader.json?.item?.unlocked === true, JSON.stringify(viaHeader.json?.item?.unlocked));
  check('the body is returned', viaHeader.json?.item?.body === 'print("classified")');
  check('the files are listed', viaHeader.json?.item?.files?.length === 1, JSON.stringify(viaHeader.json?.item?.files));

  // Media and downloads cannot send headers, so the query parameter is the
  // other door. Without it they must refuse.
  const noKeyFile = await clientApi(env, `/f/${fileId}`, { client: GUEST });
  check('the file download is refused without a key', noKeyFile.status === 403, `got ${noKeyFile.status}`);
  const noKeyRaw = await clientApi(env, `/f/${fileId}/raw`, { client: GUEST });
  check('the raw route is refused too', noKeyRaw.status === 403, `got ${noKeyRaw.status}`);
  const noKeyPlain = await clientApi(env, `/r/${id}`, { client: GUEST });
  check('the plain-text route is refused', noKeyPlain.status === 403, `got ${noKeyPlain.status}`);

  const withKeyFile = await clientApi(env, `/f/${fileId}?key=${encodeURIComponent(key)}`, { client: GUEST });
  check('the download works with ?key=', withKeyFile.status === 200, `got ${withKeyFile.status}`);
  check('and returns the bytes', withKeyFile.text.includes('print("hi")'), withKeyFile.text.slice(0, 80));
  const withKeyRaw = await clientApi(env, `/f/${fileId}/raw?key=${encodeURIComponent(key)}`, { client: GUEST });
  check('raw works with ?key=', withKeyRaw.status === 200, `got ${withKeyRaw.status}`);

  // The explicit unlock route, as the form does.
  const bad = await clientApi(env, `/api/items/${id}/unlock`, { method: 'POST', client: GUEST, body: { key: 'nope' } });
  check('unlock rejects a wrong key', bad.status === 403, `got ${bad.status}`);
  const good = await clientApi(env, `/api/items/${id}/unlock`, { method: 'POST', client: GUEST, body: { key } });
  check('unlock accepts the right key', good.status === 200 && good.json?.unlocked === true, `${good.status} ${good.text.slice(0, 160)}`);
  const empty = await clientApi(env, `/api/items/${id}/unlock`, { method: 'POST', client: GUEST, body: {} });
  check('unlock without a key is a 400, not a 403', empty.status === 400, `got ${empty.status}`);

  // The owner can drop the lock again, and only with the edit secret.
  const noSecret = await clientApi(env, `/api/items/${id}`, { method: 'PATCH', client: CLIENT_ID, body: { accessKey: '' } });
  check('removing the key needs the edit secret', noSecret.status === 403, `got ${noSecret.status}`);
  const unlocked = await clientApi(env, `/api/items/${id}`, {
    method: 'PATCH', client: CLIENT_ID, secret: created.json.secret, body: { accessKey: '', keyHint: 'ignored' },
  });
  check('the owner removed the lock', unlocked.json?.item?.locked === false, JSON.stringify(unlocked.json?.item?.locked));
  const after = await clientApi(env, `/api/items/${id}`, { client: GUEST });
  check('and it is open again', after.json?.item?.unlocked === true && after.json?.item?.body === 'print("classified")');
  const fileAfter = await clientApi(env, `/f/${fileId}`, { client: GUEST });
  check('the file is open as well', fileAfter.status === 200, `got ${fileAfter.status}`);
});

/* --------------------------------------------------- editor and like buttons -- */

await t('the editor form sends keys in the way the server expects', async (env) => {
  // The editor cannot prefill the key field - the server only keeps a hash - so
  // "the author typed nothing" and "the author wants to drop the lock" have to
  // be distinguishable in the payload. This is the contract viewItem's panel
  // depends on: an untouched field must leave the lock alone.
  const a = await clientRegister(env, 'keyedit');
  const created = await clientApi(env, '/api/items', {
    method: 'POST', session: a.res.json.token,
    body: { type: 'paste', title: 'notes', body: 'v1', accessKey: 'first-key', keyHint: 'из профиля' },
  });
  check('published locked', created.json?.item?.locked === true);
  check('the edit secret comes back with the create', typeof created.json?.secret === 'string');
  const edit = created.json.secret;
  check('a fresh item really does carry an edit secret', edit && edit.length > 0, `${edit}`);

  // A save with the key field left blank: no accessKey in the body at all.
  const kept = await clientApi(env, `/api/items/${created.json.item.id}`, {
    method: 'PATCH', client: CLIENT_ID, secret: edit, body: { body: 'v2' },
  });
  check('an empty key field leaves the lock in place', kept.json?.item?.locked === true, JSON.stringify(kept.json?.item?.locked));
  check('and the hint survives too', kept.json?.item?.keyHint === 'из профиля', kept.json?.item?.keyHint);

  // Typing a new key replaces the old one, and the old one stops working.
  const replaced = await clientApi(env, `/api/items/${created.json.item.id}`, {
    method: 'PATCH', client: CLIENT_ID, secret: edit, body: { accessKey: 'second-key', keyHint: 'новый' },
  });
  check('a new key replaces the old', replaced.json?.item?.locked === true && replaced.json?.item?.keyHint === 'новый');
  const GUEST2 = 'keyguest0000002';
  const oldKey = await clientApi(env, `/api/items/${created.json.item.id}`, { client: GUEST2, headers: { 'x-cheatlab-key': 'first-key' } });
  check('the previous key no longer opens it', oldKey.json?.item?.unlocked === false);
  const newKey = await clientApi(env, `/api/items/${created.json.item.id}`, { client: GUEST2, headers: { 'x-cheatlab-key': 'second-key' } });
  check('the new key does', newKey.json?.item?.unlocked === true);
  // The body was edited while locked and is still delivered once opened.
  check('the edited body is what the key reveals', newKey.json?.item?.body === 'v2', newKey.json?.item?.body);

  // "Remove the lock" is an empty string, not an omitted field.
  const removed = await clientApi(env, `/api/items/${created.json.item.id}`, {
    method: 'PATCH', client: CLIENT_ID, secret: edit, body: { accessKey: '' },
  });
  check('an empty string drops the lock', removed.json?.item?.locked === false, JSON.stringify(removed.json?.item?.locked));
  check('and clears the hint with it', removed.json?.item?.keyHint === '', removed.json?.item?.keyHint);
});

await t('a locked post can still be liked, and the counts come back for the feed', async (env) => {
  // Liking is a reaction to the title and the author, so requiring the key for
  // it would make a locked publication un-likable by anyone but the author.
  const a = await clientRegister(env, 'liker');
  const created = await clientApi(env, '/api/items', {
    method: 'POST', session: a.res.json.token,
    body: { type: 'paste', title: 'open question', body: 'x', accessKey: 'read-me' },
  });
  const id = created.json.item.id;

  const LIKER_CLIENT = 'likeclient000001';
  const b = await clientRegister(env, 'fan', LIKER_CLIENT);
  const liked = await clientApi(env, `/api/items/${id}/like`, {
    method: 'POST', session: b.res.json.token, client: LIKER_CLIENT,
  });
  check('like accepted without the key', liked.status === 200, `${liked.status} ${liked.text.slice(0, 160)}`);
  check('the count is returned for the button label', liked.json?.likes === 1 && liked.json?.liked === true, JSON.stringify(liked.json));

  // The detail view reads `liked` straight from the item response, so the
  // button does not need its own request on load.
  const detail = await clientApi(env, `/api/items/${id}`, { session: b.res.json.token, client: LIKER_CLIENT });
  check('the detail response carries the like state', detail.json?.liked === true, JSON.stringify(detail.json?.liked));
  check('and the count', detail.json?.item?.likes === 1, JSON.stringify(detail.json?.item?.likes));
  const guest = await clientApi(env, `/api/items/${id}`, { client: 'likeguest000001' });
  check('a different account does not inherit the like', guest.json?.liked === false);
  check('but sees the total', guest.json?.item?.likes === 1);

  // The feed row renders a heart counter and a lock chip from these two fields.
  const feed = await clientApi(env, '/api/items?limit=60', { client: 'likeguest000001' });
  const row = (feed.json?.items || []).find((i) => i.id === id);
  check('the feed row exposes likes', row?.likes === 1, JSON.stringify(row?.likes));
  check('and the locked flag for the chip', row?.locked === true);

  const unliked = await clientApi(env, `/api/items/${id}/like`, {
    method: 'DELETE', session: b.res.json.token, client: LIKER_CLIENT,
  });
  check('unliking is a toggle back', unliked.json?.liked === false && unliked.json?.likes === 0, JSON.stringify(unliked.json));
  // Anonymous visitors get a 401 rather than a silent no-op, so the view can
  // send them to the auth page instead of pretending the tap worked.
  const anonLike = await clientApi(env, `/api/items/${id}/like`, { method: 'POST', client: 'likeanon00000001' });
  check('liking needs an account', anonLike.status === 401, `got ${anonLike.status}`);
});

/* ------------------------------------------------------------ view counting */
await t('a view counts once per browser, and never for the author', async (env) => {
  const a = await clientRegister(env, 'viewerless');
  const created = await clientApi(env, '/api/items', {
    method: 'POST', session: a.res.json.token, body: { type: 'paste', title: 'counted', body: 'hello' },
  });
  const id = created.json.item.id;
  const hits = async (client) => (await clientApi(env, `/api/items/${id}`, { client })).json?.item?.hits;

  const ONE = 'viewclient000001';
  const TWO = 'viewclient000002';
  const start = await hits(ONE);
  const afterFirst = await hits(ONE);
  const afterSecond = await hits(ONE);
  check('the first look counts', start === 1, `got ${start}`);
  check('a second look from the same browser does not count', afterSecond === afterFirst, `${afterFirst} then ${afterSecond}`);
  check('a new browser does count', (await hits(TWO)) === afterFirst + 1, `expected ${afterFirst + 1}`);
  // The author's own client id is the item author, so it is not a view at all.
  check('the author does not inflate their own counter', (await hits(CLIENT_ID)) === afterFirst + 1, `${await hits(CLIENT_ID)}`);

  // And the account-owner skip is a separate check from the author one: signing
  // in from a second browser gives a session bound to *that* client, so this
  // passes through identity() and is then excluded by owner, not by author.
  const second = await call(worker, env, '/api/auth/login', {
    method: 'POST', client: THREE, body: { nick: 'viewerless', password: 'Tr0ub4dor-and-3-ducks' },
  });
  check('signed in from another browser', second.status === 200, `${second.status} ${second.text.slice(0, 160)}`);
  const asOwner = await clientApi(env, `/api/items/${id}`, { client: THREE, session: second.json.token });
  check('the account owner is skipped from another browser too', asOwner.json?.item?.hits === afterFirst + 1, `${asOwner.json?.item?.hits}`);
});

/* ---------------------------------------------------------- profile design -- */

await t('a profile carries a logo, an accent and a background', async (env) => {
  const a = await clientRegister(env, 'designer');
  const token = a.res.json.token;
  const saved = await clientApi(env, '/api/auth/me', {
    method: 'PATCH', session: token,
    body: {
      logo: 'https://cdn.example.com/avatar.png',
      accent: '#7C5CFF',
      bg: 'linear-gradient(180deg, #101014, #1b1b24)',
    },
  });
  check('saved', saved.status === 200, `${saved.status} ${saved.text.slice(0, 200)}`);
  check('logo', saved.json?.user?.logo === 'https://cdn.example.com/avatar.png', saved.json?.user?.logo);
  check('accent', saved.json?.user?.accent === '#7c5cff', saved.json?.user?.accent);
  check('bg', saved.json?.user?.bg === 'linear-gradient(180deg, #101014, #1b1b24)', saved.json?.user?.bg);

  // Visible to anyone who loads the profile, and default to empty rather than
  // missing, so the view never has to guard for undefined.
  const seen = await clientApi(env, `/api/users/${a.res.json.user.id}`);
  for (const f of ['logo', 'accent', 'bg', 'admin']) {
    check(`the public profile has ${f}`, seen.json?.user?.[f] !== undefined, JSON.stringify(seen.json?.user));
  }
  check('the accent reaches the profile view', seen.json?.user?.accent === '#7c5cff');

  // Hostile input is dropped, not rendered.
  const junk = await clientApi(env, '/api/auth/me', {
    method: 'PATCH', session: token,
    body: {
      logo: 'javascript:alert(1)',
      accent: 'red; background:url(//evil)',
      bg: 'url(javascript:alert(1))',
    },
  });
  check('a javascript: logo is refused', junk.json?.user?.logo === '', JSON.stringify(junk.json?.user?.logo));
  check('an accent that is not #hex is refused', junk.json?.user?.accent === '', JSON.stringify(junk.json?.user?.accent));
  check('a url() background is refused', junk.json?.user?.bg === '', JSON.stringify(junk.json?.user?.bg));
  check('a logo is refused unless it is https', junk.json?.user?.logo === '');

  // The refusals above are only half the contract. A sanitizer that rejects
  // everything passes them while making the feature pointless, so a background
  // someone actually typed has to come back intact - including the colon that
  // gradient syntax needs, which is exactly what a naive allowlist drops.
  const grad = 'linear-gradient(180deg, #101014, #1b1b24)';
  const good = await clientApi(env, '/api/auth/me', {
    method: 'PATCH', session: token,
    body: { bg: grad, accent: '#7c5cff', logo: 'https://cdn.test/a.png' },
  });
  check('a real gradient survives', good.json?.user?.bg === grad, JSON.stringify(good.json?.user?.bg));
  check('a https logo survives', good.json?.user?.logo === 'https://cdn.test/a.png', JSON.stringify(good.json?.user?.logo));

  // A gradient is a wrapper, so the escape attempts have to be checked *inside*
  // one - a payload that only looks like a gradient should not slip through.
  for (const [what, bg] of [
    ['a url() hidden in a gradient', 'linear-gradient(180deg, url(//evil), #000)'],
    ['a second declaration after a gradient', 'linear-gradient(#000, #fff);background:url(//evil)'],
    ['an import after a gradient', 'linear-gradient(#000,#fff);@import "x"'],
  ]) {
    const atk = await clientApi(env, '/api/auth/me', { method: 'PATCH', session: token, body: { bg } });
    check(`${what} is refused`, atk.json?.user?.bg === '', JSON.stringify(atk.json?.user?.bg));
  }
});

/* -------------------------------------------------------------- admin badge -- */

await t('the admin badge is decided by the server, not by the client', async (env) => {
  const a = await clientRegister(env, 'root');
  const b = await clientRegister(env, 'normal', 'adminprobe0000002');
  const who = await clientApi(env, `/api/users/${a.res.json.user.id}`);
  check('nobody is an admin before the list exists', who.json?.user?.admin === false, JSON.stringify(who.json?.user?.admin));

  // The list is environment configuration, exactly like any other deploy fact.
  env.ADMIN_IDS = a.res.json.user.id;
  const promoted = await clientApi(env, `/api/users/${a.res.json.user.id}`);
  check('the listed user is flagged', promoted.json?.user?.admin === true, JSON.stringify(promoted.json?.user));
  const other = await clientApi(env, `/api/users/${b.res.json.user.id}`);
  check('anyone else is not', other.json?.user?.admin === false, JSON.stringify(other.json?.user));
  // And it is not something the client can claim for itself. The session is
  // bound to b's own browser, so this is a real authenticated request.
  const forged = await clientApi(env, '/api/auth/me', {
    method: 'PATCH', session: b.res.json.token, client: 'adminprobe0000002',
    body: { admin: true, logo: 'https://x.test/a.png' },
  });
  check('the request itself is accepted', forged.status === 200, `${forged.status} ${forged.text.slice(0, 160)}`);
  check('a client cannot promote itself', forged.json?.user?.admin === false, JSON.stringify(forged.json?.user));
});

/* ------------------------------------------------------------- source sync -- */

await t('the client only sends headers the preflight allows', async (env) => {
  // Guards against someone adding a header to api() without adding it to
  // ALLOWED_HEADERS, which is invisible until a real browser refuses the call.
  const src = readFileSync(CLIENT_SRC, 'utf8');
  const sent = new Set();
  for (const m of src.matchAll(/'(x-cheatlab-[a-z-]+)'/g)) sent.add(m[1]);
  sent.add('content-type');
  check('the client does set custom headers', sent.size >= 2, [...sent].join(','));

  const pre = await worker.fetch(new Request('https://api.cheatlab.test/api/items', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://tatarhost.github.io',
      'access-control-request-method': 'POST',
      'access-control-request-headers': [...sent].join(', '),
    },
  }), env);
  const allowed = (pre.headers.get('access-control-allow-headers') || '').toLowerCase();
  for (const header of sent) {
    check(`preflight allows ${header} (used by public/app.js)`, allowed.includes(header), `allowed: ${allowed}`);
  }
});

// Production-only guard. Node's WebCrypto accepts any PBKDF2 iteration count,
// while the Workers runtime throws NotSupportedError above 100k, which turned
// every registration and login into an opaque 500 that no local test could see.
await t('password hashing stays within the Workers PBKDF2 cap', async () => {
  check('PBKDF2_ITERATIONS is at or below the runtime cap',
    PBKDF2_ITERATIONS <= 100_000, `got ${PBKDF2_ITERATIONS}`);
  check('PBKDF2_ITERATIONS never exceeds PBKDF2_MAX_ITERATIONS',
    PBKDF2_ITERATIONS <= PBKDF2_MAX_ITERATIONS, `got ${PBKDF2_ITERATIONS}`);

  const rec = await hashPassword('Tr0ub4dor-and-3-ducks');
  check('hashPassword records a count the runtime accepts',
    rec.iterations <= 100_000, `got ${rec.iterations}`);
  check('verifyPassword accepts the hash it just produced',
    (await verifyPassword('Tr0ub4dor-and-3-ducks', {
      pass_hash: rec.passHash, pass_salt: rec.passSalt, iterations: rec.iterations,
    })).ok);
  check('verifyPassword still rejects a wrong password',
    !(await verifyPassword('not-the-password', {
      pass_hash: rec.passHash, pass_salt: rec.passSalt, iterations: rec.iterations,
    })).ok);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
