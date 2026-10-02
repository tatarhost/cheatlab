import { Store } from './store.js';
import { BlobStore, KV_MAX_PUT_BYTES } from './blobs.js';
import { previewUrl, thumbUrl, posterUrl, cloudinaryReady } from './cloudinary.js';
import { LOGO_URL, COVER_URL } from './urls.js';
import { ConversationRoom, roomNameFor } from './room.js';
import {
  ChatStore, rightsFor, messageGame, MESSAGE_MAX, TITLE_MAX as TITLE_MAX_CHAT,
  TOPIC_MAX as TOPIC_MAX_CHAT, TICKET_TTL_MS,
} from './chats.js';
import { PluginHost } from './plugins.js';
import {
  newId, newSecret, secretHash, secretMatches, normaliseClientId, authorTag,
  str, tags, clamp, safeFilename, mimeOf, isTextExt, extOf, now, sha256,
} from './util.js';
import {
  hashPassword, verifyPassword, passwordProblems, nickProblems, nickKey,
  newUserId, newSession, sessionValid, publicUser, adminOf, SESSION_TTL_MS,
} from './accounts.js';
import {
  checkPow, newPowChallenge, issueCaptcha, verifyCaptcha,
  quotaFor, storageUsed, powBits, QUOTA, DAY_MS,
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

/**
 * Which game a paste is for, and the key system it talks to.
 *
 * The names arrive from the browser, which resolves them against the game's own
 * public API, and are stored as plain strings rather than as a verified lookup:
 * a paste's title and body are user claims too, and the point of the game chip
 * is to say which game a script is written for, not to certify it. Everything is
 * length-capped and stripped of markup because it is rendered as text.
 */
function gameFields(payload) {
  const out = {};
  // A too-long id is dropped rather than truncated: a cut id is a different id,
  // and a chip pointing at the wrong game is worse than no chip. The names are
  // display strings, so cutting those is harmless.
  const rawId = str(payload.gameId, 400);
  if (rawId && rawId.length <= 40) {
    out.game_id = rawId;
    out.game_name = str(payload.gameName, 120);
    out.game_author = str(payload.gameAuthor, 80);
    // A cover is a url the browser is about to put in an <img>, so the check is
    // the scheme and the shape of the url, not a guess about its file extension.
    //
    // An extension check looks tidier and is wrong here: Roblox's thumbnail
    // service hands back urls that end in a format token, e.g.
    // `https://tr.rbxcdn.com/180DAY-…/150/150/GameIcon6/Png/noFilter`, so every
    // cover this Worker fetched automatically would have been thrown away. What
    // actually has to be refused is a scheme that executes - `javascript:` and
    // `data:` both do - and a url that could break out of an attribute, so the
    // rule is https only, with no whitespace or quote characters in it. This is
    // the same rule the profile logo already uses, which is why a cover and a
    // logo cannot disagree about what a safe image url is.
    const cover = str(payload.gameCover, 600);
    out.game_cover = COVER_URL.test(cover) ? cover : '';
  }
  const keySystem = str(payload.keySystem, 40);
  if (keySystem) out.key_system = keySystem;
  return out;
}

function config(env) {
  // MAX_FILE_MB is what we would like to accept; what we can accept also depends
  // on where the bytes land. With Cloudinary's four secrets unset the upload path
  // is KV, whose own ceiling is lower than the configured cap, and a config that
  // promised 50 MB there would let the browser pre-check a file the store would
  // then reject mid-upload. So the advertised limit is the smaller of the two,
  // and the client is told which store is actually in use.
  const wantedFileBytes = Number(env.MAX_FILE_MB || 50) * 1024 * 1024;
  const stored = cloudinaryReady(env);
  return {
    // 50 MB is the free Workers request body limit divided by two, and also well
    // under Cloudinary's 100 MB per-file cap, so the Worker never becomes the
    // bottleneck for a large archive.
    maxFileBytes: stored ? wantedFileBytes : Math.min(wantedFileBytes, KV_MAX_PUT_BYTES),
    storage: stored ? 'cloudinary' : 'kv',
    maxTextBytes: Number(env.MAX_TEXT_KB || 256) * 1024,
    maxFilesPerItem: Number(env.MAX_FILES || 60),
    titleMax: Number(env.TITLE_MAX || 120),
    labelMax: Number(env.LABEL_MAX || 24),
    accessKeyMax: 64,
    keyHintMax: 80,
    writeCap: Number(env.WRITE_CAP || 90),
    readCap: Number(env.READ_CAP || 240),
    allowOrigin: env.ALLOW_ORIGIN || '*',
  };
}

/**
 * What the client needs to render a file. A CDN-backed file carries its own
 * derived urls, so the browser can ask for a 320 px thumb or a poster frame
 * without knowing anything about Cloudinary transformations.
 */
function fileView(file) {
  const view = {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    downloads: file.downloads || 0,
  };
  if (file.store === 'cloudinary' && file.url) {
    view.url = file.url;
    view.preview = previewUrl(file.url);
    view.thumb = thumbUrl(file.url);
    if (/^video\//i.test(file.mime || '')) view.poster = posterUrl(file.url);
  } else {
    view.preview = `/m/${file.id}`;
    view.thumb = `/m/${file.id}`;
  }
  return view;
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
    likes: Number(row.likes) || 0,
    comments: Number(row.comments) || 0,
    // A non-NULL access_key_hash means the body and files are behind a key.
    locked: !!row.access_key_hash,
    keyHint: row.key_hint || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Which game the paste is for. Free text on the row rather than a join, so a
    // game can be renamed upstream without rewriting every paste that mentions
    // it, and a paste that targets no game simply leaves these empty.
    game: row.game_id ? {
      id: row.game_id,
      name: row.game_name || '',
      author: row.game_author || '',
      cover: row.game_cover || '',
    } : null,
    keySystem: row.key_system || '',
    files: files.map((f) => {
      const view = fileView(f);
      return { ...view, sha256: String(f.sha256 || '').slice(0, 16), createdAt: f.createdAt ?? f.created_at };
    }),
    fileSize: files.reduce((a, f) => a + f.size, 0),
  };
  return base;
}

/**
 * Two-step: files + hashed author tag are both async now.
 *
 * When `unlocked` is false - a locked item seen without its key - the file list
 * and the body are withheld entirely and the preview is emptied, while the
 * shell (title, tags, counts, `locked: true`, `keyHint`) still renders. The
 * owner is resolved so the UI can link the author and offer a follow button.
 */
async function itemView(store, row, { full = false, unlocked = true, ownerId = null } = {}) {
  if (!row) return null;
  const files = unlocked ? await store.listFiles(row.id) : [];
  const tag = await authorTag(row.author);
  const base = publicItem(row, files, tag);
  base.unlocked = unlocked;
  if (!unlocked) base.files = [];
  if (unlocked && full) base.body = row.body;
  else if (unlocked) base.preview = row.body.slice(0, 240);
  else base.preview = '';
  if (ownerId === null) ownerId = await store.ownerOfItem(row.id);
  if (ownerId) {
    const owner = await store.getUser(ownerId);
    if (owner) {
      base.ownerId = owner.id;
      base.authorLabel = owner.nick;
      // The two flags a post needs next to its author line: the avatar, so the
      // feed and the item page agree with the profile, and the popular mark, so
      // it is visible on the publication and not only on the author's page.
      base.owner = {
        id: owner.id,
        nick: owner.nick,
        popular: !!owner.popular,
        avatar: owner.avatar_id ? `/a/${owner.avatar_id}` : '',
      };
    }
  }
  return base;
}

/**
 * The access key travels in the `x-cheatlab-key` header, or for media and raw
 * routes - which load <img>/<video>/<script> that cannot set headers - as a
 * `?key=` query string. A key never comes back from the server once set.
 */
function keyOf(request, url) {
  const h = request.headers.get('x-cheatlab-key');
  if (h) return String(h);
  const q = url?.searchParams?.get('key');
  if (!q) return '';
  try { return decodeURIComponent(q); } catch { return q; }
}

async function isUnlocked(row, request, url) {
  if (!row?.access_key_hash) return true;
  const key = keyOf(request, url);
  return !!key && (await secretMatches(key, row.access_key_hash));
}

/** Gates a media/file/raw route behind the item's access key, if any. */
async function lockedGate(request, env, itemId, url) {
  const row = await env.STORE.getItem(itemId);
  if (row && row.access_key_hash && !(await isUnlocked(row, request, url))) {
    return fail(403, 'key required');
  }
  return null;
}

/* ---- profile design sanitisation: raw CSS and URLs never touch the page -- */

// LOGO_URL and COVER_URL live in src/urls.js now that a game cover also appears
// in chat messages, so all three surfaces are judged by one rule.

const ACCENT_HEX = /^#[0-9a-fA-F]{6}$/;
// Allowlist, not a blocklist: anything not spelled out here is dropped. The set
// is what a gradient actually needs - letters, digits, `,` between stops, `%`
// and `-` for angles, `#` for colours, `()` for the function, and `:` for the
// `linear-gradient(180deg, ...)` syntax. `/` and `;` stay out on purpose, so
// neither a path nor a second declaration can be smuggled in behind a gradient
// that looks legitimate.
const BG_VALUE = /^[A-Za-z0-9 #.,%():\-]{0,128}$/;
// The colon needed for gradient syntax also makes `url(javascript:...)` fit the
// allowlist, so the one function this field has no use for is named outright.
// A background here is a colour or a gradient; a fetch is never the intent.
const BG_FETCH = /url\s*\(/i;

function sanitizeLogo(v) {
  const t = str(v, 300);
  return t && LOGO_URL.test(t) ? t : '';
}
function sanitizeAccent(v) {
  const t = str(v, 16).toLowerCase();
  return t && ACCENT_HEX.test(t) ? t : '';
}
function sanitizeBg(v) {
  const t = str(v, 120);
  return t && !BG_FETCH.test(t) && BG_VALUE.test(t) ? t : '';
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

  // A ban blocks the account, not the token: the session survives so the user
  // keeps their uploads and can read the reason when the ban lifts. Routes that
  // write call requireUnbanned() explicitly, because a banned user may still
  // legitimately need to read their own profile or download their own files.
  const ban = await STORE.activeBan(user.id);

  env.waitUntil?.(
    Promise.all([
      STORE.touchSession(row.token_hash),
      STORE.updateUser(user.id, { last_seen_at: now() }),
    ]).catch(() => {}),
  );
  return { user, token, tokenHash: row.token_hash, ban };
}

/**
 * Guard for every write by a signed-in account. Returns a 403 with the reason
 * and the moment it lapses, so the client can show a ban as a countdown rather
 * than an unexplained failure.
 */
function requireUnbanned(who) {
  if (!who?.ban) return null;
  return fail(403, 'banned', {
    reason: who.ban.reason || '',
    until: who.ban.until_at,
  });
}

/**
 * The ban in force for whoever is making this write to a post they own.
 *
 * A post can be changed with the edit secret alone, without a session, so the
 * session is not always enough to name the account. Falling back to the post's
 * own owner closes that gap: otherwise a banned author could still edit, delete
 * and re-upload by dropping the session and keeping the secret, which would make
 * a ban a speed bump rather than a ban. Ownership is checked first by every
 * caller, so this only ever runs for the account that actually owns the post.
 */
async function banOnItemWriter(request, env, itemId) {
  const who = await identity(request, env);
  if (who) return who.ban || null;
  const ownerId = await env.STORE.ownerOfItem(itemId);
  return ownerId ? await env.STORE.activeBan(ownerId) : null;
}

/** The 403 body a banned writer is given, in the same shape everywhere. */
function bannedResponse(ban) {
  return fail(403, 'banned', { reason: ban?.reason || '', until: ban?.until_at });
}

/**
 * Full admin, or a moderator. `level` is 'admin' for the few things only the
 * operator may do (roles, blocked nicks, lifts) and 'moderator' for the ones a
 * helper may also do (bans and post removal).
 */
async function requireRole(request, env, level = 'moderator') {
  const who = await identity(request, env);
  if (!who) return { error: fail(401, 'sign in required') };
  const admin = adminOf(env, who.user.id);
  if (admin) return { who, admin: true };
  if (level === 'moderator' && (await env.STORE.roleOf(who.user.id)) === 'moderator') {
    return { who, admin: false };
  }
  return { error: fail(403, 'not allowed') };
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
      accessKeyMax: c.accessKeyMax,
      keyHintMax: c.keyHintMax,
    },
    // Which store accepted the advertised maxFileBytes. The site reads this to
    // stop telling an author a 50 MB archive is fine while the Worker is still on
    // the KV fallback.
    storage: c.storage,
    auth: 'device',
    // The client renders limits from this rather than hard-coding them, so the
    // numbers here and the numbers the server enforces cannot drift apart.
    authModes: ['device', 'account'],
    // The browser has to solve a proof of work to register, so it needs the
    // difficulty. Sent here rather than hard-coded for the same reason.
    powBits: powBits(env),
    captchaRequired: QUOTA.anonymous.captchaOnPost,
    quota: {
      // Resolved through quotaFor so the env overrides the server enforces are
      // the ones the client is shown. `null` for Infinity: JSON has no
      // Infinity, and null reads as "no limit" without inventing a number.
      anonymous: { ...quotaFor(null, env), editsPerDay: QUOTA.anonymous.editsPerDay },
      registered: { ...quotaFor({ id: 'preview' }, env), editsPerDay: null },
    },
    plugins: env.PLUGINS.describe(),
  });
});

/**
 * Public counters. `?series=1` adds the daily visitor/registration series, which
 * is deliberately opt-in: it is a heavier read and the public page only needs
 * the totals.
 */
route('GET', /^\/api\/stats$/, async (request, env, _m, url) => {
  // This is the one endpoint every visitor hits, the public page calls it on
  // load. Counting the client here is what makes the "visitors" figure mean
  // people who came, rather than people who happened to publish - which is all
  // the other write paths would ever count.
  const client = clientOf(request);
  if (client) await env.STORE.touchClient(client);

  const stats = await env.STORE.stats();
  if (url?.searchParams?.get('series')) {
    stats.series = await env.STORE.dailySeries(Number(url.searchParams.get('series')) || 30);
  }
  return json(stats);
});

/* ----------------------------------------------------------------- games -- */

/**
 * Roblox game lookup, proxied.
 *
 * The publish form takes a Roblox place or universe id and needs the name, the
 * group/creator name and an icon to draw on the chip. The browser cannot do that
 * itself for two reasons: Roblox's APIs send no CORS headers, so a direct fetch
 * fails before the response is readable, and doing it client-side would hand
 * every reader's IP to Roblox from a page they may never have wanted to contact.
 * Both go away by having the Worker do it once and hand back a small object.
 *
 * Results are cached because a game chip is read far more often than a game's
 * name changes, and because the endpoints are public but rate limited. A cold
 * miss is what the two upstream calls below cost; a hit is one KV read.
 */
const GAME_LOOKUP_TTL = 60 * 60 * 24; // a day
const ROBLOX_TIMEOUT_MS = 4000;

/**
 * One upstream call with a hard deadline. Without it a slow or hanging Roblox
 * endpoint would hold the Worker's request open until the platform gave up,
 * which turns a third-party outage into a publish form that never responds.
 *
 * The deadline is env-tunable only so the test can prove the timeout exists
 * without waiting four real seconds for it; production has no reason to set it.
 */
async function robloxGet(env, url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(Number(env.ROBLOX_TIMEOUT_MS) || ROBLOX_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`roblox ${res.status}`);
  return res.json();
}

route('GET', /^\/api\/games\/roblox\/(\d{1,20})$/, async (request, env, m) => {
  const id = m[1];
  const client = clientOf(request) || 'anon';
  // Cached per id, so this throttle only bites a script looping over ids.
  if (!(await env.STORE.throttle(client, 'game-lookup', { cap: 30, windowMs: 60_000 }))) {
    return fail(429, 'slow down');
  }

  const cacheKey = `game:roblox:${id}`;
  const cached = await env.BLOBS.kvGet(cacheKey);
  if (cached) return json({ ...JSON.parse(cached), cached: true });

  // A Roblox id is ambiguous by nature - the same number is usually a valid
  // universe id and a valid place id - so both are tried, universe first. The
  // universe endpoint is the one a game link actually carries, and a hit there
  // means the number is a real universe rather than a collision.
  const universe = await resolveRobloxUniverse(env, id);
  if (!universe) return fail(404, 'игра с таким id не найдена');

  const [details, icon] = await Promise.all([
    robloxGet(env, `https://games.roblox.com/v1/games?universeIds=${universe}`)
      .then((d) => d?.data?.[0] || null)
      .catch(() => null),
    robloxGet(env, `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universe}&size=512x512&format=Png&isCircular=false`)
      .then((d) => d?.data?.[0]?.imageUrl || '')
      .catch(() => ''),
  ]);
  // A game with a name but no icon is still worth a chip; only a nameless one
  // is not a game, so the name is the field that decides success here.
  if (!details?.name) return fail(404, 'игра с таким id не найдена');

  const game = {
    gameId: String(universe),
    gameName: String(details.name).slice(0, 120),
    gameAuthor: String(details.creator?.name || details.creator?.userName || '').slice(0, 80),
    gameCover: icon || '',
  };
  await env.BLOBS.kvPut(cacheKey, JSON.stringify(game), GAME_LOOKUP_TTL);
  return json({ ...game, cached: false });
});

/**
 * Place id -> universe id. Already an id, already unique, so this is the cheap
 * and reliable direction; a failure here just means the caller gave a universe
 * id to begin with and the next step resolves it.
 */
async function resolveRobloxUniverse(env, id) {
  try {
    const r = await robloxGet(env, `https://apis.roblox.com/universes/v1/places/${id}/universe`);
    if (Number.isSafeInteger(r?.universeId)) return r.universeId;
  } catch { /* not a place id - fall through */ }
  return Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : 0;
}

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
  // The operator's own block list, on top of the built-in weak-nick floor in
  // accounts.js. Checked against the folded key, so blocking one casing blocks
  // all of them. Existing accounts are deliberately not affected - see the note
  // on the admin route: a blocked nick stops new registrations, and an account
  // that already holds it is handled by a ban if that is what is wanted.
  if (await STORE.nickBlocked(key)) return fail(403, 'that nick is not available');
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

  return json({ user: publicUser(row, env), token, expiresAt: now() + SESSION_TTL_MS }, 201);
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

  return json({ user: publicUser(row, env), token, expiresAt: now() + SESSION_TTL_MS });
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
    user: publicUser(id.user, env),
    quota: { ...q, storageBytes: q.storageBytes, storageUsed: used, storageLeft: Math.max(0, q.storageBytes - used) },
  });
});

route('PATCH', /^\/api\/auth\/me$/, async (request, env) => {
  const id = await identity(request, env);
  if (!id) return fail(401, 'login required');
  const banned = requireUnbanned(id);
  if (banned) return banned;
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
    // Someone cannot rename themselves onto a nick the operator has blocked,
    // which would be a way around blocking it at registration.
    if (await env.STORE.nickBlocked(key)) return fail(403, 'that nick is not available');
    const clash = await env.STORE.getUserByNickKey(key);
    if (clash && clash.id !== id.user.id) return fail(409, 'that nick is already taken');
    patch.nick = nick;
    patch.nick_key = key;
  }

  if (typeof payload.bio === 'string') patch.bio = str(payload.bio, 200);

  // Profile design. Each field is sanitised to a value the browser can render
  // but cannot be abused with: logo must be an https image URL, accent a #hex
  // colour, bg a plain CSS value (gradients allowed, url() not). An invalid
  // value clears the field rather than failing the whole request, so a stale
  // client cannot get locked out of editing its bio.
  if (typeof payload.logo === 'string') patch.logo = sanitizeLogo(payload.logo);
  if (typeof payload.accent === 'string') patch.accent = sanitizeAccent(payload.accent);
  if (typeof payload.bg === 'string') patch.bg = sanitizeBg(payload.bg);

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
    return json({ user: publicUser(row, env), token, reauth: true });
  }

  return json({ user: publicUser(row, env) });
});

/* --------------------------------------------------------------- avatars --
 * An avatar is uploaded from the user's own device, resized in the browser
 * before it ever leaves the page, and stored in KV under a server-minted id.
 * There is deliberately no "paste a link" path here: that exists separately as
 * `logo`, and keeping upload and URL apart means an avatar can never be a
 * tracking pixel on a third-party host.
 */

const AVATAR_MAX_BYTES = 512 * 1024;
// The browser is told to emit one of these; the server re-checks the declared
// type against this list rather than trusting the header, so a crafted upload
// cannot get `text/html` stored and later served as a same-origin document.
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

route('POST', /^\/api\/auth\/avatar$/, async (request, env) => {
  const who = await identity(request, env);
  if (!who) return fail(401, 'login required');
  const banned = requireUnbanned(who);
  if (banned) return banned;

  const client = clientOf(request) || 'anon';
  if (!(await env.STORE.throttle(client, 'avatar', { cap: 10, windowMs: 60 * 60 * 1000 }))) {
    return fail(429, 'too many avatar uploads, try later');
  }

  const declared = str(request.headers.get('content-type'), 80).split(';')[0].trim().toLowerCase();
  if (!AVATAR_TYPES.has(declared)) {
    return fail(415, 'avatar must be png, jpeg, webp or gif');
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > AVATAR_MAX_BYTES) return fail(413, 'avatar is too large', { maxBytes: AVATAR_MAX_BYTES });

  let buffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return fail(413, 'avatar is too large', { maxBytes: AVATAR_MAX_BYTES });
  }
  // A 0-byte or truncated upload is rejected here rather than stored: an avatar
  // that fails to decode is worse than no avatar at all.
  if (buffer.byteLength < 64) return fail(400, 'avatar is empty');
  if (buffer.byteLength > AVATAR_MAX_BYTES) return fail(413, 'avatar is too large', { maxBytes: AVATAR_MAX_BYTES });

  const id = newId(16);
  await env.BLOBS.putAvatar(id, buffer);
  const { user, previous } = await env.STORE.setAvatar(who.user.id, id, declared);
  // Replace, not accumulate: the old blob has no remaining referrer.
  if (previous && previous !== id) await env.BLOBS.removeAvatar(previous);

  return json({ user: publicUser(user, env), avatar: `/a/${id}`, size: buffer.byteLength });
});

route('DELETE', /^\/api\/auth\/avatar$/, async (request, env) => {
  const who = await identity(request, env);
  if (!who) return fail(401, 'login required');
  const banned = requireUnbanned(who);
  if (banned) return banned;

  const previous = who.user.avatar_id;
  const { user } = await env.STORE.setAvatar(who.user.id, '', '');
  if (previous) await env.BLOBS.removeAvatar(previous);
  return json({ user: publicUser(user, env) });
});

/**
 * Serves an avatar.
 *
 * Public and unguessable-id-gated: the id is 16 characters of a 32-symbol
 * alphabet, so it is not enumerable, and an avatar is not private data - it is
 * shown on a public profile. Cached hard because the id changes whenever the
 * picture does, which is exactly the invalidation rule a content-addressed URL
 * would give for free.
 */
route('GET', /^\/a\/([A-Za-z0-9]{16})$/, async (request, env, m) => {
  const row = await env.STORE.db
    .prepare('SELECT avatar_mime FROM user WHERE avatar_id = ?')
    .bind(m[1])
    .first();
  if (!row) return fail(404, 'not found');
  const found = await env.BLOBS.getAvatar(m[1]);
  if (!found) return fail(404, 'not found');
  const mime = AVATAR_TYPES.has(row.avatar_mime) ? row.avatar_mime : 'application/octet-stream';
  return new Response(found.body, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    },
  });
});

/* --------------------------------------------------------------- reports --
 * The report queue is the part of the operator's position that is actually
 * checkable. A disclaimer says "you agree to this"; a report channel with a
 * status column says "we were told, and here is what we did". Both are needed,
 * and this is the second one.
 */

const REPORT_REASONS = new Set([
  'spam', 'abuse', 'illegal', 'violence', 'porn', 'copyright',
  'impersonation', 'harassment', 'other',
]);

route('POST', /^\/api\/reports$/, async (request, env) => {
  const c = config(env);
  const client = clientOf(request);
  if (!client) return fail(401, 'missing client id');
  if (!(await env.STORE.throttle(client, 'report', { cap: 10, windowMs: 60 * 60 * 1000 }))) {
    return fail(429, 'too many reports, try later');
  }

  let payload;
  try {
    payload = await readJson(request, c.maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }

  const targetType = str(payload.targetType, 12);
  if (!['item', 'user', 'comment'].includes(targetType)) return fail(400, 'unknown target');
  const targetId = str(payload.targetId, 40);
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(targetId)) return fail(400, 'unknown target');

  const reason = str(payload.reason, 24);
  if (!REPORT_REASONS.has(reason)) return fail(400, 'pick a reason');

  // Reports are accepted without an account on purpose: the person who wants a
  // post taken down often has no reason to register first, and requiring
  // registration to complain is the fastest way to guarantee no complaints.
  // The trade is spam, which the throttle above bounds.
  const who = await identity(request, env);

  const id = newId(12);
  const made = await env.STORE.createReport({
    id,
    targetType,
    targetId,
    reason,
    details: str(payload.details, 1000),
    byUserId: who?.user.id || '',
    byClient: client,
  });
  return json({ id: made.id, status: made.status, ok: true }, 201);
});

/* ----------------------------------------------------------------- admin --
 * Two levels, and the split is about blast radius rather than trust:
 *
 *   moderator - delete a post, ban an account for up to 7 days, resolve a
 *               report, mark a popular author. Cannot change roles, cannot edit
 *               the blocked-nick list, and cannot lift a ban.
 *   admin     - everything above, plus roles, nicks and unlimited bans.
 *
 * A moderator can still hurt an admin, so the one rule that is never relaxed is
 * that nobody but an admin may act on an account that is a full admin.
 */

const MOD_BAN_MAX = 7 * 24 * 60 * 60 * 1000;

/**
 * One report, as the console reads it.
 *
 * Both the overview counter and the queue render these rows, and the view layer
 * speaks camelCase. Returning the raw table row from one route and a mapped row
 * from the other is how the queue ends up with an undefined target and no
 * takedown button, so the shape is defined once, here.
 */
function reportView(r) {
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    details: r.details || '',
    status: r.status,
    // Empty rather than null for a complaint filed without an account, which is
    // the normal case: the reporter is anonymous by design.
    byUserId: r.by_user_id || '',
    byClient: r.by_client || '',
    createdAt: r.created_at,
    resolvedAt: r.resolved_at || 0,
    resolvedBy: r.resolved_by || '',
  };
}

route('GET', /^\/api\/admin\/overview$/, async (request, env) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  return json({
    stats: await env.STORE.stats(),
    series: await env.STORE.dailySeries(30),
    role: gate.admin ? 'admin' : 'moderator',
    reports: (await env.STORE.listReports({ status: 'open', limit: 20 })).map(reportView),
  });
});

route('GET', /^\/api\/admin\/users$/, async (request, env, _m, url) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  const rows = await env.STORE.adminSearchUsers(url.searchParams.get('q') || '', 50);
  // One ban lookup per row rather than a join: a moderator's list is 50 rows
  // and a second query per row is cheaper than widening every public user read
  // to carry moderation state.
  const users = await Promise.all(rows.map(async (r) => {
    const ban = await env.STORE.activeBan(r.id);
    return { ...publicUser(r, env), banned: !!ban, banUntil: ban?.until_at || 0 };
  }));
  return json({ users });
});

route('POST', /^\/api\/admin\/users\/([A-Za-z0-9_-]{3,40})\/ban$/, async (request, env, m) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  const { STORE } = env;

  const target = await STORE.getUser(m[1]);
  if (!target) return fail(404, 'not found');
  if (adminOf(env, target.id)) return fail(403, 'cannot ban an administrator');

  let payload = {};
  try {
    payload = await readJson(request, 4096);
  } catch { /* an empty body means the default 24h */ }

  const reason = str(payload.reason, 200);
  // `hours: 0` means "until lifted": a distinct, deliberate case rather than a
  // ban that silently expires and then looks like a bug.
  const hours = clamp(Number(payload.hours ?? 24) || 0, 0, 24 * 365);
  const untilAt = hours === 0 ? now() + 10 * 365 * 86400000 : now() + hours * 3600_000;
  if (!gate.admin && untilAt > now() + MOD_BAN_MAX) {
    return fail(403, 'moderators can ban for at most 7 days');
  }

  const ban = await STORE.createBan({
    id: newId(12), userId: target.id, untilAt, reason, byUserId: gate.who.user.id,
  });
  return json(
    { ok: true, user: publicUser(target, env), ban: { until: ban.until_at, reason: ban.reason } },
    201,
  );
});

route('DELETE', /^\/api\/admin\/users\/([A-Za-z0-9_-]{3,40})\/ban$/, async (request, env, m) => {
  const gate = await requireRole(request, env, 'admin');
  if (gate.error) return gate.error;
  return json({ ok: true, lifted: await env.STORE.liftBans(m[1], gate.who.user.id) });
});

route('POST', /^\/api\/admin\/users\/([A-Za-z0-9_-]{3,40})\/role$/, async (request, env, m) => {
  const gate = await requireRole(request, env, 'admin');
  if (gate.error) return gate.error;
  let payload = {};
  try {
    payload = await readJson(request, 1024);
  } catch { /* an empty body means "drop back to user" */ }
  const row = await env.STORE.setRole(m[1], str(payload.role, 20));
  return json({ ok: true, user: publicUser(row, env) });
});

route('POST', /^\/api\/admin\/users\/([A-Za-z0-9_-]{3,40})\/popular$/, async (request, env, m) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  let payload = {};
  try {
    payload = await readJson(request, 1024);
  } catch { /* absent means "off" */ }
  const row = await env.STORE.setPopular(m[1], payload.popular === true);
  return json({ ok: true, user: publicUser(row, env) });
});

route('GET', /^\/api\/admin\/nicks$/, async (request, env) => {
  const gate = await requireRole(request, env, 'admin');
  if (gate.error) return gate.error;
  return json({ blocked: await env.STORE.listNickBlocks() });
});

route('POST', /^\/api\/admin\/nicks$/, async (request, env) => {
  const gate = await requireRole(request, env, 'admin');
  if (gate.error) return gate.error;
  let payload;
  try {
    payload = await readJson(request, 2048);
  } catch {
    return fail(400, 'bad request');
  }
  const nick = str(payload.nick, 24);
  if (!nick) return fail(400, 'nick is required');
  const entry = await env.STORE.blockNick({
    nickKey: nickKey(nick), nick, reason: str(payload.reason, 200), byUserId: gate.who.user.id,
  });
  return json({ ok: true, blocked: entry }, 201);
});

route('DELETE', /^\/api\/admin\/nicks\/([A-Za-z0-9_-]{3,32})$/, async (request, env, m) => {
  const gate = await requireRole(request, env, 'admin');
  if (gate.error) return gate.error;
  return json({ ok: true, removed: await env.STORE.unblockNick(m[1]) });
});

route('GET', /^\/api\/admin\/reports$/, async (request, env, _m, url) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  const status = url.searchParams.get('status');
  return json({ reports: (await env.STORE.listReports({ status: status || null, limit: 100 })).map(reportView) });
});

route('POST', /^\/api\/admin\/reports\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  let payload = {};
  try {
    payload = await readJson(request, 1024);
  } catch { /* absent means "resolved" */ }
  const status = str(payload.status, 20);
  if (!['resolved', 'dismissed', 'open'].includes(status)) return fail(400, 'unknown status');

  // The row is read first: the takedown below acts on what the complaint was
  // about, and that is only knowable from the report itself.
  const report = await env.STORE.getReport(m[1]);
  if (!report) return fail(404, 'not found');
  const done = await env.STORE.resolveReport({ id: m[1], status, byUserId: gate.who.user.id });
  if (!done) return fail(404, 'not found');

  // Upholding a complaint takes the content down, because the button that got
  // here says "Снять" and the operator is promising the complainer it is gone.
  // A complaint about an account is answered differently: that is a ban, and it
  // is made from the account queue with a term and a reason, not by deleting
  // somebody because someone wrote a complaint.
  let removed = null;
  if (status === 'resolved') {
    if (report.target_type === 'item') {
      removed = (await removeItemEverywhere(env, report.target_id, ctxOf(request, env))) ? 'item' : null;
    } else if (report.target_type === 'comment') {
      removed = (await env.STORE.deleteComment(report.target_id)) ? 'comment' : null;
    }
  }
  return json({ ok: true, removed, targetType: report.target_type, removedBy: gate.who.user.id });
});

/** The moderation queue: recent posts from every author, newest first. */
route('GET', /^\/api\/admin\/items$/, async (request, env, _m, url) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  const rows = await env.STORE.listRecentItems(clamp(Number(url.searchParams.get('limit')) || 50, 1, 200));
  return json({ items: await Promise.all(rows.map((row) => itemView(env.STORE, row))) });
});

/**
 * Removes any post without the edit secret. The secret check in the ordinary
 * DELETE route is untouched, so this is an addition to the ownership rule rather
 * than a replacement of it: the author still needs their secret, staff do not.
 */
/**
 * Removes a post and everything hanging off it: its files, any blob no other
 * post still points at, and the plugin hook. Shared by the moderation queue and
 * the report queue so that "снять" means the same thing wherever it is clicked;
 * a takedown that left a file in KV would leak storage and keep serving the
 * attachment at /f/<sha> long after the post is gone.
 *
 * `ctx` is the plugin context of whoever triggered it, so the hook still records
 * the actor rather than an anonymous takedown.
 */
async function removeItemEverywhere(env, id, ctx) {
  const { STORE, BLOBS } = env;
  const row = await STORE.getItem(id);
  if (!row) return false;
  const before = await itemView(STORE, row);
  for (const f of await STORE.listFiles(id)) {
    await STORE.deleteFile(f.id);
    if ((await STORE.otherRefsToSha(f.sha256, f.id)) === 0) await BLOBS.remove(f.sha256, f.store, f.rid, f.url, f.mime);
  }
  await STORE.deleteItem(id);
  await env.PLUGINS.run('item:delete', before, ctx);
  return true;
}

route('DELETE', /^\/api\/admin\/items\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const gate = await requireRole(request, env, 'moderator');
  if (gate.error) return gate.error;
  const removed = await removeItemEverywhere(env, m[1], ctxOf(request, env));
  if (!removed) return fail(404, 'not found');
  return json({ ok: true, removedBy: gate.who.user.id, moderator: !gate.admin });
});

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
  return json({ users: rows.map((u) => publicUser(u, env)) });
});

route('GET', /^\/api\/users\/([A-Za-z0-9_-]{3,32})$/, async (request, env, m, url) => {
  const viewer = await identity(request, env);
  const row = await env.STORE.getUser(m[1]);
  if (!row) return fail(404, 'no such user');
  const items = await env.STORE.itemsOfUser(row.id, { limit: 20 });
  // Same rule as the feed: a locked item shows its card, not its contents.
  const views = await Promise.all(items.map(async (it) => itemView(env.STORE, it, {
    unlocked: await isUnlocked(it, request, url), ownerId: row.id,
  })));
  return json({
    user: publicUser(row, env),
    isFollowing: await env.STORE.isFollowing(viewer?.user.id, row.id),
    items: views,
  });
});

route('GET', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/followers$/, async (request, env, m) => {
  const rows = await env.STORE.followersOf(m[1], { limit: 100 });
  return json({ users: rows.map((u) => publicUser(u, env)) });
});

route('GET', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/following$/, async (request, env, m) => {
  const rows = await env.STORE.followingOf(m[1], { limit: 100 });
  return json({ users: rows.map((u) => publicUser(u, env)) });
});

/**
 * Follow. Requires an account, per the product rule that anonymous visitors
 * cannot add friends. The PoW gate is skipped for registered users because
 * their cost is already bounded by the registration hash.
 */
route('POST', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/follow$/, async (request, env, m) => {
  const id = await identity(request, env);
    if (!id) return fail(401, 'login required to add friends');
    const bannedFollow = requireUnbanned(id);
    if (bannedFollow) return bannedFollow;
    const target = await env.STORE.getUser(m[1]);
  if (!target) return fail(404, 'no such user');

  const r = await env.STORE.followUser(id.user.id, target.id);
  const fresh = await env.STORE.getUser(target.id);
  return json({ ok: r.ok, following: true, reason: r.reason, user: publicUser(fresh, env) }, r.reason === 'self' ? 400 : 200);
});

route('DELETE', /^\/api\/users\/([A-Za-z0-9_-]{3,32})\/follow$/, async (request, env, m) => {
  const id = await identity(request, env);
    if (!id) return fail(401, 'login required');
    const bannedUnfollow = requireUnbanned(id);
    if (bannedUnfollow) return bannedUnfollow;
    const target = await env.STORE.getUser(m[1]);
    if (!target) return fail(404, 'no such user');
    await env.STORE.unfollowUser(id.user.id, target.id);
  const fresh = await env.STORE.getUser(target.id);
  return json({ ok: true, following: false, user: publicUser(fresh, env) });
});

/** Like is a toggle: POST likes, DELETE unlikes, both idempotent. */
route('POST', /^\/api\/items\/([A-Za-z0-9]{4,16})\/like$/, async (request, env, m) => {
  const id = await identity(request, env);
    if (!id) return fail(401, 'login required');
    const bannedLike = requireUnbanned(id);
    if (bannedLike) return bannedLike;
    const item = await env.STORE.getItem(m[1]);
    if (!item) return fail(404, 'not found');
    await env.STORE.likeItem(item.id, id.user.id);
  const fresh = await env.STORE.getItem(item.id);
  return json({ liked: true, likes: fresh.likes || 0 });
});

route('DELETE', /^\/api\/items\/([A-Za-z0-9]{4,16})\/like$/, async (request, env, m) => {
  const id = await identity(request, env);
    if (!id) return fail(401, 'login required');
    const bannedUnlike = requireUnbanned(id);
    if (bannedUnlike) return bannedUnlike;
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
      // Same two fields the post carries, so a comment author's mark matches
      // the one on their publications.
      popular: !!r.popular,
      avatar: r.avatar_id ? `/a/${r.avatar_id}` : '',
    })),
  });
});

route('POST', /^\/api\/items\/([A-Za-z0-9]{4,16})\/comments$/, async (request, env, m) => {
  const id = await identity(request, env);
    if (!id) return fail(401, 'login required to comment');
    const bannedComment = requireUnbanned(id);
    if (bannedComment) return bannedComment;
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
    const bannedCommentDelete = requireUnbanned(id);
    if (bannedCommentDelete) return bannedCommentDelete;
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
  // The author's own client id is the item author, so these are their items and
  // locked ones stay readable here.
  const items = await Promise.all(mine.items.map((row) => itemView(STORE, row, { unlocked: true })));
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
  // A game's own page. Only the id is taken from the query - the name and the
  // cover are read back off the stored item, so a link cannot rename a game.
  //
  // A game id that is present but not a number is refused rather than ignored.
  // Dropping the filter would answer "everything" to a request that asked about
  // one game, and the caller has no way to tell that from a game that simply has
  // no posts. An empty or blank value still means "no game filter", because a
  // stray `&game=` should not empty out an otherwise ordinary feed.
  const game = str(q.get('game'), 40);
  if (game && !/^\d{1,20}$/.test(game)) return fail(400, 'game id must be numeric');
  const { items, total } = await STORE.listItems({
    type,
    q: str(q.get('q'), 80),
    tag: str(q.get('tag'), 24).toLowerCase(),
    author: str(q.get('author'), 64),
    game,
    sort: ['new', 'hot', 'old'].includes(q.get('sort')) ? q.get('sort') : 'new',
    limit: clamp(Number(q.get('limit')) || 30, 1, 60),
    offset: Math.max(0, Number(q.get('offset')) || 0),
  });
  // A locked item is listed by its shell only. Without this check the feed would
  // hand out the body and preview of every locked item, which is the whole point
  // of the lock.
  const views = await Promise.all(items.map(async (row) => itemView(STORE, row, {
    unlocked: await isUnlocked(row, request, url),
  })));
  return json({ total, items: views });
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
    const bannedPost = who ? requireUnbanned(who) : null;
    if (bannedPost) return bannedPost;
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
    ...gameFields(payload),
  };

  const { value, rejections } = await env.PLUGINS.run('item:create', draft, ctxOf(request, env));
  if (rejections.length) return fail(422, 'rejected', { reasons: rejections });

  const secret = newSecret();
  const t = now();
  const accessKey = str(payload.accessKey, c.accessKeyMax);
  const row = await STORE.createItem({
    id: newId(8),
    ...value,
    tags: value.tags.join(' '),
    author: id,
    author_label: str(payload.authorLabel, c.labelMax),
    secret_hash: await secretHash(secret),
    // Only the hash is stored, and the plaintext is returned once, here - the
    // same rule as the edit secret. A key cannot be recovered later, so the
    // author is told to keep it and can always set another one.
    access_key_hash: accessKey ? await secretHash(accessKey) : null,
    key_hint: accessKey ? str(payload.keyHint, c.keyHintMax) : '',
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
  return json({ item: view, secret, accessKey: accessKey || null, registered: !!who }, 201);
});

/**
 * Item detail. Answers the viewer's like state and the owner's follow state so
 * the page can render both buttons without a second round trip, and counts the
 * view once per client id.
 *
 * A locked item without its key still returns 200 with the shell and
 * `locked: true` - not 403 - so the page can show the lock screen, the hint and
 * the author's follow button instead of an error.
 */
route('GET', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (request, env, m, url) => {
  const { STORE } = env;
  const row = await STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  const viewer = await identity(request, env);
  const open = await isUnlocked(row, request, url);
  await STORE.incItemHits(m[1], clientOf(request), { viewerUserId: viewer?.user.id });
  const fresh = await STORE.getItem(m[1]);
  const view = await itemView(STORE, fresh, { full: true, unlocked: open });
  const uid = viewer?.user.id;
  return json({
    item: view,
    liked: uid ? await STORE.hasLiked(fresh.id, uid) : false,
    isFollowing: uid && view?.ownerId && view.ownerId !== uid
      ? await STORE.isFollowing(uid, view.ownerId)
      : false,
  });
});

/**
 * Tries an access key against a locked item. Separate from the detail route so a
 * wrong guess costs one keyed hash rather than a full item assembly, and so the
 * client gets one unambiguous yes/no to render.
 */
route('POST', /^\/api\/items\/([A-Za-z0-9]{4,16})\/unlock$/, async (request, env, m) => {
  const { STORE } = env;
  const c = config(env);
  const row = await STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  if (!row.access_key_hash) return json({ ok: true, unlocked: true });

  const client = clientOf(request) || 'anon';
  if (!(await STORE.throttle(`unlock:${client}`, 'write', { cap: 10, windowMs: 60_000 }))) {
    return fail(429, 'too many attempts, try later');
  }

  let payload = {};
  try {
    payload = await readJson(request, 4096);
  } catch {
    payload = {};
  }
  const key = str(payload.key, c.accessKeyMax) || keyOf(request);
  if (!key) return fail(400, 'key is required');
  if (!(await secretMatches(key, row.access_key_hash))) return fail(403, 'wrong key');
  return json({ ok: true, unlocked: true });
});

route('PATCH', /^\/api\/items\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const { STORE } = env;
  const c = config(env);
  const row = await STORE.getItem(m[1]);
    if (!row) return fail(404, 'not found');
    if (!(await ownSecret(request, row))) return fail(403, 'edit secret required');
    const ban = await banOnItemWriter(request, env, m[1]);
    if (ban) return bannedResponse(ban);
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
  // Game fields are written whole, never merged, so clearing the chip in the
  // editor clears the row too instead of leaving the old game's name behind.
  if (payload.gameId !== undefined || payload.keySystem !== undefined) {
    for (const k of ['game_id', 'game_name', 'game_author', 'game_cover', 'key_system']) patch[k] = '';
    Object.assign(patch, gameFields(payload));
  }

  // An empty accessKey removes the lock, a new one replaces it. The previous key
  // is not readable, so this is the only way to change it - which is why the
  // editor says so next to the field.
  if (payload.accessKey !== undefined) {
    const accessKey = str(payload.accessKey, c.accessKeyMax);
    patch.access_key_hash = accessKey ? await secretHash(accessKey) : null;
    if (!accessKey) patch.key_hint = '';
  }
  if (payload.keyHint !== undefined) patch.key_hint = str(payload.keyHint, c.keyHintMax);

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
  const ban = await banOnItemWriter(request, env, m[1]);
  if (ban) return bannedResponse(ban);

  // snapshot before the files are gone, so the plugin still sees the full item
  const before = await itemView(STORE, row);

  for (const f of await STORE.listFiles(m[1])) {
    await STORE.deleteFile(f.id);
    if ((await STORE.otherRefsToSha(f.sha256, f.id)) === 0) await BLOBS.remove(f.sha256, f.store, f.rid, f.url, f.mime);
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
    const ban = await banOnItemWriter(request, env, m[1]);
    if (ban) return bannedResponse(ban);
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
  const stored = await BLOBS.put(buffer, sha, { mime: mimeOf(value.name), name: value.name });
  Object.assign(value, {
    size: stored.size, sha256: sha, mime: mimeOf(value.name),
    store: stored.store, url: stored.url, rid: stored.rid,
  });
  const saved = await STORE.addFile(value);

  const after = await env.PLUGINS.run('file:stored', saved, ctxOf(request, env));
  if (after.rejections.length) {
    await STORE.deleteFile(saved.id);
    if ((await STORE.otherRefsToSha(saved.sha256, saved.id)) === 0) {
      await BLOBS.remove(saved.sha256, saved.store, saved.rid, saved.url, saved.mime);
    }
    return fail(422, 'rejected', { reasons: after.rejections });
  }

  await STORE.updateItem(m[1], { updated_at: now() });
  return json({ file: fileView(saved) }, 201);
});

route('DELETE', /^\/api\/files\/([A-Za-z0-9]{4,16})$/, async (request, env, m) => {
  const { STORE, BLOBS } = env;
  const file = await STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  const row = await STORE.getItem(file.itemId);
  if (!row) return fail(404, 'not found');
    if (!(await ownSecret(request, row))) return fail(403, 'edit secret required');
    const ban = await banOnItemWriter(request, env, file.itemId);
    if (ban) return bannedResponse(ban);
  
     await STORE.deleteFile(m[1]);
  if ((await STORE.otherRefsToSha(file.sha256, m[1])) === 0) await BLOBS.remove(file.sha256, file.store, file.rid, file.url, file.mime);
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

  // Bytes that live on Cloudinary are served by its CDN. A redirect instead of
  // a copy: the Worker would otherwise pull 50 MB into its heap only to push it
  // straight back out, and the client would pay for the egress twice. The gate
  // above has already run, so an unlisted post's attachment still only resolves
  // for someone who passed the secret or the access key.
  if (file.store === 'cloudinary' && file.url) {
    const target = render ? previewUrl(file.url) : file.url;
    return new Response(null, {
      status: 302,
      headers: { Location: target, 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
    });
  }

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
      const object = await env.BLOBS.get(file.sha256, { range: { offset: start, length: end - start + 1 }, store: file.store });
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

  const object = await env.BLOBS.get(file.sha256, { store: file.store });
  if (!object) return fail(404, 'file content missing');
  return new Response(object.body, { status: 200, headers: { ...headers, 'Content-Length': String(file.size) } });
}

route('GET', /^\/f\/([A-Za-z0-9]{4,16})$/, async (request, env, m, url) => {
  const file = await env.STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  const locked = await lockedGate(request, env, file.itemId, url);
  if (locked) return locked;
  return serveFile(request, env, file, { inline: false });
});

route('GET', /^\/f\/([A-Za-z0-9]{4,16})\/raw$/, async (request, env, m, url) => {
  const file = await env.STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  const locked = await lockedGate(request, env, file.itemId, url);
  if (locked) return locked;
  return serveFile(request, env, file, { inline: true });
});

/** Media needs a renderable Content-Type, so raw media is served apart from text. */
route('GET', /^\/m\/([A-Za-z0-9]{4,16})$/, async (request, env, m, url) => {
  const file = await env.STORE.getFile(m[1]);
  if (!file) return fail(404, 'not found');
  const locked = await lockedGate(request, env, file.itemId, url);
  if (locked) return locked;
  const etag = `"${file.sha256}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  await env.STORE.incFileDownloads(file.id);
  // A CDN file has no bytes for the Worker to copy and no reason to: the preview
  // rendition is on the CDN too, and it is the one the gallery should show.
  if (file.store === 'cloudinary' && file.url) {
    return new Response(null, {
      status: 302,
      headers: { Location: previewUrl(file.url), 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
    });
  }
  const range = request.headers.get('range');
  if (range) return serveFile(request, env, file, { inline: true, render: true });
  const object = await env.BLOBS.get(file.sha256, { store: file.store });
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

route('GET', /^\/r\/([A-Za-z0-9]{4,16})$/, async (request, env, m, url) => {
  const row = await env.STORE.getItem(m[1]);
  if (!row) return fail(404, 'not found');
  if (!(await isUnlocked(row, request, url))) return fail(403, 'key required');
  const viewer = await identity(request, env);
  await env.STORE.incItemHits(m[1], clientOf(request), { viewerUserId: viewer?.user.id });
  return new Response(row.body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
});

/* ------------------------------------------------------------------ chats */

/**
 * Every chat route resolves the viewer, the conversation and their rights before
 * anything else. `openRoom` is the single gate: a route that forgets to call it
 * does not get access, it gets nothing at all, because the room row it needs is
 * only reachable through this helper.
 */
async function openRoom(request, env, convKey) {
  const who = await identity(request, env);
  if (!who) return { error: fail(401, 'login required') };
  const chats = env.CHATS || (env.CHATS = new ChatStore(env));
  const conv = await chats.getConversation(convKey);
  if (!conv) return { error: fail(404, 'no such conversation') };
  const member = await chats.getMember(conv.id, who.user.id);
  // A mute hides the badge but not the room; a kick removes the room. Both are
  // per-conversation, so nothing here reaches the account as a whole.
  //
  // The kick is checked before the rights, because being removed deletes the
  // membership row, and the rights of "not a member of a private room" and "was
  // removed from this room" are the same 403. Ordered the other way, the person
  // who was kicked gets the anonymous stranger's message and never learns why.
  if ((await chats.sanctionOf(conv.id, who.user.id)) === 'kick') {
    return { error: fail(403, 'you were removed from this conversation') };
  }
  const rights = rightsFor(conv, member);
  if (!rights.read) return { error: fail(403, 'no access to this conversation') };
  return { who, chats, conv, member, rights };
}

/** A conversation as the client sees it. Ids of hidden rooms are not exposed. */
function convView(row, rights, member) {
  return {
    id: row.id,
    kind: row.kind,
    // A dm borrows the other person's name. It is only ever shown to a member of
    // it, and it is the only way a person could tell two dms apart.
    title: row.kind === 'dm' ? (row.peer_nick || row.title || 'Личный чат') : row.title,
    peerId: row.kind === 'dm' ? (row.peer_id ?? undefined) : undefined,
    topic: row.topic,
    discoverable: !!row.discoverable,
    members: row.members ?? undefined,
    messages: row.messages ?? undefined,
    lastAt: row.last_at ?? undefined,
    unread: row.unread ?? 0,
    muted: !!(member && row.muted),
    role: member?.role || null,
    // Everything the client needs to decide what to draw, and nothing more: a
    // stranger to a private room learns nothing from these flags.
    rights: rights ? {
      canPost: rights.post, canManage: rights.manage, canInvite: rights.invite, canLeave: rights.leave,
    } : undefined,
  };
}

/** A message as the client sees it, with its attachments and author. */
function messageView(row, files = []) {
  return {
    id: row.id,
    convId: row.conv_id,
    userId: row.user_id,
    nick: row.nick,
    popular: row.popular,
    avatarId: row.avatar_id,
    body: row.deleted_at ? '' : row.body,
    createdAt: row.created_at,
    deleted: !!row.deleted_at,
    game: row.game_id ? { id: row.game_id, name: row.game_name, cover: row.game_cover } : null,
    files: files.filter((f) => f.message_id === row.id).map((f) => ({
      id: f.id, name: f.name, mime: f.mime, size: f.size, url: f.url, store: f.store,
    })),
  };
}

/**
 * The Durable Object for one conversation, or null when no namespace is bound.
 *
 * Returning null rather than throwing is deliberate: it keeps the whole feature
 * working as plain HTTP when the binding is absent, which is exactly the
 * situation in the test harness and in any local `wrangler dev` started before
 * the binding was added. Live delivery is the enhancement; the message is never
 * dependent on it.
 */
function roomStub(env, convId) {
  return env.CHAT_ROOMS ? env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(roomNameFor(convId))) : null;
}

/** Opens (or creates) the direct conversation with another account. */
async function openDm(env, a, b) {
  const chats = env.CHATS || (env.CHATS = new ChatStore(env));
  const found = await chats.findDm(a, b);
  if (found) return found;
  const conv = await chats.createConversation({
    kind: 'dm', owner: a, discoverable: false, at: now(),
  });
  await chats.addMember(conv.id, b, 'member', now());
  await chats.linkDm(a, b, conv.id);
  return conv;
}

/** The viewer's conversations, for the sidebar. */
route('GET', /^\/api\/chats$/, async (request, env) => {
  const who = await identity(request, env);
  if (!who) return fail(401, 'login required');
  const chats = new ChatStore(env);
  const rows = await chats.listForUser(who.user.id);
  return json({
    chats: rows.map((r) => {
      const rights = rightsFor(r, { role: r.role });
      return convView(r, rights, { role: r.role, muted: r.muted });
    }),
  });
});

/**
 * Opens the direct conversation with another account.
 *
 * Both sides must already follow each other. That is the whole privacy model of a
 * dm here: the site has no separate "message me" button, and a message button on
 * every profile would let anybody start a private room with a stranger. Mutual
 * follows are the one thing two people have agreed to in public, so they are what
 * is asked for.
 */
route('POST', /^\/api\/chats\/dm\/([A-Za-z0-9_-]{3,40})$/, async (request, env, m) => {
  const who = await identity(request, env);
  if (!who) return fail(401, 'login required');
  const banned = requireUnbanned(who);
  if (banned) return banned;

  const target = m[1];
  if (target === who.user.id) return fail(400, 'you cannot message yourself');
  const other = await env.STORE.getUser(target);
  if (!other) return fail(404, 'no such account');
  if (!(await env.STORE.isFollowing(who.user.id, target))) {
    return fail(403, 'follow them first');
  }
  if (!(await env.STORE.isFollowing(target, who.user.id))) {
    return fail(403, 'they do not follow you yet');
  }

  const client = clientOf(request);
  if (!(await env.STORE.throttle(`chat-dm:${who.user.id}`, 'write', { cap: 60, windowMs: 60 * 60 * 1000 }))) {
    return fail(429, 'too many new conversations, try later');
  }

  const conv = await openDm(env, who.user.id, target);
  const chats = env.CHATS;
  return json({
    chat: convView(await chats.getConversationFor(conv.id, who.user.id), rightsFor({ kind: 'dm' }, { role: 'member' }), { role: 'member' }),
  });
});

/** Public channels, for the browse list. */
route('GET', /^\/api\/chats\/channels$/, async (request, env, _m, url) => {
  const chats = new ChatStore(env);
  const rows = await chats.listChannels({
    limit: clamp(Number(url.searchParams.get('limit')) || 30, 1, 50),
    offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
  });
  // Browsing is public, but the rights attached to each row are not: an owner and
  // a stranger reading the same list have to get different answers, or the list
  // tells the owner they cannot post in their own channel.
  const who = await identity(request, env);
  const views = [];
  for (const row of rows) {
    const member = who ? await chats.getMember(row.id, who.user.id) : null;
    views.push(convView(row, rightsFor(row, member), member));
  }
  return json({ channels: views });
});

/** Creates a channel or a group. Both need an account; a dm needs no setup. */
route('POST', /^\/api\/chats$/, async (request, env) => {
  const who = await identity(request, env);
  if (!who) return fail(401, 'login required to create a room');
  const banned = requireUnbanned(who);
  if (banned) return banned;
  const { STORE } = env;
  const client = clientOf(request);
  if (!(await STORE.throttle(`chat-create:${client || who.user.id}`, 'write', { cap: 10, windowMs: 60 * 60 * 1000 }))) {
    return fail(429, 'too many rooms created, try later');
  }

  let payload;
  try {
    payload = await readJson(request, config(env).maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }
  const kind = str(payload.kind, 10);
  if (kind !== 'channel' && kind !== 'group') return fail(400, 'kind must be channel or group');

  const title = str(payload.title, TITLE_MAX_CHAT);
  if (!title) return fail(400, 'title is required');
  const chats = new ChatStore(env);
  const conv = await chats.createConversation({
    kind,
    owner: who.user.id,
    title,
    topic: str(payload.topic, TOPIC_MAX_CHAT),
    // A group is private by definition; a channel is public unless asked otherwise.
    discoverable: kind === 'channel' ? payload.discoverable !== false : false,
    at: now(),
  });

  // Invited members arrive with the room. A missing invite list is not an error:
  // a person can make an empty room and fill it later.
  for (const raw of Array.isArray(payload.members) ? payload.members.slice(0, 40) : []) {
    const uid = str(raw, 40);
    if (uid && /^[A-Za-z0-9_-]{3,40}$/.test(uid) && uid !== who.user.id && (await STORE.getUser(uid))) {
      await chats.addMember(conv.id, uid, 'member', now());
    }
  }
  return json({ chat: convView(await chats.getConversation(conv.id), rightsFor({ kind }, { role: 'owner' }), { role: 'owner' }) }, 201);
});

/** One room: its metadata, its members and the newest page of messages. */
route('GET', /^\/api\/chats\/([A-Za-z0-9]{6,24})$/, async (request, env, m, url) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  const { chats, conv, rights } = room;

  const before = str(url.searchParams.get('before'), 24) || null;
  const limit = clamp(Number(url.searchParams.get('limit')) || 50, 1, 100);
  const rows = await chats.listMessages(conv.id, { limit, before });
  const files = rows.length ? await chats.listFilesForConversation(conv.id) : [];

  // Marking read is a side effect of looking, but only up to the oldest message
  // on screen, so a deep page does not silently swallow what arrived after it.
  const oldest = rows[rows.length - 1];
  if (oldest && room.member) await chats.markRead(conv.id, room.who.user.id, oldest.created_at);

  const view = convView({
    ...(await chats.getConversationFor(conv.id, room.who.user.id)),
    members: await chats.memberCount(conv.id),
  }, rights, room.member);

  return json({
    chat: view,
    // Newest first, so the client reverses once rather than guessing per page.
    messages: rows.map((r) => messageView(r, files)),
    hasMore: rows.length === limit,
  });
});

/**
 * Post a message.
 *
 * The body may be empty only when a file is coming: the message has to exist
 * before a file can hang off it, so a picture on its own is created first and
 * uploaded to afterwards. `attach: true` is that promise, and it is checked
 * rather than assumed - without it, an empty POST would be an empty row that
 * nobody can ever fill in, which is worse than a refusal.
 */
route('POST', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/messages$/, async (request, env, m) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  const { who, chats, conv, rights } = room;
  const banned = requireUnbanned(who);
  if (banned) return banned;
  if (!rights.post) return fail(403, 'you cannot post in this conversation');
  if ((await chats.sanctionOf(conv.id, who.user.id)) === 'mute') {
    return fail(403, 'you are muted in this conversation');
  }

  const { STORE } = env;
  const client = clientOf(request);
  if (!(await STORE.throttle(`chat-msg:${who.user.id}`, 'write', { cap: 40, windowMs: 60_000 }))) {
    return fail(429, 'slow down');
  }

  let payload;
  try {
    payload = await readJson(request, config(env).maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }
  const body = str(payload.body, MESSAGE_MAX);
  const game = messageGame(payload.game || {});
  const expectsFile = payload.attach === true;
  if (!body && !game && !expectsFile) return fail(400, 'message is empty');

  const message = await chats.addMessage({
    convId: conv.id, userId: who.user.id, body, game, at: now(),
  });
  // Read receipts move with the sender: you cannot be "unread" in a room where
  // you just spoke.
  await chats.markRead(conv.id, who.user.id, message.created_at);

  const view = messageView({
    ...message,
    nick: who.user.nick,
    popular: who.user.popular,
    avatar_id: who.user.avatar_id,
  }, []);

  // Stored first, then handed to the room. A room that is asleep or unreachable
  // costs the live feed, not the message: history over HTTP is authoritative.
  env.waitUntil?.(
    (async () => {
      const stub = roomStub(env, conv.id);
      if (!stub) return;
      await stub.fetch(`https://room.internal/publish?id=${conv.id}`, {
        method: 'POST',
        body: JSON.stringify(view),
      });
    })().catch(() => {}),
  );

  return json({ message: view }, 201);
});

/**
 * Attaches a file to a message that was just posted.
 *
 * The upload is a separate request rather than part of the message POST because
 * the message has to exist before a file can hang off it, and because a failed
 * upload must not cost the words that were typed next to it. A message may end
 * up with no file, which is fine; a file may never end up without a message.
 */
route('POST', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/messages\/([A-Za-z0-9]{6,24})\/files$/, async (request, env, m) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  const { chats, who } = room;
  const banned = requireUnbanned(who);
  if (banned) return banned;

  const message = await chats.getMessage(m[2]);
  if (!message || message.conv_id !== room.conv.id) return fail(404, 'no such message');
  // Only the author may attach to their own message, and only while it is the
  // newest one - otherwise a file could be added to history that has already been
  // read by everyone else.
  if (message.user_id !== who.user.id) return fail(403, 'you cannot attach to this message');
  const newest = (await chats.listMessages(room.conv.id, { limit: 1 }))[0];
  if (newest && newest.id !== message.id) return fail(409, 'that message is no longer the last one');

  const c = config(env);
  if ((await chats.listMessageFiles(message.id)).length >= 4) return fail(409, 'too many files on one message');
  const client = clientOf(request);
  if (!(await env.STORE.throttle(`chat-file:${who.user.id}`, 'write', { cap: 20, windowMs: 60 * 60 * 1000 }))) {
    return fail(429, 'slow down');
  }

  const name = safeFilename(decodeHeaderName(request.headers.get('x-filename')));
  const { value, rejections } = await env.PLUGINS.run('file:upload', {
    id: newId(10), name, mime: mimeOf(name), size: 0, sha256: '', author: client, created_at: now(),
  }, ctxOf(request, env));
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
  const stored = await env.BLOBS.put(buffer, sha, { mime: mimeOf(value.name), name: value.name });
  const saved = await chats.addMessageFile({
    id: newId(10),
    message_id: message.id,
    name: value.name,
    mime: mimeOf(value.name),
    size: stored.size,
    sha256: sha,
    author: client,
    store: stored.store,
    url: stored.url,
    rid: stored.rid,
    created_at: now(),
  });

  return json({
    file: {
      id: saved.id, name: saved.name, mime: saved.mime, size: saved.size, url: saved.url, store: saved.store,
    },
  }, 201);
});

/** Reads a room up to now. */
route('POST', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/read$/, async (request, env, m) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  await room.chats.markRead(room.conv.id, room.who.user.id, now());
  return json({ ok: true });
});

/** Subscribe to a channel, or accept an invitation to a group. */
route('POST', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/members$/, async (request, env, m) => {
  const who = await identity(request, env);
  if (!who) return fail(401, 'login required');
  const chats = new ChatStore(env);
  const conv = await chats.getConversation(m[1]);
  if (!conv) return fail(404, 'no such conversation');
  const mine = await chats.getMember(conv.id, who.user.id);
  const rights = rightsFor(conv, mine);

  let payload = {};
  try {
    payload = await readJson(request, config(env).maxTextBytes);
  } catch (err) {
    if (err.code !== 'TOO_LARGE') return fail(400, err.message);
  }
  const target = str(payload.userId, 40);
  if (!target) return fail(400, 'userId is required');

  // Joining a public channel needs no permission at all. Joining a group does:
  // the room is private, so either you are already in, or somebody inside may
  // add you. "Public" is a property of the channel, not of the person asking.
  const self = target === who.user.id;
  if (!self && !rights.invite) return fail(403, 'you cannot invite here');
  if (self && !mine && !conv.discoverable && !rights.invite) {
    return fail(403, 'no access to this conversation');
  }
  if (!(await env.STORE.getUser(target))) return fail(404, 'no such account');
  if ((await chats.sanctionOf(conv.id, target)) === 'kick') return fail(403, 'that account was removed');

  await chats.addMember(conv.id, target, 'member', now());
  return json({ ok: true, chatId: conv.id, userId: target }, 201);
});

/** Leave a room, or remove someone from it. */
route('DELETE', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/members\/([A-Za-z0-9_-]{3,40})$/, async (request, env, m) => {
  const who = await identity(request, env);
  if (!who) return fail(401, 'login required');
  const chats = new ChatStore(env);
  const conv = await chats.getConversation(m[1]);
  if (!conv) return fail(404, 'no such conversation');
  const mine = await chats.getMember(conv.id, who.user.id);
  const rights = rightsFor(conv, mine);
  const target = m[2];

  const leaving = target === who.user.id;
  if (!leaving && !rights.manage) return fail(403, 'you cannot remove anyone here');
  if (leaving && !rights.leave) return fail(403, 'you cannot leave');
  // The last person cannot leave: an empty room cannot be joined again unless it
  // is public, and a public channel with no members is a room nobody moderates.
  if (leaving && (await chats.memberCount(conv.id)) <= 1) return fail(409, 'a room needs at least one member');

  await chats.removeMember(conv.id, target);
  if (!leaving) {
    await chats.addTakedown({
      convId: conv.id, userId: target, action: 'kick', byUserId: who.user.id, reason: 'removed', at: now(),
    });
  }
  return json({ ok: true });
});

/** Rename a room, or change whether a channel is listed publicly. */
route('PATCH', /^\/api\/chats\/([A-Za-z0-9]{6,24})$/, async (request, env, m) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  if (!room.rights.manage) return fail(403, 'you cannot manage this conversation');
  const banned = requireUnbanned(room.who);
  if (banned) return banned;

  let payload;
  try {
    payload = await readJson(request, config(env).maxTextBytes);
  } catch (err) {
    return fail(err.code === 'TOO_LARGE' ? 413 : 400, err.message);
  }
  const patch = {};
  if (payload.title !== undefined) {
    const title = str(payload.title, TITLE_MAX_CHAT);
    if (!title) return fail(400, 'title is required');
    patch.title = title;
  }
  if (payload.topic !== undefined) patch.topic = str(payload.topic, TOPIC_MAX_CHAT);
  if (payload.discoverable !== undefined) {
    // Only a channel can be listed publicly. A group that could be would stop
    // being a group the moment somebody flipped a flag.
    if (room.conv.kind !== 'channel') return fail(400, 'only a channel can be public');
    patch.discoverable = !!payload.discoverable;
  }
  if (!Object.keys(patch).length) return fail(400, 'nothing to change');

  const updated = await room.chats.updateConversation(room.conv.id, patch);
  return json({ chat: convView(updated, room.rights, room.member) });
});

/** Take a single message down. The row stays, so the thread keeps its shape. */
route('DELETE', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/messages\/([A-Za-z0-9]{6,24})$/, async (request, env, m) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  const banned = requireUnbanned(room.who);
  if (banned) return banned;

  const message = await room.chats.getMessage(m[2]);
  if (!message || message.conv_id !== room.conv.id) return fail(404, 'no such message');
  // Your own message, or a moderator's judgement. Nobody else.
  if (message.user_id !== room.who.user.id && !room.rights.manage) {
    return fail(403, 'you cannot remove this message');
  }
  // A message with neither words nor files was never readable by anybody, so it is
  // removed outright instead of leaving a tombstone in every future copy of the
  // room. Anything with content in it keeps the ordinary soft delete.
  const removed = await room.chats.removeEmptyMessage(message.id);
  if (removed) return json({ ok: true, messageId: message.id, deleted: true, removed: true });
  await room.chats.softDeleteMessage(message.id, room.who.user.id, now());
  return json({ ok: true, messageId: message.id, deleted: true });
});

/**
 * Hands a WebSocket upgrade to the room.
 *
 * This route does almost nothing on purpose. It cannot authenticate the request -
 * a browser sends no session header on an upgrade - so the answer was already
 * given when the ticket was minted, and the DO re-checks that ticket against D1
 * before accepting anything. What this route is for is the 426: a plain GET on the
 * same path, and anything not addressed to a room, should be refused here where
 * it costs one request instead of waking a Durable Object.
 */
route('GET', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/ws$/, async (request, env, m, url) => {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('expected Upgrade: websocket', {
      status: 426,
      headers: { 'Content-Type': 'text/plain', 'Upgrade': 'websocket' },
    });
  }
  const stub = roomStub(env, m[1]);
  // No binding means no live delivery, and saying so plainly beats a socket that
  // accepts and then never says anything.
  if (!stub) return new Response('live delivery is not configured', { status: 503 });
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(url.searchParams.get('ticket') || '')) {
    return new Response('bad ticket', { status: 403 });
  }
  return stub.fetch(request);
});

/**
 * Mutes or unmutes somebody in a room.
 *
 * The sanction is per-room and never global: being shouted down in one channel
 * has not earned a ban from the site. `muted: false` clears the mute rather than
 * adding an "unmute", because a list of takedowns that can only grow is a list
 * nobody can undo.
 */
route('POST', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/members\/([A-Za-z0-9_-]{3,40})\/mute$/, async (request, env, m) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  if (!room.rights.manage) return fail(403, 'you cannot moderate this conversation');

  let payload = {};
  try {
    payload = await readJson(request, config(env).maxTextBytes);
  } catch (err) {
    return fail(400, err.message);
  }
  const target = m[2];
  const member = await room.chats.getMember(room.conv.id, target);
  if (!member) return fail(404, 'that account is not in this conversation');
  // An owner who cannot talk cannot moderate, and a moderator who can silence
  // the owner has stopped being a moderator.
  if (member.role === 'owner' && payload.muted !== false) {
    return fail(403, 'the owner cannot be muted');
  }
  if (member.role === 'owner' && target !== room.who.user.id) {
    return fail(403, 'you cannot change the owner');
  }

  await room.chats.setSanction(room.conv.id, target, payload.muted === false ? null : 'mute', {
    byUserId: room.who.user.id, reason: str(payload.reason, 200), at: now(),
  });
  return json({ ok: true, userId: target, muted: payload.muted !== false });
});

/**
 * Mints a ticket for one WebSocket handshake.
 *
 * The browser cannot set a request header when it opens a WebSocket, and the
 * session token must not travel in a query string where it lands in access logs
 * and `Referer`. So the client exchanges a normal authenticated POST for a
 * single-use ticket that lives for a minute, and the socket carries that.
 */
route('POST', /^\/api\/chats\/([A-Za-z0-9]{6,24})\/ticket$/, async (request, env, m) => {
  const room = await openRoom(request, env, m[1]);
  if (room.error) return room.error;
  if (!room.rights.post) return fail(403, 'you cannot join this conversation');

  const token = newSecret();
  // secretHash is async; without the await this would store a Promise's string
  // form as the digest and the handshake could never compare against it.
  const tokenHash = await secretHash(token);
  const expiresAt = now() + TICKET_TTL_MS;
  const id = await room.chats.createTicket({
    convId: room.conv.id, userId: room.who.user.id, tokenHash, expiresAt, at: now(),
  });
  // Expiry is belt and braces: the handshake checks it, and the sweeper clears
  // spent rows so the table does not grow into a log.
  env.waitUntil?.(room.chats.dropExpiredTickets(now() + TICKET_TTL_MS * 10).catch(() => {}));

  return json({
    ticket: token,
    ticketId: id,
    // A path, not a URL: the client builds the socket address from the API
    // origin, which is not the origin the page was served from.
    url: `/api/chats/${room.conv.id}/ws`,
    expiresAt,
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
 *
 * The session and proof-of-work headers have to be listed here too: the site is
 * served from GitHub Pages and the API from a Worker, so every authenticated call
 * is cross-origin and preflighted. Omitting one does not fail the request in
 * tests - the test harness calls the worker directly and never goes through a
 * preflight - it just fails in a real browser, as a CORS error with no explanation.
 */
const ALLOWED_HEADERS = 'content-type, x-cheatlab-client, x-cheatlab-secret, x-cheatlab-session, x-cheatlab-pow, x-cheatlab-pow-nonce, x-cheatlab-key, x-filename';
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
  ConversationRoom,
  async fetch(request, rawEnv) {
    if (!pluginHost) pluginHost = await new PluginHost().load(rawEnv);
    const env = {
      ...rawEnv,
      STORE: new Store(rawEnv.DB),
      BLOBS: new BlobStore(rawEnv),
      PLUGINS: pluginHost,
    };
    const origin = config(env).allowOrigin;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), origin, true);
    }

    const method = request.method === 'HEAD' ? 'GET' : request.method;

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/f/')
        || url.pathname.startsWith('/r/') || url.pathname.startsWith('/m/')
        || url.pathname.startsWith('/a/') || url.pathname === '/') {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        try {
          const out = await r.handler(request, env, m, url);
          // A 101 carries the socket in the response object itself, so rebuilding
          // it - which is all the CORS wrapper does - would throw the socket away
          // and leave the client hanging. A handshake also has no origin to
          // police: the browser sends one, and the ticket is the credential.
          if (out.status === 101) return out;
          return withCors(out, origin);
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
