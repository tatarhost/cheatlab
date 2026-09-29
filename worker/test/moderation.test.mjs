/**
 * Moderation, avatars, reports and public-stats tests.
 * Run with: node --experimental-sqlite worker/test/moderation.test.mjs
 *
 * Two things are deliberately proven here rather than assumed.
 *
 * First, that a rule holds against the *account*, not the session: a ban a
 * fresh login walks straight through is not a ban. Each makeEnv() is a
 * separate database, so an admin is registered in one env and then promoted by
 * setting ADMIN_IDS on that same env - creating a second env would hand the
 * admin a token belonging to a database the new env does not have.
 *
 * Second, that the admin split is a real boundary: a moderator being refused
 * the powers an admin has is the difference between a helper and a co-owner.
 */
import { makeEnv, call } from './harness.mjs';
import worker from '../src/index.js';
import { solvePow } from '../src/abuse.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

async function t(name, fn) {
  // Publishing is capped at 4/day for a registered account, and most of these
  // tests publish, so the quota is lifted here rather than in each test. What
  // is under test is moderation, not the anti-abuse budget.
  const env = makeEnv({ REG_NEW_ITEMS_PER_DAY: '50' });
  try {
    await fn(env);
  } catch (err) {
    fail++;
    failures.push(`${name} threw: ${err.stack || err.message}`);
  }
}

let clientSeq = 0;
const nextClient = () => `modclient${String(++clientSeq).padStart(10, '0')}`;

async function register(env, nick, client = nextClient()) {
  const challenge = await call(worker, env, '/api/auth/pow', { client });
  const nonce = await solvePow(challenge.json.challenge, env);
  const res = await call(worker, env, '/api/auth/register', {
    method: 'POST',
    body: { nick, password: 'Tr0ub4dor-and-3-ducks' },
    client,
    headers: { 'x-cheatlab-pow': challenge.json.challenge, 'x-cheatlab-pow-nonce': nonce },
  });
  return { client, id: res.json?.user?.id, token: res.json?.token, res };
}

/**
 * Registration with a solved proof of work, for the tests that need to control
 * the nick rather than let the shared helper invent one. Returns the raw
 * response so a test can assert on a refusal as easily as on a success.
 */
async function registerAs(env, nick, client) {
  const challenge = await call(worker, env, '/api/auth/pow', { client });
  const nonce = await solvePow(challenge.json.challenge, env);
  const res = await call(worker, env, '/api/auth/register', {
    method: 'POST', body: { nick, password: 'Tr0ub4dor-and-3-ducks' }, client,
    headers: { 'x-cheatlab-pow': challenge.json.challenge, 'x-cheatlab-pow-nonce': nonce },
  });
  return { res, client, id: res.json?.user?.id, token: res.json?.token };
}

/** Register an account and promote it to full admin on this same env. */
async function registerAdmin(env, nick) {
  const admin = await register(env, nick);
  env.ADMIN_IDS = admin.id;
  return admin;
}

async function publish(env, who, title = 'a post') {
  return call(worker, env, '/api/items', {
    method: 'POST',
    body: { type: 'paste', title, body: 'x' },
    session: who.token,
    client: who.client,
  });
}

const as = (who) => ({ session: who.token, client: who.client });

/* ------------------------------------------------------------------- bans */

await t('a ban blocks writes and states its reason', async (env) => {
  const admin = await registerAdmin(env, 'siteowner');
  const victim = await register(env, 'badactor');

  const ban = await call(worker, env, `/api/admin/users/${victim.id}/ban`, {
    method: 'POST', body: { hours: 24, reason: 'spam' }, ...as(admin),
  });
  check('ban accepted', ban.status === 201, `got ${ban.status} ${ban.text.slice(0, 140)}`);
  check('ban reports a future expiry', ban.json?.ban?.until > Date.now(), JSON.stringify(ban.json?.ban));
  check('ban names the target', ban.json?.user?.id === victim.id, JSON.stringify(ban.json?.user?.id));

  const post = await publish(env, victim);
  check('a banned account cannot post', post.status === 403, `got ${post.status}`);
  check('the error is "banned"', post.json?.error === 'banned', JSON.stringify(post.json));
  check('the reason comes back', post.json?.reason === 'spam', JSON.stringify(post.json?.reason));
});

await t('a ban closes every write to a post, with or without a session', async (env) => {
  const admin = await registerAdmin(env, 'ownerh');
  const victim = await register(env, 'sneakyeditor');

  // A post published while the account was in good standing, with a file on it,
  // so the edit, delete and file routes are all reachable and all have something
  // to refuse.
  const post = await publish(env, victim, 'before the ban');
  const itemId = post.json?.item?.id;
  const secret = post.json?.secret;
  check('the post exists', !!itemId, post.text.slice(0, 160));

  // A raw body with a filename header, the way the publish view sends a file.
  const bytes = new TextEncoder().encode('print("hi")\n');
  const upload = await call(worker, env, `/api/items/${itemId}/files`, {
    method: 'POST',
    body: bytes,
    headers: { 'x-filename': 'before-ban.lua', 'content-length': String(bytes.byteLength) },
    ...as(victim),
  });
  const fileId = upload.json?.file?.id;
  check('the file uploaded', !!fileId, upload.text.slice(0, 200));

  await call(worker, env, `/api/admin/users/${victim.id}/ban`, {
    method: 'POST', body: { hours: 24, reason: 'спам' }, ...as(admin),
  });

  const secretHeader = { 'x-cheatlab-secret': secret };
  const attempts = {
    'editing the post': await call(worker, env, `/api/items/${itemId}`, {
      method: 'PATCH', body: { title: 'after the ban' }, ...as(victim), headers: secretHeader,
    }),
    'deleting the post': await call(worker, env, `/api/items/${itemId}`, {
      method: 'DELETE', ...as(victim), headers: secretHeader,
    }),
    'adding a file': await call(worker, env, `/api/items/${itemId}/files`, {
      method: 'POST', body: new TextEncoder().encode('print("after")\n'),
      headers: { 'x-filename': 'after-ban.lua', 'content-length': '15' },
      ...as(victim),
    }),
    'deleting the file': await call(worker, env, `/api/files/${fileId}`, {
      method: 'DELETE', ...as(victim), headers: secretHeader,
    }),
  };
  for (const [what, res] of Object.entries(attempts)) {
    check(`${what} is refused`, res.status === 403, `got ${res.status} ${res.text.slice(0, 120)}`);
    check(`${what} says "banned"`, res.json?.error === 'banned', JSON.stringify(res.json));
    check(`${what} carries the reason`, res.json?.reason === 'спам', JSON.stringify(res.json?.reason));
  }

  // The same routes with the secret and no session at all: the edit secret lives
  // in the author's own browser, so dropping the session must not be a way out.
  const noSession = {
    patch: await call(worker, env, `/api/items/${itemId}`, {
      method: 'PATCH', body: { title: 'secret only' }, client: victim.client, headers: secretHeader,
    }),
    remove: await call(worker, env, `/api/items/${itemId}`, {
      method: 'DELETE', client: victim.client, headers: secretHeader,
    }),
  };
  check('editing with only the secret is still refused', noSession.patch.status === 403,
    `got ${noSession.patch.status} ${noSession.patch.text.slice(0, 120)}`);
  check('deleting with only the secret is still refused', noSession.remove.status === 403,
    `got ${noSession.remove.status} ${noSession.remove.text.slice(0, 120)}`);

  // And the post is still there, untouched, for a moderator to read.
  check('the post survived all of it', (await call(worker, env, `/api/items/${itemId}`)).status === 200);
});

await t('a new session does not outlive a ban', async (env) => {
  const admin = await registerAdmin(env, 'ownerb');
  const victim = await register(env, 'sneaky', 'sneakyclient00000001');

  await call(worker, env, `/api/admin/users/${victim.id}/ban`, {
    method: 'POST', body: { hours: 48 }, ...as(admin),
  });

  // A different browser, a different client id, a brand new token - same account.
  const again = await call(worker, env, '/api/auth/login', {
    method: 'POST',
    body: { nick: 'sneaky', password: 'Tr0ub4dor-and-3-ducks' },
    client: 'otherbrowser00000001',
  });
  check('login still works while banned', again.status === 200, `got ${again.status} ${again.text.slice(0, 120)}`);

  const post = await call(worker, env, '/api/items', {
    method: 'POST', body: { type: 'paste', title: 'new token', body: 'x' },
    session: again.json.token, client: 'otherbrowser00000001',
  });
  check('a fresh session is still banned', post.status === 403, `got ${post.status}`);
});

await t('a ban that has lapsed stops applying', async (env) => {
  const victim = await register(env, 'lapseduser');
  // Written straight to the table: the route clamps hours to 0..8760, so an
  // already-expired ban cannot be created through the API. This is the
  // arithmetic a real lapsed row relies on.
  await env.DB.prepare(
    "INSERT INTO ban (id, user_id, until_at, reason, by_user_id, created_at) VALUES (?, ?, ?, '', '', ?)",
  ).bind('banlapsed0001', victim.id, Date.now() - 60_000, Date.now()).run();

  const post = await publish(env, victim);
  check('an expired ban does not block', post.status === 201, `got ${post.status} ${post.text.slice(0, 140)}`);
});

await t('lifting a ban restores access', async (env) => {
  const admin = await registerAdmin(env, 'ownerc');
  const victim = await register(env, 'forgiven');

  await call(worker, env, `/api/admin/users/${victim.id}/ban`, {
    method: 'POST', body: { hours: 24 }, ...as(admin),
  });
  const lift = await call(worker, env, `/api/admin/users/${victim.id}/ban`, {
    method: 'DELETE', ...as(admin),
  });
  check('lift accepted', lift.status === 200, `got ${lift.status}`);
  check('lift reports how many rows it cleared', lift.json?.lifted === 1, JSON.stringify(lift.json));

  const post = await publish(env, victim);
  check('a lifted account can post again', post.status === 201, `got ${post.status}`);
});

await t('nobody but an admin may act on an admin account', async (env) => {
  const admin = await registerAdmin(env, 'ownerd');
  const other = await register(env, 'plainhelper');

  const banAdmin = await call(worker, env, `/api/admin/users/${admin.id}/ban`, {
    method: 'POST', body: { hours: 1 }, ...as(other),
  });
  check('an ordinary user cannot ban an admin', banAdmin.status === 403, `got ${banAdmin.status}`);

  // Nor with the moderator role, which is the case that would actually hurt.
  await call(worker, env, `/api/admin/users/${other.id}/role`, {
    method: 'POST', body: { role: 'moderator' }, ...as(admin),
  });
  const modBanAdmin = await call(worker, env, `/api/admin/users/${admin.id}/ban`, {
    method: 'POST', body: { hours: 1 }, ...as(other),
  });
  check('a moderator cannot ban an admin', modBanAdmin.status === 403, `got ${modBanAdmin.status}`);

  const still = await publish(env, admin);
  check('the admin can still publish', still.status === 201, `got ${still.status}`);
});

/* --------------------------------------------------------- the admin split */

await t('a moderator gets some powers and not others', async (env) => {
  const admin = await registerAdmin(env, 'ownere');
  const mod = await register(env, 'modone');
  const target = await register(env, 'spammerone');

  const promote = await call(worker, env, `/api/admin/users/${mod.id}/role`, {
    method: 'POST', body: { role: 'moderator' }, ...as(admin),
  });
  check('an admin can create a moderator', promote.status === 200, `got ${promote.status} ${promote.text.slice(0, 140)}`);
  check('the role reads back', promote.json?.user?.role === 'moderator', JSON.stringify(promote.json?.user?.role));

  const overview = await call(worker, env, '/api/admin/overview', as(mod));
  check('a moderator sees the overview', overview.status === 200, `got ${overview.status}`);
  check('the overview says moderator', overview.json?.role === 'moderator', JSON.stringify(overview.json?.role));

  const within = await call(worker, env, `/api/admin/users/${target.id}/ban`, {
    method: 'POST', body: { hours: 24 * 7, reason: 'spam' }, ...as(mod),
  });
  check('a moderator can ban for exactly 7 days', within.status === 201, `got ${within.status}`);

  const beyond = await call(worker, env, `/api/admin/users/${target.id}/ban`, {
    method: 'POST', body: { hours: 24 * 30 }, ...as(mod),
  });
  check('a moderator cannot ban for a month', beyond.status === 403, `got ${beyond.status}`);

  for (const [what, path, method, body] of [
    ['set roles', `/api/admin/users/${target.id}/role`, 'POST', { role: 'moderator' }],
    ['block nicks', '/api/admin/nicks', 'POST', { nick: 'anything' }],
    ['read the nick list', '/api/admin/nicks', 'GET', undefined],
  ]) {
    const r = await call(worker, env, path, { method, body, ...as(mod) });
    check(`a moderator cannot ${what}`, r.status === 403, `got ${r.status}`);
  }

  const lift = await call(worker, env, `/api/admin/users/${target.id}/ban`, { method: 'DELETE', ...as(mod) });
  check('a moderator cannot lift a ban', lift.status === 403, `got ${lift.status}`);
});

await t('the admin role is not storable, even if a row says otherwise', async (env) => {
  const admin = await registerAdmin(env, 'ownerf');
  const other = await register(env, 'rolejumper');

  const r = await call(worker, env, `/api/admin/users/${other.id}/role`, {
    method: 'POST', body: { role: 'admin' }, ...as(admin),
  });
  check('role=admin is accepted as a request', r.status === 200, `got ${r.status} ${r.text.slice(0, 140)}`);
  check('but is stored as user', r.json?.user?.role === 'user', JSON.stringify(r.json?.user?.role));
  check('and confers no admin rights', r.json?.user?.admin === false, JSON.stringify(r.json?.user?.admin));

  // Force the dangerous value past the setter, the way a lifted database or a
  // hand-edited row would.
  await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(other.id).run();
  const overview = await call(worker, env, '/api/admin/overview', as(other));
  check('a forged role still does not grant access', overview.status === 403, `got ${overview.status}`);
});

await t('the admin API is closed to signed-out callers', async (env) => {
  for (const path of [
    '/api/admin/overview', '/api/admin/users', '/api/admin/nicks',
    '/api/admin/items', '/api/admin/reports',
  ]) {
    const r = await call(worker, env, path, {});
    check(`${path} needs a session`, r.status === 401, `got ${r.status}`);
  }
  const post = await call(worker, env, '/api/admin/nicks', { method: 'POST', body: { nick: 'sneaky' } });
  check('POST /api/admin/nicks needs a session', post.status === 401, `got ${post.status}`);
});

/* ------------------------------------------------------------------ nicks */

await t('a blocked nick is refused on registration, case-insensitively', async (env) => {
  const admin = await registerAdmin(env, 'ownerg');

  const blocked = await call(worker, env, '/api/admin/nicks', {
    method: 'POST', body: { nick: 'Tatarhost', reason: 'impersonation' }, ...as(admin),
  });
  check('the nick is blocked', blocked.status === 201, `got ${blocked.status} ${blocked.text.slice(0, 140)}`);

  const r = await registerAs(env, 'tatarhost', 'nickclient000000001');
  check('a different casing is refused too', r.res.status === 403, `got ${r.res.status} ${r.res.text.slice(0, 140)}`);
  check('the reason is not disclosed', !/impersonation/i.test(r.res.text), r.res.text.slice(0, 160));

  const innocent = await registerAs(env, 'innocentbystander', 'nickclient000000002');
  check('an unblocked nick still registers', innocent.res.status === 201, `got ${innocent.res.status} ${innocent.res.text.slice(0, 140)}`);

  const list = await call(worker, env, '/api/admin/nicks', as(admin));
  check('the list shows the folded key', list.json?.blocked?.some((b) => b.nick_key === 'tatarhost'), JSON.stringify(list.json?.blocked));

  const un = await call(worker, env, '/api/admin/nicks/tatarhost', { method: 'DELETE', ...as(admin) });
  check('the nick is unblocked', un.status === 200, `got ${un.status}`);
  check('unblock reports the removal', un.json?.removed === 1, JSON.stringify(un.json));

  const after = await registerAs(env, 'tatarhost', 'nickclient000000003');
  check('the nick registers once unblocked', after.res.status === 201, `got ${after.res.status} ${after.res.text.slice(0, 140)}`);
});

await t('a blocked nick cannot be reached by renaming', async (env) => {
  const admin = await registerAdmin(env, 'ownerh');
  const user = await register(env, 'beforerename');

  await call(worker, env, '/api/admin/nicks', {
    method: 'POST', body: { nick: 'tatarhost' }, ...as(admin),
  });
  const r = await call(worker, env, '/api/auth/me', {
    method: 'PATCH', body: { nick: 'tatarhost' }, ...as(user),
  });
  check('renaming onto a blocked nick is refused', r.status === 403, `got ${r.status} ${r.text.slice(0, 140)}`);

  const kept = await call(worker, env, '/api/auth/me', as(user));
  check('the old nick survives', kept.json?.user?.nick === 'beforerename', JSON.stringify(kept.json?.user?.nick));
});

/* ------------------------------------------------------------ popular mark */

await t('the popular mark is admin-set and publicly visible', async (env) => {
  const admin = await registerAdmin(env, 'owneri');
  const author = await register(env, 'prolificone');

  const before = await call(worker, env, `/api/users/${author.id}`, { client: 'browsing0000000001' });
  check('not popular by default', before.json?.user?.popular === false, JSON.stringify(before.json?.user?.popular));

  const on = await call(worker, env, `/api/admin/users/${author.id}/popular`, {
    method: 'POST', body: { popular: true }, ...as(admin),
  });
  check('the mark is set', on.status === 200, `got ${on.status} ${on.text.slice(0, 140)}`);
  check('the response reports it', on.json?.user?.popular === true, JSON.stringify(on.json?.user?.popular));

  const stranger = await call(worker, env, `/api/users/${author.id}`, { client: 'browsing0000000002' });
  check('a stranger sees the mark', stranger.json?.user?.popular === true, JSON.stringify(stranger.json?.user?.popular));

  const off = await call(worker, env, `/api/admin/users/${author.id}/popular`, {
    method: 'POST', body: {}, ...as(admin),
  });
  check('an absent flag clears it', off.json?.user?.popular === false, JSON.stringify(off.json?.user?.popular));
});

/* ---------------------------------------------------------------- avatars */

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

await t('an account can upload, serve and remove an avatar', async (env) => {
  const user = await register(env, 'avatarowner');

  const up = await call(worker, env, '/api/auth/avatar', {
    method: 'POST', body: PNG_1PX, headers: { 'content-type': 'image/png' }, ...as(user),
  });
  check('upload accepted', up.status === 200, `got ${up.status} ${up.text.slice(0, 160)}`);
  const avatar = up.json?.avatar;
  check('an id is minted', /^\/a\/[a-z2-9]{16}$/.test(avatar || ''), JSON.stringify(avatar));

  const served = await call(worker, env, avatar, { client: 'spectator0000000001' });
  check('the avatar serves', served.status === 200, `got ${served.status} ${served.text.slice(0, 120)}`);
  const servedHeaders = served.res.headers;
  check('served as the declared type', servedHeaders.get('content-type') === 'image/png', String(servedHeaders.get('content-type')));
  check('cached immutably', /immutable/.test(servedHeaders.get('cache-control') || ''), String(servedHeaders.get('cache-control')));
  check('the bytes survive the round trip', served.res.body !== null, 'no body');

  const profile = await call(worker, env, `/api/users/${user.id}`, { client: 'spectator0000000002' });
  check('the profile carries it', profile.json?.user?.avatar === avatar, JSON.stringify(profile.json?.user?.avatar));

  const gone = await call(worker, env, '/api/auth/avatar', { method: 'DELETE', ...as(user) });
  check('avatar removed', gone.status === 200, `got ${gone.status}`);
  check('the profile drops it', !gone.json?.user?.avatar, JSON.stringify(gone.json?.user?.avatar));

  const after = await call(worker, env, avatar, { client: 'spectator0000000003' });
  check('the blob is gone, not orphaned', after.status === 404, `got ${after.status}`);
});

await t('avatar upload refuses a non-image, a stub and an anonymous caller', async (env) => {
  const user = await register(env, 'avatarowner2');

  const html = await call(worker, env, '/api/auth/avatar', {
    method: 'POST', body: Buffer.from('<html>hi</html>'),
    headers: { 'content-type': 'text/html' }, ...as(user),
  });
  check('text/html is refused', html.status === 415, `got ${html.status}`);

  const anon = await call(worker, env, '/api/auth/avatar', {
    method: 'POST', body: PNG_1PX, headers: { 'content-type': 'image/png' },
  });
  check('an anonymous upload is refused', anon.status === 401, `got ${anon.status}`);

  const stub = await call(worker, env, '/api/auth/avatar', {
    method: 'POST', body: Buffer.alloc(4),
    headers: { 'content-type': 'image/png' }, ...as(user),
  });
  check('a 4-byte stub is refused', stub.status === 400, `got ${stub.status}`);

  const none = await call(worker, env, '/api/auth/avatar', { method: 'DELETE' });
  check('an anonymous delete is refused', none.status === 401, `got ${none.status}`);
});

await t('replacing an avatar drops the old blob', async (env) => {
  const user = await register(env, 'avatarowner3');
  const first = await call(worker, env, '/api/auth/avatar', {
    method: 'POST', body: PNG_1PX, headers: { 'content-type': 'image/png' }, ...as(user),
  });
  const firstId = first.json.avatar;
  const second = await call(worker, env, '/api/auth/avatar', {
    method: 'POST', body: PNG_1PX, headers: { 'content-type': 'image/png' }, ...as(user),
  });
  check('a new id is minted on replace', second.json.avatar !== firstId, `${firstId} vs ${second.json?.avatar}`);
  const old = await call(worker, env, firstId, { client: 'watcher00000000001' });
  check('the replaced avatar 404s', old.status === 404, `got ${old.status}`);
});

/* ---------------------------------------------------------------- reports */

await t('a report is accepted without an account and lands in the queue', async (env) => {
  const admin = await registerAdmin(env, 'ownerj');

  const made = await call(worker, env, '/api/reports', {
    method: 'POST',
    body: { targetType: 'item', targetId: 'abcdefgh', reason: 'copyright', details: 'this is mine' },
    client: 'complainant00000001',
  });
  check('an anonymous report is accepted', made.status === 201, `got ${made.status} ${made.text.slice(0, 140)}`);
  const id = made.json?.id;
  check('an id comes back', /^[a-z2-9]{12}$/.test(id || ''), JSON.stringify(id));
  check('it comes back open', made.json?.status === 'open', JSON.stringify(made.json?.status));

  const queue = await call(worker, env, '/api/admin/reports', as(admin));
  const open = queue.json?.reports?.find((r) => r.id === id);
  check('the report is queued', !!open, JSON.stringify(queue.json?.reports?.map((r) => r.id)));
  check('it records the reason', open?.reason === 'copyright', JSON.stringify(open?.reason));
  check('it records the detail', open?.details === 'this is mine', JSON.stringify(open?.details));
  // The console reads camelCase, and both report routes have to agree on it: a
  // raw table row in one of them leaves the queue with an undefined target and
  // no takedown button at all.
  check('it names the target in the shape the console reads',
    open?.targetType === 'item' && open?.targetId === 'abcdefgh',
    JSON.stringify({ t: open?.targetType, id: open?.targetId }));
  check('it comes back open', open?.status === 'open', JSON.stringify(open?.status));
  check('it records no reporter account', open?.byUserId === '', JSON.stringify(open?.byUserId));
  check('it records the client that filed it', !!open?.byClient, JSON.stringify(open?.byClient));

  const done = await call(worker, env, `/api/admin/reports/${id}`, {
    method: 'POST', body: { status: 'resolved' }, ...as(admin),
  });
  check('it resolves', done.status === 200, `got ${done.status}`);

  const stillOpen = await call(worker, env, '/api/admin/reports?status=open', as(admin));
  check('it is no longer in the open list', !stillOpen.json?.reports?.some((r) => r.id === id), JSON.stringify(stillOpen.json?.reports?.map((r) => r.id)));
});

await t('a report validates its target and reason', async (env) => {
  const badTarget = await call(worker, env, '/api/reports', {
    method: 'POST', body: { targetType: 'planet', targetId: 'abcdefgh', reason: 'spam' },
    client: 'rptclient0000000001',
  });
  check('an unknown target type is refused', badTarget.status === 400, `got ${badTarget.status}`);

  const badReason = await call(worker, env, '/api/reports', {
    method: 'POST', body: { targetType: 'item', targetId: 'abcdefgh', reason: 'because' },
    client: 'rptclient0000000002',
  });
  check('an unknown reason is refused', badReason.status === 400, `got ${badReason.status}`);

  const badId = await call(worker, env, '/api/reports', {
    method: 'POST', body: { targetType: 'item', targetId: 'no', reason: 'spam' },
    client: 'rptclient0000000003',
  });
  check('a malformed target id is refused', badId.status === 400, `got ${badId.status}`);

  const badStatus = await call(worker, env, '/api/admin/reports/abcdefgh', {
    method: 'POST', body: { status: 'ignored' },
  });
  check('an unknown resolution is refused', badStatus.status === 401, `got ${badStatus.status}`);
});

/* ------------------------------------------------------------------ stats */

await t('stats are public, and the daily series is opt-in', async (env) => {
  const bare = await call(worker, env, '/api/stats', { client: 'statsones00000001' });
  check('anonymous callers get stats', bare.status === 200, `got ${bare.status}`);
  check('user count is reported', typeof bare.json?.users === 'number', JSON.stringify(bare.json?.users));
  check('items count is reported', typeof bare.json?.items === 'number', JSON.stringify(bare.json?.items));
  check('the series is not sent unless asked for', bare.json?.series === undefined, JSON.stringify(bare.json?.series));

  await register(env, 'seriesone');
  const withSeries = await call(worker, env, '/api/stats?series=7', { client: 'statsones00000002' });
  check('the series is returned when asked', Array.isArray(withSeries.json?.series), JSON.stringify(withSeries.json?.series)?.slice(0, 100));
  check('it covers seven days', withSeries.json?.series?.length === 7, `got ${withSeries.json?.series?.length}`);
  check('entries are oldest first', withSeries.json.series.every((d, i, a) => i === 0 || d.day > a[i - 1].day), 'not ascending');

  const today = withSeries.json.series.at(-1);
  check('the last day is today', today.day === new Date().toISOString().slice(0, 10), JSON.stringify(today.day));
  check('today counts a registration', today.registrations >= 1, JSON.stringify(today.registrations));
  check('today counts a visitor', today.visitors >= 1, JSON.stringify(today.visitors));

  const adminEnv = await registerAdmin(env, 'ownerk');
  const overview = await call(worker, env, '/api/admin/overview', as(adminEnv));
  check('the overview carries a 30-day series', overview.json?.series?.length === 30, `got ${overview.json?.series?.length}`);
});

/* ------------------------------------------ moderation deletes any post */

await t('a moderator can delete a post without the edit secret', async (env) => {
  const admin = await registerAdmin(env, 'ownerl');
  const mod = await register(env, 'modtwo');
  const author = await register(env, 'postauthor');

  const made = await publish(env, author, 'to be removed');
  const id = made.json?.item?.id;
  check('the post exists', !!id, JSON.stringify(made.json).slice(0, 140));

  await call(worker, env, `/api/admin/users/${mod.id}/role`, {
    method: 'POST', body: { role: 'moderator' }, ...as(admin),
  });

  const removed = await call(worker, env, `/api/admin/items/${id}`, { method: 'DELETE', ...as(mod) });
  check('it deletes without an edit secret', removed.status === 200, `got ${removed.status} ${removed.text.slice(0, 140)}`);
  check('the response names who acted', removed.json?.removedBy === mod.id, JSON.stringify(removed.json?.removedBy));

  const gone = await call(worker, env, `/api/items/${id}`, { client: 'onslooker0000000001' });
  check('it is really gone', gone.status === 404, `got ${gone.status}`);
});

await t('an ordinary user cannot delete a post they do not own', async (env) => {
  const author = await register(env, 'postauthor2');
  const nosy = await register(env, 'nosyone');
  const made = await publish(env, author, 'mine');
  const id = made.json.item.id;

  const r = await call(worker, env, `/api/admin/items/${id}`, { method: 'DELETE', ...as(nosy) });
  check('the attempt is refused', r.status === 403, `got ${r.status}`);

  const still = await call(worker, env, `/api/items/${id}`, { client: 'onslooker0000000002' });
  check('the post survives', still.status === 200, `got ${still.status}`);
});

/* ------------------------------------------------------------------ report */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
