/**
 * Login keys: the signed link that logs a browser into an account.
 * Run with: node worker/test/loginkeys.test.mjs
 *
 * The subject is deliberately split in two: the pure signing/verification in
 * src/loginkeys.js, and the routes that turn a verified key into a session.
 * Both halves matter — a perfect signature check that the route skips would
 * pass the first and fail the product, and a generous route cannot rescue a
 * verifier that accepts a forged key.
 */
import { makeEnv, call } from './harness.mjs';
import worker from '../src/index.js';
import { solvePow } from '../src/abuse.js';
import {
  b32encode, b32decode, issueLoginKey, verifyLoginKey,
  LOGIN_KEY_PREFIX, LOGIN_KEY_TTL_MS,
} from '../src/loginkeys.js';

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

/** Register through the real route, solving the real proof of work. */
async function register(env, { nick = 'keyholder', client = 'testclient0123456789abcdef' } = {}) {
  const challenge = await call(worker, env, '/api/auth/pow', { client });
  const nonce = await solvePow(challenge.json.challenge, env);
  return call(worker, env, '/api/auth/register', {
    method: 'POST',
    body: { nick, password: 'Tr0ub4dor-and-3-ducks' },
    client,
    headers: { 'x-cheatlab-pow': challenge.json.challenge, 'x-cheatlab-pow-nonce': nonce },
  });
}

/* ------------------------------------------------------------ unit: codec */

await t('base32 round-trips and rejects corrupt input', () => {
  const samples = ['a', 'ab', 'abc', 'abcd', 'abcde', 'hello world', 'юникс'];
  for (const s of samples) {
    const bytes = new TextEncoder().encode(s);
    const encoded = b32encode(bytes);
    const decoded = b32decode(encoded);
    check(`round-trips ${JSON.stringify(s)}`, decoded && new TextDecoder().decode(decoded) === s,
      `encoded=${encoded}`);
    check(`encoding is lowercase for ${JSON.stringify(s)}`, encoded === encoded.toLowerCase());
  }
  check('empty input has no key', b32decode('') === null);
  check('non-base32 character rejected', b32decode('01abc') === null);
  // An encoder zero-pads the final partial group, so leftover bits that are
  // not zero mean the tail was cut or corrupted, not that the payload is short.
  check('corrupt tail rejected', b32decode('m') === null);
});

/* ----------------------------------------------------------- unit: signing */

await t('issue and verify round-trip', async () => {
  const secret = 'unit-secret';
  const key = await issueLoginKey(secret, 'u_abcdefghijkl');
  check('has the clab2 prefix', key.startsWith(LOGIN_KEY_PREFIX), key);
  check('three dashed sections', key.split('-').length === 3, key);

  const parsed = await verifyLoginKey(secret, key);
  check('verifies', parsed !== null, String(parsed));
  check('carries the account id', parsed?.userId === 'u_abcdefghijkl', JSON.stringify(parsed));
  check('expires about one TTL later', parsed && parsed.expiresAt - parsed.issuedAt === LOGIN_KEY_TTL_MS);
  // Re-verifying is pure: the same key must keep working until it expires,
  // because the whole point is a link the user can open again.
  check('verifies again', await verifyLoginKey(secret, key) !== null);
});

await t('verification refuses everything a forger or the clock could supply', async () => {
  const secret = 'unit-secret';
  const key = await issueLoginKey(secret, 'u_abcdefghijkl');

  check('wrong secret rejected', await verifyLoginKey('other-secret', key) === null);
  check('missing secret rejected', await verifyLoginKey('', key) === null);
  check('no key rejected', await verifyLoginKey(secret, null) === null);
  check('empty key rejected', await verifyLoginKey(secret, '') === null);

  // The desktop app's own keys share the visual family; they must fall out
  // before any signature work, since their secret is public in the site JS.
  check('clab1 app key rejected', await verifyLoginKey(secret, 'clab1-oyyx-bb3e') === null);

  // One flipped character in the signature: same length, wrong MAC.
  const body = key.slice(LOGIN_KEY_PREFIX.length);
  const dash = body.lastIndexOf('-');
  const flipped = LOGIN_KEY_PREFIX + body.slice(0, dash) + '-' + (body[dash + 1] === 'a' ? 'b' : 'a') + body.slice(dash + 2);
  check('tampered mac rejected', await verifyLoginKey(secret, flipped) === null);

  // Payload edited, signature left alone.
  const forgedPayload = b32encode(new TextEncoder().encode('v2|u_victimdevice01|1760000000'));
  const realMac = key.slice(key.lastIndexOf('-') + 1);
  check('forged payload rejected', await verifyLoginKey(secret, LOGIN_KEY_PREFIX + forgedPayload + '-' + realMac) === null);

  const now = Date.now();
  const expired = await issueLoginKey(secret, 'u_abcdefghijkl', now - LOGIN_KEY_TTL_MS - 1000);
  check('expired key rejected', await verifyLoginKey(secret, expired, now) === null);
  const fresh = await issueLoginKey(secret, 'u_abcdefghijkl', now - LOGIN_KEY_TTL_MS + 60_000);
  check('key inside the TTL accepted', await verifyLoginKey(secret, fresh, now) !== null);

  const future = await issueLoginKey(secret, 'u_abcdefghijkl', now + 10 * 60 * 1000);
  check('far-future key rejected', await verifyLoginKey(secret, future, now) === null);

  check('unknown version rejected', await verifyLoginKey(secret,
    LOGIN_KEY_PREFIX + b32encode(new TextEncoder().encode('v9|u_abcdefghijkl|1760000000')) + '-' + key.slice(key.lastIndexOf('-') + 1)) === null);
  check('garbage payload rejected', await verifyLoginKey(secret,
    LOGIN_KEY_PREFIX + b32encode(new TextEncoder().encode('not a payload')) + '-' + key.slice(key.lastIndexOf('-') + 1)) === null);
  check('payload without dashes rejected', await verifyLoginKey(secret, LOGIN_KEY_PREFIX + 'aaaaaaaa') === null);
});

/* ----------------------------------------------------------- integration */

await t('minting a key requires a session', async (env) => {
  const anon = await call(worker, env, '/api/auth/key', { method: 'POST' });
  check('anonymous refused', anon.status === 401, `got ${anon.status}`);
  check('says login required', /login/i.test(String(anon.json?.error)), JSON.stringify(anon.json));
});

await t('a minted key logs a second browser in', async (env) => {
  const reg = await register(env, { nick: 'alice' });
  check('registered', reg.status === 201, `got ${reg.status}`);

  const mint = await call(worker, env, '/api/auth/key', {
    method: 'POST', session: reg.json.token,
  });
  check('key minted', mint.status === 200, `got ${mint.status} ${mint.text.slice(0, 140)}`);
  check('key has the clab2 prefix', mint.json?.key?.startsWith(LOGIN_KEY_PREFIX), mint.json?.key);

  // A different client id — the whole use case: another browser, no password.
  const other = 'otherclient0987654321abcdef';
  const login = await call(worker, env, '/api/auth/keylogin', {
    method: 'POST', body: { key: mint.json.key }, client: other,
  });
  check('login accepted', login.status === 200, `got ${login.status} ${login.text.slice(0, 160)}`);
  check('session token issued', typeof login.json?.token === 'string');
  check('user is the minting account', login.json?.user?.nick === 'alice', JSON.stringify(login.json?.user));

  // The new session is bound to the browser that opened the link.
  const me = await call(worker, env, '/api/auth/me', { session: login.json.token, client: other });
  check('session works for its own client', me.json?.user?.nick === 'alice', JSON.stringify(me.json));
  const elsewhere = await call(worker, env, '/api/auth/me', { session: login.json.token, client: 'strangerclient4444444444aa' });
  check('session useless from a third client', elsewhere.json?.user === null, JSON.stringify(elsewhere.json));

  // And the key keeps working: it is a link, not a single-use token.
  const again = await call(worker, env, '/api/auth/keylogin', {
    method: 'POST', body: { key: mint.json.key }, client: 'thirdclient555555555555ccccc',
  });
  check('same key works again from another browser', again.status === 200, `got ${again.status}`);
});

await t('verify mode answers the registration question without a session', async (env) => {
  const reg = await register(env, { nick: 'verifier' });
  const mint = await call(worker, env, '/api/auth/key', { method: 'POST', session: reg.json.token });
  check('key minted', mint.status === 200);

  const verified = await call(worker, env, '/api/auth/keylogin', {
    method: 'POST', body: { key: mint.json.key, verify: true },
  });
  check('verification accepted', verified.status === 200, `got ${verified.status} ${verified.text.slice(0, 140)}`);
  check('reports the account', verified.json?.nick === 'verifier', JSON.stringify(verified.json));
  check('confirms registration', verified.json?.ok === true && verified.json?.userId === reg.json.user.id);
  check('mints no session', verified.json?.token === undefined, Object.keys(verified.json).join(','));

  const forged = await call(worker, env, '/api/auth/keylogin', {
    method: 'POST', body: { key: 'clab2-zzzzz-not-a-key', verify: true },
  });
  check('garbage key refused', forged.status === 401, `got ${forged.status}`);
  check('garbage answer is the generic one', forged.json?.error === 'key is not valid or has expired');
});

await t('a bad key never becomes a session', async (env) => {
  const reg = await register(env, { nick: 'victim' });
  const mint = await call(worker, env, '/api/auth/key', { method: 'POST', session: reg.json.token });

  for (const bad of [
    mint.json.key.slice(0, -1) + (mint.json.key.endsWith('a') ? 'b' : 'a'), // tampered
    mint.json.key.replace(LOGIN_KEY_PREFIX, 'clab1-'),                       // app key family
    'clab2-aaaaaaaaaaaaaaaa',                                                // too short
    'clab2-',                                                                // empty body
    '',                                                                      // empty
    'garbage',
  ]) {
    const r = await call(worker, env, '/api/auth/keylogin', { method: 'POST', body: { key: bad } });
    check(`refused ${JSON.stringify(bad).slice(0, 40)}`, r.status === 401, `got ${r.status} ${r.text.slice(0, 120)}`);
    check('no token handed out', r.json?.token === undefined);
  }
});

await t('keylogin is throttled like login', async (env) => {
  let last;
  for (let i = 0; i < 12; i++) {
    last = await call(worker, env, '/api/auth/keylogin', { method: 'POST', body: { key: 'clab2-zzz' } });
  }
  check('429 once the bucket fills', last.status === 429, `got ${last.status}`);
});

await t('an account deleted after minting leaves a key that resolves to nothing', async (env) => {
  const reg = await register(env, { nick: 'gone' });
  const mint = await call(worker, env, '/api/auth/key', { method: 'POST', session: reg.json.token });
  await env.DB.prepare('DELETE FROM user WHERE id = ?').bind(reg.json.user.id).run();

  const login = await call(worker, env, '/api/auth/keylogin', { method: 'POST', body: { key: mint.json.key } });
  check('refused', login.status === 401, `got ${login.status}`);
  const verified = await call(worker, env, '/api/auth/keylogin', {
    method: 'POST', body: { key: mint.json.key, verify: true },
  });
  check('verify also refused', verified.status === 401, `got ${verified.status}`);
});

await t('without a configured secret the feature fails closed', async () => {
  const env = makeEnv({ LOGIN_KEY_SECRET: '' });
  const reg = await register(env, { nick: 'nosecret' });
  const mint = await call(worker, env, '/api/auth/key', { method: 'POST', session: reg.json.token });
  check('minting reports the feature is off', mint.status === 503, `got ${mint.status}`);
  const login = await call(worker, env, '/api/auth/keylogin', { method: 'POST', body: { key: 'clab2-x-y' } });
  check('login reports the feature is off', login.status === 503, `got ${login.status}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
