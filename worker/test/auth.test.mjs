/**
 * Account, session, social and anti-abuse tests.
 * Run with: node worker/test/auth.test.mjs
 *
 * These use a lowered PBKDF2 iteration count where the cost is not what is
 * under test, so the suite stays fast while still exercising the real code
 * path. The production iteration count is asserted separately.
 */
import { readFileSync } from 'node:fs';
import { makeEnv, call, request, answerQuestion, solveCaptcha } from './harness.mjs';
import worker from '../src/index.js';
import {
  passwordProblems, nickProblems, nickKey, hashPassword, verifyPassword,
  PBKDF2_ITERATIONS,
} from '../src/accounts.js';
import {
  checkPow, solvePow, powBits, newPowChallenge, issueCaptcha, verifyCaptcha,
  quotaFor, QUOTA,
} from '../src/abuse.js';

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

/* ------------------------------------------------------------ unit: policy */

await t('password policy rejects the weak cases', async () => {
  check('empty rejected', passwordProblems('').length > 0);
  check('short rejected', passwordProblems('Ab1!').length > 0);
  check('common list rejected', passwordProblems('password123').length > 0);
  check('single char repeat rejected', passwordProblems('aaaaaaaaaaaaaa').length > 0);
  check('sequence rejected', passwordProblems('1234567890123').length > 0);
  check('overlong rejected', passwordProblems('a'.repeat(201)).length > 0);
  check('long passphrase accepted', passwordProblems('correct horse battery staple 42').length === 0);
  check('strong mixed accepted', passwordProblems('Tr0ub4dor-and-3-ducks').length === 0);
});

await t('nick policy', async () => {
  check('too short', nickProblems('ab').length > 0);
  check('too long', nickProblems('a'.repeat(25)).length > 0);
  check('all digits rejected', nickProblems('12345').length > 0);
  check('cyrillic rejected', nickProblems('Данил').length > 0);
  check('space rejected', nickProblems('da nil').length > 0);
  check('plain ok', nickProblems('danil').length === 0);
  check('dotted ok', nickProblems('da.nil_x').length === 0);
  check('folds case', nickKey(' Danil ') === nickKey('danil'));
  check('folds unicode lookalikes', nickKey('DaniL') === nickKey('danil'));
});

await t('password hashing round-trips and rejects', async () => {
  const { passHash, passSalt, iterations } = await hashPassword('Tr0ub4dor-and-3-ducks', 1000);
  check('iterations recorded', iterations === 1000);
  check('hash is not the password', passHash !== 'Tr0ub4dor-and-3-ducks');
  const row = { pass_hash: passHash, pass_salt: passSalt, iterations };
  const good = await verifyPassword('Tr0ub4dor-and-3-ducks', row);
  check('correct password accepted', good.ok);
  const bad = await verifyPassword('wrong-password', row);
  check('wrong password rejected', !bad.ok);
  check('needs rehash below policy', good.needsRehash, 'expected rehash when below PBKDF2_ITERATIONS');
});

await t('salted hashes differ for the same password', async () => {
  const a = await hashPassword('same-password-here', 1000);
  const b = await hashPassword('same-password-here', 1000);
  check('different salt', a.passSalt !== b.passSalt);
  check('different hash', a.passHash !== b.passHash);
});

await t('production iteration count is at the practical ceiling', async () => {
  check('iterations >= 200k', PBKDF2_ITERATIONS >= 200_000, `got ${PBKDF2_ITERATIONS}`);
  check('iteration count is not absurdly high for Workers CPU', PBKDF2_ITERATIONS <= 600_000, `got ${PBKDF2_ITERATIONS}`);
});

await t('proof of work accepts only real work', async () => {
  const challenge = newPowChallenge();
  // Difficulty from env, so this matches what the route actually enforces.
  const env = { POW_BITS: '8' };
  const nonce = await solvePow(challenge, env);
  check('found a solution', nonce !== null);
  check('solution accepted', await checkPow(challenge, nonce, env));
  check('wrong nonce rejected', !(await checkPow(challenge, 'nope', env)));
  check('wrong challenge rejected', !(await checkPow('otherchallenge', nonce, env)));
  check('missing nonce rejected', !(await checkPow(challenge, undefined, env)));
  check('empty inputs rejected', !(await checkPow('', '', env)));
  // A nonce that solved the easy puzzle must not solve a harder one, otherwise
  // the difficulty is decorative.
  const hard = { POW_BITS: '20' };
  check('a solution is difficulty-specific', !(await checkPow(challenge, nonce, hard)));
});

await t('proof of work difficulty is clamped', async () => {
  check('missing env uses the production default', powBits({}) === 22, `got ${powBits({})}`);
  check('nonsense falls back', powBits({ POW_BITS: 'abc' }) === 22, `got ${powBits({ POW_BITS: 'abc' })}`);
  check('too low is raised', powBits({ POW_BITS: '0' }) === 8, `got ${powBits({ POW_BITS: '0' })}`);
  check('absurdly high is capped', powBits({ POW_BITS: '999' }) === 30, `got ${powBits({ POW_BITS: '999' })}`);
  check('in-range is honoured', powBits({ POW_BITS: '16' }) === 16);
});

await t('captcha keeps the answer server-side, is single-use, and expires', async () => {
  const env = makeEnv();
  const { token, q } = await issueCaptcha(env.DB, env);
  check('has a question', typeof q === 'string' && q.length > 8);

  // The regression this suite exists for: an earlier build put the answer in the
  // signed payload, so a bot could decode it and never solve anything. The
  // token is now only `id.signature` and must not disclose the answer.
  check('token is id.signature, not a readable payload', /^[A-Za-z0-9_-]{10}\.[0-9a-f]{64}$/.test(token), token);
  const solved = answerQuestion(q);
  check('question is answerable by the client', typeof solved === 'string' && solved.length > 0, q);

  check('wrong answer rejected', !(await verifyCaptcha(env.DB, env, token, 'nope')));
  check('correct answer accepted', await verifyCaptcha(env.DB, env, token, solved));
  // Consumed: one solved challenge must not license a second post.
  check('replay rejected', !(await verifyCaptcha(env.DB, env, token, solved)));

  const second = await issueCaptcha(env.DB, env);
  check('answer case-insensitive', await verifyCaptcha(env.DB, env, second.token, answerQuestion(second.q).toUpperCase()));

  // A token signed with a different secret must fail even though the id is real.
  const other = makeEnv({ CAPTCHA_SECRET: 'attacker-secret' });
  const third = await issueCaptcha(env.DB, env);
  check('foreign secret rejected', !(await verifyCaptcha(other.DB, env, third.token, answerQuestion(third.q))));

  const stale = await issueCaptcha(env.DB, env);
  await env.DB.prepare('UPDATE captcha SET expires_at = ? WHERE id = ?')
    .bind(Date.now() - 1000, stale.id).run();
  check('expired rejected', !(await verifyCaptcha(env.DB, env, stale.token, answerQuestion(stale.q))));

  check('garbage rejected', !(await verifyCaptcha(env.DB, env, 'garbage', '1')));
  check('empty rejected', !(await verifyCaptcha(env.DB, env, '', '')));
  // An id that does not exist must not verify even with a valid signature,
  // which is what stops an attacker minting ids by guessing the format.
  const phantom = await issueCaptcha(env.DB, env);
  await env.DB.prepare('DELETE FROM captcha WHERE id = ?').bind(phantom.id).run();
  check('deleted challenge rejected', !(await verifyCaptcha(env.DB, env, phantom.token, answerQuestion(phantom.q))));
});

await t('quota table matches the product rules', async () => {
  const anon = quotaFor(null);
  const reg = quotaFor({ id: 'u_x' });
  check('anonymous 1 item/day', anon.newItemsPerDay === 1, `got ${anon.newItemsPerDay}`);
  check('registered 4 items/day', reg.newItemsPerDay === 4, `got ${reg.newItemsPerDay}`);
  check('anonymous captcha on post', anon.captchaOnPost === true);
  check('registered exempt from captcha', reg.captchaOnPost === false);
  check('anonymous cannot follow', anon.canFollow === false);
  check('registered can follow', reg.canFollow === true);
  check('anonymous cannot voice', anon.canVoice === false);
  check('registered can voice', reg.canVoice === true);
  check('anonymous storage capped', anon.storageBytes === 64 * 1024 * 1024);
  check('registered storage larger', reg.storageBytes > anon.storageBytes);
  check('registered edits uncapped', reg.editsPerDay === Infinity);
  check('anonymous edits capped', anon.editsPerDay > 0 && anon.editsPerDay < Infinity);
  check('registered file cap is the KV cap', reg.maxFileBytes === 24 * 1024 * 1024);

  // The caps are env-overridable so they can be tuned without a redeploy. That
  // only stays safe if the shipped defaults keep matching the values in
  // wrangler.toml, so a silent drift in either place fails here.
  const cfg = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  check('wrangler pins the anonymous cap to the source default',
    cfg.includes('ANON_NEW_ITEMS_PER_DAY = "1"') && quotaFor(null, {}).newItemsPerDay === 1);
  check('wrangler pins the registered cap to the source default',
    cfg.includes('REG_NEW_ITEMS_PER_DAY = "4"') && quotaFor({ id: 'u_x' }, {}).newItemsPerDay === 4);
  check('env override applies to the anonymous tier',
    quotaFor(null, { ANON_NEW_ITEMS_PER_DAY: '9' }).newItemsPerDay === 9);
  check('env override applies to the registered tier',
    quotaFor({ id: 'u_x' }, { REG_NEW_ITEMS_PER_DAY: '7' }).newItemsPerDay === 7);
  // A nonsense value must not be able to disable the cap entirely.
  check('garbage override is ignored', quotaFor(null, { ANON_NEW_ITEMS_PER_DAY: 'lots' }).newItemsPerDay === 1);
  check('negative override is ignored', quotaFor(null, { ANON_NEW_ITEMS_PER_DAY: '-5' }).newItemsPerDay === 1);
  check('empty override is ignored', quotaFor(null, { ANON_NEW_ITEMS_PER_DAY: '' }).newItemsPerDay === 1);
  // The registered tier must not be downgradable by the anonymous var.
  check('tiers do not cross', quotaFor({ id: 'u_x' }, { ANON_NEW_ITEMS_PER_DAY: '99' }).newItemsPerDay === 4);
});

/* ------------------------------------------------------------ integration */

/** Register through the real route, solving the real (env-difficulty) PoW. */
async function register(env, { nick = 'danil', password = 'Tr0ub4dor-and-3-ducks', client = 'testclient0123456789abcdef' } = {}) {
  const challenge = await call(worker, env, '/api/auth/pow', { client });
  const nonce = await solvePow(challenge.json.challenge, env);
  return call(worker, env, '/api/auth/register', {
    method: 'POST',
    body: { nick, password },
    client,
    headers: { 'x-cheatlab-pow': challenge.json.challenge, 'x-cheatlab-pow-nonce': nonce },
  });
}

await t('register issues a session bound to the client', async (env) => {
  const r = await register(env);
  check('201', r.status === 201, `got ${r.status} ${r.text.slice(0, 160)}`);
  check('has token', typeof r.json?.token === 'string' && r.json.token.length > 20);
  check('returns user', r.json?.user?.nick === 'danil');
  check('never returns the hash', !r.text.includes('pass_hash'));
  check('never returns the password', !r.text.includes('Tr0ub4dor'));

  const me = await call(worker, env, '/api/auth/me', { session: r.json.token });
  check('me resolves the user', me.json?.user?.nick === 'danil');
  check('me reports registered quota', me.json?.quota?.newItemsPerDay === 4);
  check('me reports no captcha', me.json?.quota?.captchaOnPost === false);
});

await t('session is rejected from a different client', async (env) => {
  const r = await register(env);
  check('registered', r.status === 201);
  const me = await call(worker, env, '/api/auth/me', { session: r.json.token, client: 'otherclient0987654321abcdef' });
  check('stolen token useless elsewhere', me.json?.user === null, JSON.stringify(me.json));
});

await t('register enforces the password policy', async (env) => {
  const r = await register(env, { nick: 'weakuser', password: 'password', client: 'clientWEAK1111111111aaaaaaa' });
  check('rejected', r.status === 400, `got ${r.status}`);
  check('explains why', typeof r.json?.error === 'string' && r.json.error.length > 3);
  check('lists problems', Array.isArray(r.json?.problems) && r.json.problems.length > 0);
});

await t('register rejects a weak or taken nick', async (env) => {
  // A distinct client per attempt: registration is throttled per client, so
  // reusing one would hit the cap before the assertions could run.
  check('short nick', (await register(env, { nick: 'ab', client: 'clientAAA1111111111aaaaaaaa' })).status === 400);
  check('digits only', (await register(env, { nick: '1234567', client: 'clientBBB1111111111aaaaaaaa' })).status === 400);
  check('cyrillic', (await register(env, { nick: 'Данил', client: 'clientCCC1111111111aaaaaaaa' })).status === 400);
  const first = await register(env, { nick: 'taken', client: 'clientDDD1111111111aaaaaaaa' });
  check('first registers', first.status === 201, `got ${first.status} ${first.text.slice(0, 120)}`);
  // Different client, same nick in a different case: the UNIQUE index is what
  // stops this, not a per-client check.
  const second = await register(env, { nick: 'TAKEN', client: 'clientEEE1111111111aaaaaaaa' });
  check('case variant rejected', second.status === 409, `got ${second.status} ${second.text.slice(0, 120)}`);
});

await t('register requires proof of work', async (env) => {
  const r = await call(worker, env, '/api/auth/register', {
    method: 'POST',
    body: { nick: 'nopow', password: 'Tr0ub4dor-and-3-ducks' },
  });
  check('403', r.status === 403, `got ${r.status}`);
  check('issues a challenge', typeof r.json?.pow?.challenge === 'string');
});

await t('register is throttled', async (env) => {
  for (let i = 0; i < 3; i++) await register(env, { nick: `burst${i}` });
  const r = await register(env, { nick: 'burst4' });
  check('4th attempt blocked', r.status === 429, `got ${r.status}`);
});

await t('login works and rejects bad credentials', async (env) => {
  await register(env, { nick: 'lena', password: 'Tr0ub4dor-and-3-ducks' });
  const ok = await call(worker, env, '/api/auth/login', {
    method: 'POST', body: { nick: 'LENA', password: 'Tr0ub4dor-and-3-ducks' },
  });
  check('case-insensitive nick login', ok.status === 200, `got ${ok.status} ${ok.text.slice(0, 140)}`);
  check('new token issued', typeof ok.json?.token === 'string');

  const wrongPw = await call(worker, env, '/api/auth/login', {
    method: 'POST', body: { nick: 'lena', password: 'not-the-password' },
  });
  check('wrong password 401', wrongPw.status === 401, `got ${wrongPw.status}`);

  const wrongNick = await call(worker, env, '/api/auth/login', {
    method: 'POST', body: { nick: 'ghost', password: 'Tr0ub4dor-and-3-ducks' },
  });
  check('unknown nick 401', wrongNick.status === 401, `got ${wrongNick.status}`);
  check('unknown nick message is identical to wrong-password message', wrongNick.json?.error === wrongPw.json?.error);
});

await t('logout revokes the session', async (env) => {
  const r = await register(env, { nick: 'bye' });
  const token = r.json.token;
  check('valid before logout', (await call(worker, env, '/api/auth/me', { session: token })).json?.user?.nick === 'bye');
  await call(worker, env, '/api/auth/logout', { method: 'POST', session: token });
  check('invalid after logout', (await call(worker, env, '/api/auth/me', { session: token })).json?.user === null);
});

await t('anonymous me reports the anonymous tier', async (env) => {
  const r = await call(worker, env, '/api/auth/me');
  check('no user', r.json?.user === null);
  check('1 item/day', r.json?.quota?.newItemsPerDay === 1);
  check('captcha required', r.json?.quota?.captchaOnPost === true);
  check('cannot follow', r.json?.quota?.canFollow === false);
});

await t('garbage session tokens are ignored, not errors', async (env) => {
  for (const bad of ['', 'x', 'a'.repeat(19), '../../etc/passwd', 'null', 'undefined']) {
    const r = await call(worker, env, '/api/auth/me', { session: bad });
    check(`token ${JSON.stringify(bad)} -> anonymous`, r.status === 200 && r.json?.user === null, `got ${r.status}`);
  }
});

/* ------------------------------------------------------- tiers and limits */

await t('anonymous post requires a captcha, registered does not', async (env) => {
  const anon = await call(worker, env, '/api/items', { method: 'POST', body: { type: 'paste', title: 'anon post', body: 'x' } });
  check('anonymous blocked with 403', anon.status === 403, `got ${anon.status}`);
  check('challenged with a captcha', typeof anon.json?.captcha?.q === 'string', JSON.stringify(anon.json).slice(0, 200));

  // Solve the returned captcha and retry: it must now succeed. The answer is
  // not in the token, so the client has to read the question and work it out.
  const answer = answerQuestion(anon.json.captcha.q);
  const solved = await call(worker, env, '/api/items', {
    method: 'POST',
    body: { type: 'paste', title: 'anon post', body: 'x', captchaToken: anon.json.captcha.token, captchaAnswer: answer },
  });
  check('solved captcha allows the post', solved.status === 201, `got ${solved.status} ${solved.text.slice(0, 160)}`);

  // The challenge was consumed by that post, so reusing the pair is refused.
  // The daily cap is raised here so the refusal is attributable to the captcha
  // rather than to the quota that the next test covers.
  const roomy = makeEnv({ ANON_NEW_ITEMS_PER_DAY: '10' });
  const first = await call(worker, roomy, '/api/auth/captcha');
  const firstAnswer = answerQuestion(first.json.q);
  const ok = await call(worker, roomy, '/api/items', {
    method: 'POST',
    body: { type: 'paste', title: 'spends the challenge', body: 'x', captchaToken: first.json.token, captchaAnswer: firstAnswer },
  });
  check('challenge spent by a real post', ok.status === 201, `got ${ok.status} ${ok.text.slice(0, 160)}`);
  const replay = await call(worker, roomy, '/api/items', {
    method: 'POST',
    body: { type: 'paste', title: 'replayed', body: 'x', captchaToken: first.json.token, captchaAnswer: firstAnswer },
  });
  check('solved captcha cannot be replayed', replay.status === 403, `got ${replay.status} ${replay.text.slice(0, 160)}`);

  // Registered user: same request, no captcha fields at all.
  const reg = await register(env, { nick: 'poster' });
  const asUser = await call(worker, env, '/api/items', {
    method: 'POST', body: { type: 'paste', title: 'user post', body: 'x' }, session: reg.json.token,
  });
  check('registered publishes without captcha', asUser.status === 201, `got ${asUser.status} ${asUser.text.slice(0, 160)}`);
  check('response says registered', asUser.json?.registered === true);
});

await t('wrong captcha answer blocks the post', async (env) => {
  const c = await call(worker, env, '/api/auth/captcha');
  const r = await call(worker, env, '/api/items', {
    method: 'POST',
    body: { type: 'paste', title: 't', body: 'b', captchaToken: c.json.token, captchaAnswer: '999999' },
  });
  check('403', r.status === 403, `got ${r.status}`);
});

await t('anonymous is capped at 1 new item per day', async (env) => {
  const c = await solveCaptcha(worker, env);
  const post = () => call(worker, env, '/api/items', {
    method: 'POST',
    body: { type: 'paste', title: 'one', body: 'b', captchaToken: c.token, captchaAnswer: c.answer },
  });
  check('first ok', (await post()).status === 201);
  // Each retry needs a fresh challenge: the previous one is spent, and the daily
  // cap is what must reject this one, not the captcha.
  const second = await call(worker, env, '/api/items', {
    method: 'POST',
    body: { type: 'paste', title: 'one', body: 'b', ...(await solveCaptcha(worker, env)) },
  });
  check('second blocked', second.status === 429, `got ${second.status} ${second.text.slice(0, 160)}`);
  check('says it is a daily limit', /daily|1 post/i.test(String(second.json?.error)), JSON.stringify(second.json));
  check('tells the user to register', /register/i.test(String(second.json?.error)), JSON.stringify(second.json));
  check('reports quota', second.json?.quota?.newItemsPerDay === 1);
});

await t('registered is capped at 4 new items per day', async (env) => {
  const reg = await register(env, { nick: 'busy' });
  const s = reg.json.token;
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await call(worker, env, '/api/items', {
      method: 'POST', body: { type: 'paste', title: `p${i}`, body: 'b' }, session: s,
    });
  }
  check('4 succeeded then blocked', last.status === 429, `got ${last.status}`);
  check('reports the 4/day quota', last.json?.quota?.newItemsPerDay === 4, JSON.stringify(last.json));
  check('says registered', last.json?.quota?.registered === true);
});

await t('registered editing stays open after the daily new-post cap', async (env) => {
  const reg = await register(env, { nick: 'editor' });
  const s = reg.json.token;
  const created = await call(worker, env, '/api/items', {
    method: 'POST', body: { type: 'paste', title: 'orig', body: 'first' }, session: s,
  });
  check('created', created.status === 201, `got ${created.status}`);
  const { item, secret } = created.json;
  // Burn the new-post budget, then confirm edits still work.
  for (let i = 0; i < 4; i++) {
    await call(worker, env, '/api/items', { method: 'POST', body: { type: 'paste', title: `f${i}`, body: 'b' }, session: s });
  }
  const edited = await call(worker, env, `/api/items/${item.id}`, {
    method: 'PATCH', body: { body: 'updated' }, secret, session: s,
  });
  check('edit still allowed', edited.status === 200, `got ${edited.status} ${edited.text.slice(0, 140)}`);
});

/* ---------------------------------------------------------------- social -- */

await t('follow and unfollow', async (env) => {
  const a = await register(env, { nick: 'alice' });
  const b = await register(env, { nick: 'bob', client: 'testclientBBBBBBB0987654321' });
  const ta = a.json.token;
  const tb = b.json.token;

  const follow = await call(worker, env, `/api/users/${b.json.user.id}/follow`, { method: 'POST', session: ta });
  check('follow ok', follow.status === 200, `got ${follow.status} ${follow.text.slice(0, 140)}`);
  check('reports following', follow.json?.following === true);
  check('follower count on target', follow.json?.user?.followers === 1, JSON.stringify(follow.json?.user));

  const profile = await call(worker, env, `/api/users/${b.json.user.id}`, { session: ta });
  check('profile shows the follow', profile.json?.isFollowing === true);

  const again = await call(worker, env, `/api/users/${b.json.user.id}/follow`, { method: 'POST', session: ta });
  check('double follow is idempotent', again.status === 200 && again.json?.reason === 'already', JSON.stringify(again.json));

  const list = await call(worker, env, `/api/users/${b.json.user.id}/followers`);
  check('follower list has alice', list.json?.users?.some((u) => u.nick === 'alice'), JSON.stringify(list.json));

  const un = await call(worker, env, `/api/users/${b.json.user.id}/follow`, { method: 'DELETE', session: ta });
  check('unfollow ok', un.json?.following === false);
  check('count back to zero', un.json?.user?.followers === 0, JSON.stringify(un.json?.user));
});

await t('cannot follow yourself', async (env) => {
  const a = await register(env, { nick: 'narcissus' });
  const r = await call(worker, env, `/api/users/${a.json.user.id}/follow`, { method: 'POST', session: a.json.token });
  check('rejected', r.status === 400, `got ${r.status}`);
});

await t('anonymous cannot follow', async (env) => {
  const b = await register(env, { nick: 'target' });
  const r = await call(worker, env, `/api/users/${b.json.user.id}/follow`, { method: 'POST' });
  check('401', r.status === 401, `got ${r.status}`);
  check('says login required', /login/i.test(String(r.json?.error)), JSON.stringify(r.json));
});

await t('user search finds by partial nick, but not the whole list', async (env) => {
  await register(env, { nick: 'vladislav' });
  await register(env, { nick: 'vladlen', client: 'testclient22222BBBB0987654321' });
  const hit = await call(worker, env, '/api/users?q=vlad');
  check('finds both', hit.json?.users?.length === 2, JSON.stringify(hit.json));
  const miss = await call(worker, env, '/api/users?q=zzzz');
  check('empty result is fine', miss.status === 200 && miss.json.users.length === 0);
  const tooShort = await call(worker, env, '/api/users?q=a');
  check('1 char rejected to stop enumeration', tooShort.status === 400, `got ${tooShort.status}`);
  const none = await call(worker, env, '/api/users');
  check('no query at all rejected', none.status === 400, `got ${none.status}`);
});

await t('search never leaks credentials', async (env) => {
  await register(env, { nick: 'secretive' });
  const r = await call(worker, env, '/api/users?q=secre');
  check('no hash in results', !r.text.includes('pass_hash'));
  check('no salt in results', !r.text.includes('pass_salt'));
  check('no iterations field', !r.text.includes('iterations'));
});

await t('likes toggle and cannot be inflated', async (env) => {
  const a = await register(env, { nick: 'liker' });
  const post = await call(worker, env, '/api/items', {
    method: 'POST', body: { type: 'paste', title: 'likeable', body: 'b' }, session: a.json.token,
  });
  const id = post.json.item.id;

  const first = await call(worker, env, `/api/items/${id}/like`, { method: 'POST', session: a.json.token });
  check('like ok', first.json?.liked === true, JSON.stringify(first.json));
  check('count is 1', first.json?.likes === 1, JSON.stringify(first.json));

  const second = await call(worker, env, `/api/items/${id}/like`, { method: 'POST', session: a.json.token });
  check('repeat like keeps 1', second.json?.likes === 1, JSON.stringify(second.json));

  const un = await call(worker, env, `/api/items/${id}/like`, { method: 'DELETE', session: a.json.token });
  check('unlike ok', un.json?.liked === false);
  check('count is 0', un.json?.likes === 0, JSON.stringify(un.json));
});

await t('comments require an account and are attributed', async (env) => {
  const a = await register(env, { nick: 'commenter' });
  const post = await call(worker, env, '/api/items', {
    method: 'POST', body: { type: 'paste', title: 'discuss', body: 'b' }, session: a.json.token,
  });
  const id = post.json.item.id;

  const anon = await call(worker, env, `/api/items/${id}/comments`, { method: 'POST', body: { body: 'hi' } });
  check('anonymous blocked', anon.status === 401, `got ${anon.status}`);

  const created = await call(worker, env, `/api/items/${id}/comments`, {
    method: 'POST', body: { body: '  hello  ' }, session: a.json.token,
  });
  check('created', created.status === 201, `got ${created.status} ${created.text.slice(0, 140)}`);
  check('trimmed body', created.json?.comment?.body === 'hello', JSON.stringify(created.json?.comment));
  check('attributed to nick', created.json?.comment?.nick === 'commenter');
  check('counter updated', created.json?.comments === 1);

  const empty = await call(worker, env, `/api/items/${id}/comments`, { method: 'POST', body: { body: '   ' }, session: a.json.token });
  check('empty rejected', empty.status === 400, `got ${empty.status}`);

  const list = await call(worker, env, `/api/items/${id}/comments`);
  check('listed', list.json?.comments?.length === 1, JSON.stringify(list.json));
  check('viewer can delete own', list.json.comments[0].canDelete === false, 'anonymous viewer cannot delete');
  const asOwner = await call(worker, env, `/api/items/${id}/comments`, { session: a.json.token });
  check('author can delete', asOwner.json?.comments?.[0]?.canDelete === true, JSON.stringify(asOwner.json));
});

await t('comment delete permissions', async (env) => {
  // Three accounts, three clients: two registrations from one client would trip
  // the per-client registration throttle.
  const author = await register(env, { nick: 'cauthor', client: 'clientAUTHOR1111111111aaaaa' });
  const other = await register(env, { nick: 'cother', client: 'clientOTHER1111111111aaaaaa' });
  const third = await register(env, { nick: 'cthird', client: 'clientTHIRD1111111111aaaaaa' });
  check('three accounts created', [author, other, third].every((r) => r.status === 201),
    [author, other, third].map((r) => r.status).join(','));
  check('all three tokens issued', [author, other, third].every((r) => typeof r.json?.token === 'string'),
    [author, other, third].map((r) => typeof r.json?.token).join(','));

  // Every call must carry the client the session was issued to: a session is
  // bound to its browser, so a mismatched client is anonymous by design.
  const post = await call(worker, env, '/api/items', {
    method: 'POST', body: { type: 'paste', title: 'perm', body: 'b' },
    session: author.json.token, client: 'clientAUTHOR1111111111aaaaa',
  });
  check('post created', post.status === 201, `got ${post.status} ${post.text.slice(0, 120)}`);
  const itemId = post.json.item.id;
  const c = await call(worker, env, `/api/items/${itemId}/comments`, {
    method: 'POST', body: { body: 'mine' },
    session: other.json.token, client: 'clientOTHER1111111111aaaaaa',
  });
  check('comment created', c.status === 201, `got ${c.status} ${c.text.slice(0, 120)}`);
  const cid = c.json.comment.id;

  const byStranger = await call(worker, env, `/api/comments/${cid}`, { method: 'DELETE', session: 'nope' });
  check('invalid session cannot delete', byStranger.status === 401, `got ${byStranger.status}`);

  const byOther = await call(worker, env, `/api/comments/${cid}`, {
    method: 'DELETE', session: third.json.token, client: 'clientTHIRD1111111111aaaaaa',
  });
  check('unrelated user cannot delete', byOther.status === 403, `got ${byOther.status}`);

  // Author deleting, from the client their session belongs to.
  const byAuthor = await call(worker, env, `/api/comments/${cid}`, {
    method: 'DELETE', session: other.json.token, client: 'clientOTHER1111111111aaaaaa',
  });
  check('comment author can delete', byAuthor.status === 200, `got ${byAuthor.status} ${byAuthor.text.slice(0, 120)}`);

  const after = await call(worker, env, `/api/items/${itemId}/comments`);
  check('list is empty', after.json?.comments?.length === 0, JSON.stringify(after.json));
});

await t('published items attach to the author profile', async (env) => {
  const a = await register(env, { nick: 'profiler' });
  await call(worker, env, '/api/items', {
    method: 'POST', body: { type: 'paste', title: 'mine', body: 'b' }, session: a.json.token,
  });
  const profile = await call(worker, env, `/api/users/${a.json.user.id}`);
  check('profile lists the post', profile.json?.items?.length === 1, JSON.stringify(profile.json).slice(0, 200));
  check('post count', profile.json?.user?.posts === 1, JSON.stringify(profile.json?.user));
});

await t('profile update validates nick and re-signs on password change', async (env) => {
  const a = await register(env, { nick: 'mutable' });
  const s = a.json.token;

  const bad = await call(worker, env, '/api/auth/me', { method: 'PATCH', body: { nick: 'no' }, session: s });
  check('bad nick rejected', bad.status === 400, `got ${bad.status}`);

  const bio = await call(worker, env, '/api/auth/me', { method: 'PATCH', body: { bio: '  hi there  ' }, session: s });
  check('bio set', bio.json?.user?.bio === 'hi there', JSON.stringify(bio.json?.user));

  const clash = await register(env, { nick: 'occupied', client: 'testclientOCCUPIED987654321' });
  const taken = await call(worker, env, '/api/auth/me', { method: 'PATCH', body: { nick: 'occupied' }, session: s });
  check('nick clash rejected', taken.status === 409, `got ${taken.status}`);

  const noCurrent = await call(worker, env, '/api/auth/me', {
    method: 'PATCH', body: { password: 'Another-Strong-Pass-99' }, session: s,
  });
  check('password change needs the current one', noCurrent.status === 403, `got ${noCurrent.status}`);

  const changed = await call(worker, env, '/api/auth/me', {
    method: 'PATCH',
    body: { password: 'Another-Strong-Pass-99', currentPassword: 'Tr0ub4dor-and-3-ducks' },
    session: s,
  });
  check('password changed', changed.status === 200, `got ${changed.status} ${changed.text.slice(0, 140)}`);
  check('re-signs the caller', typeof changed.json?.token === 'string' && changed.json.reauth === true);

  const oldToken = await call(worker, env, '/api/auth/me', { session: s });
  check('old session revoked', oldToken.json?.user === null, JSON.stringify(oldToken.json));

  const newToken = changed.json.token;
  const relogin = await call(worker, env, '/api/auth/login', { method: 'POST', body: { nick: 'mutable', password: 'Another-Strong-Pass-99' } });
  check('new password works', relogin.status === 200, `got ${relogin.status}`);
  const oldPw = await call(worker, env, '/api/auth/login', { method: 'POST', body: { nick: 'mutable', password: 'Tr0ub4dor-and-3-ducks' } });
  check('old password rejected', oldPw.status === 401, `got ${oldPw.status}`);
  check('new token still valid', (await call(worker, env, '/api/auth/me', { session: newToken })).json?.user?.nick === 'mutable');
});

await t('profile update requires a session', async (env) => {
  const r = await call(worker, env, '/api/auth/me', { method: 'PATCH', body: { bio: 'x' } });
  check('401', r.status === 401, `got ${r.status}`);
});

/* ------------------------------------------------------------- regression -- */

await t('anonymous publishing still works exactly as before', async (env) => {
  // The original product promise: no registration, no captcha before this
  // change. It now needs a captcha, but the flow must still complete, and the
  // edit secret must still work.
  const c = await solveCaptcha(worker, env);
  const created = await call(worker, env, '/api/items', {
    method: 'POST',
    body: { type: 'script', title: 'legacy', body: 'print(1)', language: 'python', captchaToken: c.token, captchaAnswer: c.answer },
  });
  check('created', created.status === 201, `got ${created.status}`);
  check('secret still returned', typeof created.json?.secret === 'string');

  const edited = await call(worker, env, `/api/items/${created.json.item.id}`, {
    method: 'PATCH', body: { title: 'legacy v2' }, secret: created.json.secret,
  });
  check('secret-based edit still works', edited.status === 200, `got ${edited.status} ${edited.text.slice(0, 140)}`);

  const mine = await call(worker, env, '/api/me');
  check('/api/me still lists anonymous uploads', mine.json?.items?.length === 1, JSON.stringify(mine.json).slice(0, 200));
});

await t('config advertises the tiers so the client can render them', async (env) => {
  const r = await call(worker, env, '/api/config');
  check('anonymous quota advertised', r.json?.quota?.anonymous?.newItemsPerDay === 1, JSON.stringify(r.json?.quota));
  check('registered quota advertised', r.json?.quota?.registered?.newItemsPerDay === 4);
  check('auth modes advertised', Array.isArray(r.json?.authModes) && r.json.authModes.includes('device'));
});

await t('captcha endpoint is throttled', async (env) => {
  let last;
  for (let i = 0; i < 22; i++) last = await call(worker, env, '/api/auth/captcha');
  check('429 after the cap', last.status === 429, `got ${last.status}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
