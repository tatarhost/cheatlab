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
async function clientApi(env, path, { method = 'GET', body, session, headers, client = CLIENT_ID } = {}) {
  const opts = { method, body, session };
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
