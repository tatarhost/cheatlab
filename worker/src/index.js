import { Store } from './store.js';
import { BlobStore } from './blobs.js';
import { PluginHost } from './plugins.js';
import {
  newId, newSecret, secretHash, secretMatches, normaliseClientId, authorTag,
  str, tags, clamp, safeFilename, mimeOf, isTextExt, extOf, now, sha256,
} from './util.js';
import {
  hashPassword, verifyPassword, passwordProblems, nickProblems, nickKey,
  newUserId, newSession, sessionValid, publicUser, SESSION_TTL_MS,
} from './accounts.js';
import {
  checkPow, newPowChallenge, issueCaptcha, verifyCaptcha,
  quotaFor, storageUsed, QUOTA, DAY_MS,
} from './abuse.js';

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

/* ---------------------------------------------------------------- identity -- */

/**
 * Resolves the signed-in user, if any.
 *
 * A session is a bearer token that is additionally bound to the client id that
 * created it, so a leaked token is useless when replayed from a different
 * browser. Failure is silent and returns null: every route treats "no session"
 * as anonymous rather than as an error, which is what keeps the original
 * no-registration publishing flow working unchanged.
 */
async function identity(request, env) {
  const token = request.headers.get('x-cheatlab-session');
  if (!token || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const { STORE } = env;
  const row = await STORE.getSession(await secretHash(token));
  if (!(await sessionValid(row, clientOf(request)))) return null;

  const user = await STORE.getUser(row.user_id);
  if (!user) return null;

  env.waitUntil?.(
    Promise.all([
      STORE.touchSession(row.token_hash),
      STORE.updateUser(user.id, { last_seen_at: now() }),
    ]).catch(() => {}),
  );
  return { user, token, tokenHash: row.token_hash };
}

/** Where a user's quota and storage are accounted. */
const ownerKeyOf = (id) => (id ? `u:${id.user_id ?? id.id}` : id);

/**
 * Proof-of-work gate. Issued free to anyone who asks, checked on writes. This
 * is the cheap first layer: it costs a normal browser milliseconds and stops a
 * naive request loop before it ever reaches the CAPTCHA.
 */
async function powGate(request, env) {
  const challenge = request.headers.get('x-cheatlab-pow');
  const nonce = request.headers.get('x-cheatlab-pow-nonce');
  if (!(await checkPow(challenge, nonce, env))) {
    return { ok: false, challenge: newPowChallenge(), error: 'solve the proof of work first' };
  }
  return { ok: true };
}

/**
 * CAPTCHA gate for the anonymous tier. Registered users skip it entirely, per
 * the product rule. The answer is checked against a server-side row and the
 * challenge is consumed on success, so solving one post does not license a
 * burst of the rest.
 */
async function captchaGate(request, env, payload) {
  const token = payload?.captchaToken;
  const answer = payload?.captchaAnswer;
  if (await verifyCaptcha(env.STORE.db, env, token, answer)) return { ok: true };
  const next = await issueCaptcha(env.STORE.db, env);
  return {
    ok: false,
    error: 'captcha required',
    captcha: { id: next.id, q: next.q, token: next.token },
  };
}

/**
 * Per-day budget for *creating* items, counted from the items table rather than
 * the throttle table, because a daily quota has to survive isolate restarts.
 *
 * Takes the user id and client id separately: a client id is also a non-empty
 * string, so a single `owner` argument cannot say "anonymous" reliably.
 */
async function newItemQuota(store, userId, clientId) {
  const since = now() - DAY_MS;
  const row = userId
    ? await store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM items i
             JOIN item_owner o ON o.item_id = i.id
            WHERE o.user_id = ? AND i.created_at > ?`,
        )
        .bind(userId, since)
        .first()
    : await store.db
        .prepare('SELECT COUNT(*) AS n FROM items WHERE author = ? AND created_at > ?')
        .bind(clientId, since)
        .first();
  return Number(row?.n) || 0;
}

/**
 * Storage ceiling, so one account cannot consume the shared bucket.
 * `owner` is either a user row or null; the client id is passed separately for
 * the anonymous case, which is keyed by client rather than by account.
 */
async function storageGate(store, user, clientId, env) {
  const q = quotaFor(user, env);
  const used = await storageUsed(store.db, user ? ownerKeyOf(user) : clientId);
  if (used >= q.storageBytes) {
    return { ok: false, error: 'storage quota exhausted', used, limit: q.storageBytes };
  }
  return { ok: true, used, limit: q.storageBytes, remaining: q.storageBytes - used };
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
    // The client renders limits from this rather than hard-coding them, so the
    // numbers here and the numbers the server enforces cannot drift apart.
    authModes: ['device', 'account'],
    quota: {
      anonymous: { ...QUOTA.anonymous, editsPerDay: QUOTA.anonymous.editsPerDay },
      registered: { ...QUOTA.registered, editsPerDay: null },
    },
    plugins: env.PLUGINS.describe(),
  });
});

route('GET', /^\/api\/stats$/, async (_r, env) => json(await env.STORE.stats()));

/* ------------------------------------------------------------- accounts -- */

/**
 * The client's captcha PoW challenge. Issued without authentication and without
 * rate limiting beyond the shared write cap, because the whole point is that a
 * legitimate client can obtain one before it has done anything.
 */
route('GET', /^\/api\/auth\/pow$/, async (request, env) => {
  const id = clientOf(request) || 'anon';
  if (!(await env.STORE.throttle(id, 'pow', { cap: 20, windowMs: 60_000 }))) {
    return fail(429, 'slow down');
  }
  return json({ challenge: newPowChallenge(), pows: true });
});

/** Same, for the captcha question. `?risk=` lets the client ask for the hard one. */
route('GET', /^\/api\/auth\/captcha$/, async (request, env, _m, url) => {
  const id = clientOf(request) || 'anon';
  if (!(await env.STORE.throttle(id, 'captcha', { cap: 20, windowMs: 60_000 }))) {
    return fail(429, 'slow down');
  }
  const risk = clamp(Number(url.searchParams.get('risk')) || 0, 0, 1);
    const { id: cid, q, token, exp } = await issueCaptcha(env.STORE.db, env, { risk });
  return json({ id: cid, q, token, exp });
});

route('POST', /^\/api\/auth\/register$/, async (request, env) => {
  const { STORE } = env;
  const c = config(env);
  const client = clientOf(request);
  if (!client) return fail(401, 'missing client id');

  if (!(await STORE.throttle(client, 'register', { cap: 3, windowMs: 60 * 60 * 1000 }))) {
    return fail(429, 'too many registration attempts, try later');
  }

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  // Every account costs a 210k-iteration hash, so an unverified caller must
  // first do the proof of work. Without this, registration is a free CPU-burn
  // oracle: the server pays 210k hashes and the caller pays nothing.
  const pow = await powGate(request, env);
  if (!pow.ok) {
    return json({ error: pow.error, pow: { challenge: pow.challenge } }, 403);
  }

  const nick = str(payload.nick, 24);
  const nickProblemsList = nickProblems(nick);
  if (nickProblemsList.length) return fail(400, nickProblemsList[0], { problems: nickProblemsList });

  const passProblems = passwordProblems(payload.password);
  if (passProblems.length) return fail(400, passProblems[0], { problems: passProblems });

  const key = nickKey(nick);
  if (await STORE.getUserByNickKey(key)) return fail(409, 'that nick is already taken');

  const { passHash, passSalt, iterations } = await hashPassword(payload.password);
  const id = newUserId();

  let row;
  try {
    row = await STORE.createUser({ id, nick, nickKey: key, passHash, passSalt, iterations });
  } catch (err) {
    // The UNIQUE index is the real guard against a concurrent double-register;
    // a loser of that race gets the same friendly answer as an early check.
    if (/UNIQUE|constraint/i.test(String(err.message))) {
      return fail(409, 'that nick is already taken');
    }
    throw err;
  }

  const { token, tokenHash } = await newSession();
  await STORE.createSession({
    tokenHash,
    userId: id,
    createdAt: now(),
    expiresAt: now() + SESSION_TTL_MS,
    clientId: client,
    userAgent: str(request.headers.get('user-agent'), 200),
  });

  return json({ user: publicUser(row), token, expiresAt: now() + SESSION_TTL_MS }, 201);
});

route('POST', /^\/api\/auth\/login$/, async (request, env) => {
  const { STORE } = env;
  const c = config(env);
  const client = clientOf(request);
  if (!client) return fail(401, 'missing client id');

  const key = clientOf(request) || 'anon';
  if (!(await STORE.throttle(`login:${key}`, 'auth', { cap: 10, windowMs: 15 * 60 * 1000 }))) {
    return fail(429, 'too many login attempts, try later');
  }

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  const row = await STORE.getUserByNickKey(nickKey(str(payload.nick, 24)));

  // Always run a hash, even when the nick is unknown, so a wrong nick and a
  // wrong password take the same time. Otherwise response time alone
  // enumerates which nicks are registered.
  const stored = row || { pass_hash: 'x', pass_salt: 'x', iterations: 1 };
  const { ok, needsRehash } = await verifyPassword(payload.password, stored);
  if (!row || !ok) return fail(401, 'wrong nick or password');

  if (needsRehash) {
    const { passHash, passSalt, iterations } = await hashPassword(payload.password);
    await STORE.updateUser(row.id, { pass_hash: passHash, pass_salt: passSalt, iterations });
  }

  const { token, tokenHash } = await newSession();
  await STORE.createSession({
    tokenHash,
    userId: row.id,
    createdAt: now(),
    expiresAt: now() + SESSION_TTL_MS,
    clientId: client,
    userAgent: str(request.headers.get('user-agent'), 200),
  });

  return json({ user: publicUser(row), token, expiresAt: now() + SESSION_TTL_MS });
});

route('POST', /^\/api\/auth\/logout$/, async (request, env) => {
  const id = await identity(request, env);
  if (id) await env.STORE.deleteSession(id.tokenHash);
  return json({ ok: true });
});

/** Who am I, and which tier am I on. The frontend calls this on boot. */
route('GET', /^\/api\/auth\/me$/, async (request, env) => {
  const id = await identity(request, env);
  const q = quotaFor(id?.user, env);
  if (!id) {
    return json({ user: null, quota: { ...q, storageBytes: q.storageBytes } });
  }
  const client = clientOf(request);
  const used = await storageUsed(env.STORE.db, ownerKeyOf(id.user));
  return json({
    user: publicUser(id.user),
    quota: { ...q, storageBytes: q.storageBytes, storageUsed: used, storageLeft: Math.max(0, q.storageBytes - used) },
  });
});

route('PATCH', /^\/api\/auth\/me$/, async (request, env) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required');
  const c = config(env);

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  const patch = {};

  if (typeof payload.nick === 'string') {
    const nick = str(payload.nick, 24);
    const problems = nickProblems(nick);
    if (problems.length) return fail(400, problems[0], { problems });
    const key = nickKey(nick);
    const clash = await env.STORE.getUserByNickKey(key);
    if (clash && clash.id !== id.user.id) return fail(409, 'that nick is already taken');
    patch.nick = nick;
    patch.nick_key = key;
  }

  if (typeof payload.bio === 'string') patch.bio = str(payload.bio, 200);

  // Changing a password requires the current one, otherwise a stolen session is
  // enough to lock the owner out permanently.
  if (typeof payload.password === 'string' && payload.password) {
    const problems = passwordProblems(payload.password);
    if (problems.length) return fail(400, problems[0], { problems });
    const { ok } = await verifyPassword(payload.currentPassword, id.user);
    if (!ok) return fail(403, 'current password is wrong');
    const { passHash, passSalt, iterations } = await hashPassword(payload.password);
    patch.pass_hash = passHash;
    patch.pass_salt = passSalt;
    patch.iterations = iterations;
  }

  const row = await env.STORE.updateUser(id.user.id, patch);

  // A password change invalidates every other session, so a stolen token dies
  // with it. The caller's own session is refreshed at the end.
  if (patch.pass_hash) {
    await env.STORE.deleteAllSessions(id.user.id);
    const { token, tokenHash } = await newSession();
    await env.STORE.createSession({
      tokenHash,
      userId: id.user.id,
      createdAt: now(),
      expiresAt: now() + SESSION_TTL_MS,
      clientId: clientOf(request) || '',
      userAgent: str(request.headers.get('user-agent'), 200),
    });
    return json({ user: publicUser(row), token, reauth: true });
  }

  return json({ user: publicUser(row) });
});

/* ---------------------------------------------------------------- social -- */

route('GET', /^\/api\/users$/, async (request, env, _m, url) => {
  const q = url.searchParams;
  const id = await identity(request, env);
  const key = clientOf(request) || 'anon';
  if (!(await env.STORE.throttle(key, 'read', { cap: config(env).readCap, windowMs: 60_000 }))) {
    return fail(429, 'slow down');
  }
  const search = str(q.get('q'), 24);
  // An empty search would dump the whole member list, which is both a privacy
  // leak and a cheap way to enumerate accounts to spam.
  if (search.length < 2) return fail(400, 'search needs at least 2 characters');
  const rows = await env.STORE.searchUsers(search, { excludeId: id?.user.id, limit: 20 });
  return json({ users: rows.map(publicUser) });
});

route('GET', /^\/api\/users\/([A-Za-z0-9_-]{3,32})$$/, async (request, env, m) => {
  const viewer = await identity(request, env);
  const row = await env.STORE.getUser(m[1]);
  if (!row) return fail(404, 'no such user');
  const items = await env.STORE.itemsOfUser(row.id, { limit: 20 });
  return json({
    user: publicUser(row),
    isFollowing: await env.STORE.isFollowing(viewer?.user.id, row.id),
    items: await Promise.all(items.map((it) => itemView(env.STORE, it))),
  });
});

route('GET', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/followers$/, async (request, env, m) => {
  const rows = await env.STORE.followersOf(m[1], { limit: 100 });
  return json({ users: rows.map(publicUser) });
});

route('GET', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/following$/, async (request, env, m) => {
  const rows = await env.STORE.followingOf(m[1], { limit: 100 });
  return json({ users: rows.map(publicUser) });
});

/**
 * Follow. Requires an account, per the product rule that anonymous visitors
 * cannot add friends. The PoW gate is skipped for registered users because
 * their cost is already bounded by the registration hash.
 */
route('POST', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/follow$/, async (request, env, m) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required to add friends');
  const target = await env.STORE.getUser(m[1]);
  if (!target) return fail(404, 'no such user');

  const r = await env.STORE.followUser(id.user.id, target.id);
  const fresh = await env.STORE.getUser(target.id);
  return json({ ok: r.ok, following: true, reason: r.reason, user: publicUser(fresh) }, r.reason === 'self' ? 400 : 200);
});

route('DELETE', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/follow$/, async (request, env, m) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required');
  const target = await env.STORE.getUser(m[1]);
  if (!target) return fail(404, 'no such user');
  await env.STORE.unfollowUser(id.user.id, target.id);
  const fresh = await env.STORE.getUser(target.id);
  return json({ ok: true, following: false, user: publicUser(fresh) });
});

/** Like is a toggle: POST likes, DELETE unlikes, both idempotent. */
route('POST', /^\/api\/items\/([A-Za-z0-9]{4,16})\/like$/, async (request, env, m) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required');
  const item = await env.STORE.getItem(m[1]);
  if (!item) return fail(404, 'not found');
  await env.STORE.likeItem(item.id, id.user.id);
  const fresh = await env.STORE.getItem(item.id);
  return json({ liked: true, likes: fresh.likes || 0 });
});

route('DELETE', /^\/api\/items\/([A-Za-z0-9]{4,16})\/like$/, async (request, env, m) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required');
  const item = await env.STORE.getItem(m[1]);
  if (!item) return fail(404, 'not found');
  await env.STORE.unlikeItem(item.id, id.user.id);
  const fresh = await env.STORE.getItem(item.id);
  return json({ liked: false, likes: fresh.likes || 0 });
});

route('GET', /^\/api\/items\/([A-Za-z0-9]{4,16})\/comments$/, async (request, env, m, url) => {
  const viewer = await identity(request, env);
  const limit = clamp(Number(url.searchParams.get('limit')) || 50, 1, 100);
  const rows = await env.STORE.listComments(m[1], { limit });
  return json({
    comments: rows.map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.created_at,
      nick: r.nick,
      userId: r.author_id,
      // Lets the UI decide whether to offer delete without a second request.
      canDelete: !!viewer && viewer.user.id === r.author_id,
    })),
  });
});

route('POST', /^\/api\/items\/([A-Za-z0-9]{4,16})\/comments$/, async (request, env, m) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required to comment');
  const { STORE } = env;
  const c = config(env);
  const client = clientOf(request);
  if (!(await STORE.throttle(`comment:${client || 'anon'}`, 'write', { cap: c.writeCap, windowMs: 60_000 }))) {
    return fail(429, 'slow down');
  }
  const item = await STORE.getItem(m[1]);
  if (!item) return fail(404, 'not found');

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }
  const body = str(payload.body, 1000);
  if (!body) return fail(400, 'comment is empty');

  const row = await STORE.addComment({ id: newId(8), itemId: item.id, userId: id.user.id, body });
  const fresh = await STORE.getItem(item.id);
  return json({
    comment: { id: row.id, body: row.body, createdAt: row.created_at, nick: id.user.nick, userId: id.user.id, canDelete: true },
    comments: fresh.comments || 0,
  }, 201);
});

route('DELETE', /^\/api\/comments\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required');
  const row = await env.STORE.getComment(m[1]);
  if (!row) return fail(404, 'no such comment');
  // The author, or the owner of the item being discussed, may delete.
  const isAuthor = row.user_id === id.user.id;
  const ownsItem = (await env.STORE.ownerOfItem(row.item_id)) === id.user.id;
  if (!isAuthor && !ownsItem) return fail(403, 'not yours to delete');
  await env.STORE.deleteComment(row.id);
  return json({ ok: true });
});

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

  // The daily budget is the product rule: 1 new item per day anonymous, 4 per
  // day registered. Counted from items, not from the throttle table, so it
  // survives isolate restarts.
  const who = await identity(request, env);
  const quota = quotaFor(who?.user, env);
  const usedToday = await newItemQuota(STORE, who?.user.id, id);
  if (usedToday >= quota.newItemsPerDay) {
    return fail(429, who
      ? `daily limit reached (${quota.newItemsPerDay} posts/day)`
      : 'daily limit reached (1 post/day) - register an account for more', {
      quota: { newItemsPerDay: quota.newItemsPerDay, usedToday, registered: !!who },
    });
  }

  const storage = await storageGate(STORE, who?.user, id, env);
  if (!storage.ok) return fail(413, storage.error, { quota: { used: storage.used, limit: storage.limit } });

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  // Anonymous publishing requires a captcha on every post; registered users are
  // exempt, which is the entire incentive to register.
  if (quota.captchaOnPost) {
    const cap = await captchaGate(request, env, payload);
    if (!cap.ok) return json({ error: cap.error, captcha: cap.captcha }, 403);
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
  // Bind to the account when signed in, so /api/users/<id> lists it and the
  // profile follower count stays meaningful.
  if (who) {
    await STORE.bindItem(row.id, who.user.id);
    await STORE.recomputeCounts(who.user.id);
  }
  const view = await itemView(STORE, row, { full: true });
  await env.PLUGINS.run('item:published', view, ctxOf(request, env));
  return json({ item: view, secret, registered: !!who }, 201);
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

/**
 * Inline serving must not hand the browser anything it could execute, but the
 * rule is not "binary is unsafe": an <img> or <video> pointed at
 * application/octet-stream simply refuses to render, so media on the preview
 * route has to keep its real type or previews and scrubbing break.
 *
 * `render` is what separates the two callers. The media route wants a file
 * shown in the page, so image, video and audio keep their real type; the raw
 * route only ever displays a text file and inlines anything else as a download.
 * SVG stays blocked in both cases because it can carry script.
 */
function serveType(file, inline, render) {
  if (!inline) return file.mime;
  const mime = file.mime || 'application/octet-stream';
  if (render && /^(?:image\/(?!svg\+xml)|video\/|audio\/)/i.test(mime)) return mime;
  if (isTextExt(extOf(file.name))) return mime;
  return 'application/octet-stream';
}

async function serveFile(request, env, file, { inline, render = false }) {
  const etag = `"${file.sha256}"`;
  const headers = {
    'Content-Type': serveType(file, inline, render),
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
  if (range) return serveFile(request, env, file, { inline: true, render: true });
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
          // Internal detail is not echoed to callers; it is logged for us. An
          // earlier build returned err.message, which leaked SQL text.
          console.error('route error', r.method, url.pathname, err?.stack || err);
          return withCors(fail(500, 'server error'), origin);
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
