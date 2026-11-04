/**
 * Entry point. Wraps the existing Worker (index.js) without changing it:
 *
 *   - bot check on login and registration (signed challenge + proof of work + question),
 *   - AI moderation of posts, comments, chat messages, profile text, images and text files,
 *   - the design gallery API (/api/themes).
 *
 * Anything this file does not recognise goes straight to index.js untouched.
 * If the guard itself throws on content moderation, the request is passed on
 * rather than blocked, so a model outage cannot take publishing down. Auth is the
 * opposite: it fails closed, because a bot check that opens on error is not one.
 */
import worker, { ConversationRoom } from './index.js';
import { Store } from './store.js';
import { issueCaptcha, verifyCaptcha, meetsDifficulty } from './abuse.js';
import { moderateText, moderateImage, imageMimeOf, rejection } from './moderation.js';
import { handleThemes } from './themes.js';

export { ConversationRoom };

const HC_BITS = 14;                 // ~16k hashes: instant for a browser, a cost for a flood
const HC_TTL_MS = 10 * 60 * 1000;
const SMALL = 4_000_000;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function replyFor(env) {
  const origin = env.ALLOW_ORIGIN || '*';
  return (status, obj) => new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

async function hmac(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.CAPTCHA_SECRET || 'dev'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

async function newChallenge(env) {
  const ts = Date.now();
  const rand = hex(crypto.getRandomValues(new Uint8Array(8)));
  return `${ts}.${rand}.${await hmac(env, `${ts}.${rand}`)}`;
}

async function challengeValid(env, challenge, nonce) {
  const [ts, rand, sig] = String(challenge || '').split('.');
  if (!ts || !rand || !sig || !/^\d+$/.test(ts) || !/^[0-9a-f]{16}$/.test(rand)) return false;
  if (Date.now() - Number(ts) > HC_TTL_MS || Number(ts) > Date.now() + 60_000) return false;
  if ((await hmac(env, `${ts}.${rand}`)) !== sig) return false;
  if (typeof nonce !== 'string' || !/^\d{1,12}$/.test(nonce)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}.${nonce}`)));
  if (!meetsDifficulty(digest, HC_BITS)) return false;
  // A solved challenge is good once. KV is eventually consistent, which is fine for a 10 minute window.
  if (env.BUCKET) {
    if (await env.BUCKET.get(`hc:${rand}`)) return false;
    await env.BUCKET.put(`hc:${rand}`, '1', { expirationTtl: 900 });
  }
  return true;
}

/** Returns a Response when the human check fails, otherwise null. */
async function humanGate(env, body, reply) {
  const fail = () => reply(403, { error: 'Проверка не пройдена. Попробуйте ещё раз.', humanCheck: false });
  if (typeof body?.hp === 'string' && body.hp.trim()) return fail();       // honeypot filled
  const hc = body?.hc;
  if (!hc || typeof hc !== 'object') return fail();
  if (!(await verifyCaptcha(env.DB, env, hc.ct, hc.ca))) return fail();     // burns the question
  if (!(await challengeValid(env, hc.c, hc.n))) return fail();
  return null;
}

async function readBody(request) {
  const raw = await request.arrayBuffer();
  let json = {};
  try { json = JSON.parse(new TextDecoder().decode(raw)); } catch { /* leave empty */ }
  return { raw, json };
}
const rebuild = (request, raw) => new Request(request.url, { method: request.method, headers: request.headers, body: raw });

const joinTags = (t) => (Array.isArray(t) ? t.join(' ') : String(t || ''));
const codeLike = (type) => type === 'script' || type === 'app' || type === 'paste';
const postText = (j) => [j.title, joinTags(j.tags), String(j.body || '').slice(0, codeLike(j.type) ? 3000 : 6000)].filter(Boolean).join('\n');

const TEXT_ROUTES = [
  { method: 'POST', re: /^\/api\/items$/, pick: postText },
  { method: 'PATCH', re: /^\/api\/items\/[A-Za-z0-9]{4,16}$/, pick: postText },
  { method: 'POST', re: /^\/api\/items\/[A-Za-z0-9]{4,16}\/comments$/, pick: (j) => j.body },
  { method: 'POST', re: /^\/api\/chats\/[A-Za-z0-9]{6,24}\/messages$/, pick: (j) => j.body },
  { method: 'POST', re: /^\/api\/chats$/, pick: (j) => [j.title, j.topic].filter(Boolean).join('\n') },
  { method: 'PATCH', re: /^\/api\/auth\/me$/, pick: (j) => [j.nick, j.bio].filter(Boolean).join('\n') },
];
const FILE_ROUTES = [
  /^\/api\/items\/[A-Za-z0-9]{4,16}\/files$/,
  /^\/api\/chats\/[A-Za-z0-9]{6,24}\/messages\/[A-Za-z0-9]{6,24}\/files$/,
];
const PLAIN_TEXT_EXT = /\.(txt|md)$/i;

async function whoami(request, env, ctx) {
  const h = new Headers();
  for (const k of ['x-cheatlab-session', 'x-cheatlab-client']) {
    const v = request.headers.get(k);
    if (v) h.set(k, v);
  }
  const res = await worker.fetch(new Request(new URL('/api/auth/me', request.url), { headers: h }), env, ctx);
  const data = await res.json().catch(() => null);
  return data?.user || null;
}

/** Response to answer with, a Request to forward instead of the original, or nothing. */
async function guard(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;
  const reply = replyFor(env);
  const declared = Number(request.headers.get('content-length') || 0);

  if (m === 'GET' && p === '/api/hc/challenge') {
    const key = request.headers.get('x-cheatlab-client') || request.headers.get('cf-connecting-ip') || 'anon';
    if (!(await new Store(env.DB).throttle(`hc:${key}`, 'pow', { cap: 30, windowMs: 60_000 }))) return reply(429, { error: 'slow down' });
    const cap = await issueCaptcha(env.DB, env);
    return reply(200, { challenge: await newChallenge(env), bits: HC_BITS, captcha: { q: cap.q, token: cap.token } });
  }

  if (m !== 'OPTIONS' && p.startsWith('/api/themes')) {
    return handleThemes(request, env, { whoami: (req) => whoami(req, env, ctx), reply });
  }

  // Sign-in and registration. Registration is only checked once the app has done its own
  // proof of work, so the first attempt (which the app expects to be refused) costs nothing.
  const isLogin = m === 'POST' && p === '/api/auth/login';
  const isRegister = m === 'POST' && p === '/api/auth/register';
  if (isLogin || (isRegister && request.headers.get('x-cheatlab-pow-nonce'))) {
    const { raw, json } = await readBody(request);
    const bad = await humanGate(env, json, reply);
    if (bad) return bad;
    return rebuild(request, raw);
  }

  if (declared > SMALL && !FILE_ROUTES.some((re) => re.test(p))) return undefined;

  // Text moderation on JSON bodies.
  const route = TEXT_ROUTES.find((r) => r.method === m && r.re.test(p));
  if (route && declared <= 400_000) {
    const { raw, json } = await readBody(request);
    try {
      const verdict = await moderateText(env, route.pick(json));
      if (!verdict.ok) return reply(422, rejection(verdict));
    } catch (err) { console.warn('[guard] text moderation skipped', err?.message || err); }
    return rebuild(request, raw);
  }

  // Images and plain text files. Large images and every other file type go through
  // unscanned: the model sees pictures and words, not archives or video.
  if (m === 'POST' && (FILE_ROUTES.some((re) => re.test(p)) || p === '/api/auth/avatar')) {
    let name = request.headers.get('x-filename') || '';
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    const isAvatar = p === '/api/auth/avatar';
    const image = isAvatar ? /^image\//.test(request.headers.get('content-type') || '') : !!imageMimeOf(name);
    const text = !isAvatar && PLAIN_TEXT_EXT.test(name);
    if ((image && declared > 0 && declared <= 3.5 * 1024 * 1024) || (text && declared > 0 && declared <= 300_000)) {
      const raw = await request.arrayBuffer();
      try {
        const verdict = image
          ? await moderateImage(env, new Uint8Array(raw))
          : await moderateText(env, new TextDecoder().decode(raw.slice(0, 20_000)));
        if (!verdict.ok) return reply(422, rejection(verdict));
      } catch (err) { console.warn('[guard] file moderation skipped', err?.message || err); }
      return rebuild(request, raw);
    }
  }
  return undefined;
}

const isAuthPath = (p) => p === '/api/auth/login' || p === '/api/auth/register';

export default {
  ConversationRoom,

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const writes = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
    const small = Number(request.headers.get('content-length') || 0) <= SMALL;
    // A copy to fall back on, taken only where the guard will read the body.
    const spare = writes && small && url.pathname.startsWith('/api/') ? request.clone() : request;

    let out;
    try {
      out = await guard(request, env, ctx);
    } catch (err) {
      console.error('[guard]', err?.stack || err);
      if (isAuthPath(url.pathname)) return replyFor(env)(503, { error: 'Проверка временно недоступна. Попробуйте позже.' });
      out = undefined;
    }
    if (out instanceof Response) return out;
    return worker.fetch(out instanceof Request ? out : spare, env, ctx);
  },

  scheduled(event, env, ctx) {
    return worker.scheduled(event, env, ctx);
  },
};
