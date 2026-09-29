/**
 * Account identity: password hashing, nicknames, sessions.
 *
 * Separate from store.js because none of this is SQL - it is the policy that
 * decides whether a request may become a user, and it has to be testable on its
 * own. store.js talks to D1, this decides.
 */
import { newId, newSecret, secretHash, secretMatches, now, str, sha256 } from './util.js';

const enc = new TextEncoder();

/**
 * Hard ceiling imposed by the Workers runtime: `crypto.subtle.deriveBits`
 * rejects any PBKDF2 request above 100k iterations with NotSupportedError, which
 * is what made every registration and login fail with a 500. Node's WebCrypto
 * has no such cap, so the test suite alone cannot catch a value that is illegal
 * in production - hence PBKDF2_MAX below and the guard in the tests.
 *
 * The cost is stored per user, so this can be raised again later without
 * invalidating anyone's password, as long as it stays at or under the cap.
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;

/**
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is 600k, but two hard limits make
 * that unreachable here: Workers CPU-bounded request limits (a single login at
 * 600k costs roughly a second of CPU) and the runtime's own 100k cap above. 100k
 * is the strongest setting this deployment can actually run.
 */
export const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
const SALT_BYTES = 16;
const KEY_BITS = 256;

/** Common passwords stay rejected even when they satisfy every other rule. */
const BANNED = new Set([
  'password', 'passw0rd', 'password1', 'password123', 'qwerty', 'qwerty123',
  '123456', '12345678', '123456789', '1234567890', '11111111', '00000000',
  'letmein', 'welcome', 'welcome1', 'admin', 'administrator', 'iloveyou',
  'sunshine', 'princess', 'football', 'baseball', 'monkey', 'dragon',
  'master', 'shadow', 'superman', 'trustno1', 'starwars', 'whatever',
  'cheatlab', 'secret', 'test', 'test123', 'testtest', 'default', 'root',
]);

/**
 * Password policy. Length is the dominant factor, so the floor is high and the
 * composition rules are deliberately light: forcing a digit and a symbol pushes
 * people toward "Password1!", which looks compliant and is barely better.
 * Returns a list of human-readable problems, empty when acceptable.
 */
export function passwordProblems(pw) {
  const out = [];
  if (typeof pw !== 'string' || !pw) return ['Пароль не указан.'];

  if (pw.length < 10) out.push('Минимум 10 символов.');
  if (pw.length > 200) out.push('Максимум 200 символов.');

  const lower = pw.toLowerCase();
  if (BANNED.has(lower)) out.push('Этот пароль слишком распространённый.');
  // A single repeated character ("aaaaaaaaaa") passes a length check but has
  // almost no entropy, so reject the degenerate cases explicitly.
  if (/^(.)\1+$/.test(pw)) out.push('Пароль не может быть одним повторяющимся символом.');
  if (/^(0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(lower)) {
    out.push('Пароль слишком предсказуем.');
  }
  return out;
}

/** Nickname: 3-24 chars, letters/digits/underscore/dot, cannot be all digits. */
export function nickProblems(nick) {
  const out = [];
  if (typeof nick !== 'string' || !nick) return ['Ник не указан.'];
  if (nick.length < 3) out.push('Минимум 3 символа.');
  if (nick.length > 24) out.push('Максимум 24 символа.');
  if (!/^[A-Za-z0-9_.\-]+$/.test(nick)) {
    out.push('Только латиница, цифры, точка, дефис и подчёркивание.');
  }
  if (/^\d+$/.test(nick)) out.push('Ник не может состоять только из цифр.');
  return out;
}

/**
 * Case/space-insensitive key used for both uniqueness and lookup, so
 * " Danil " and "danil" collide. NFKC normalises lookalike forms.
 */
export const nickKey = (nick) =>
  String(nick || '').normalize('NFKC').trim().toLowerCase();

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64 = (str64) => {
  const s = str64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function pbkdf2(pw, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(pw, iterations = PBKDF2_ITERATIONS) {
  // Clamped rather than trusted: an over-cap count throws NotSupportedError deep
  // inside deriveBits, which surfaces to the caller as an opaque 500.
  const cost = Math.min(Math.max(1, Math.trunc(iterations)), PBKDF2_MAX_ITERATIONS);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await pbkdf2(pw, salt, cost);
  return { passHash: b64(key), passSalt: b64(salt), iterations: cost };
}

/**
 * Verifies against the stored iteration count, so raising the cost later does
 * not lock anyone out. Re-hashes opportunistically when the stored count lags
 * the current policy, which is how the number gets upgraded in practice.
 */
export async function verifyPassword(pw, row) {
  if (!row?.pass_hash || !row?.pass_salt) return { ok: false, needsRehash: false };
  const iterations = Number(row.iterations) || PBKDF2_ITERATIONS;
  let got;
  try {
    got = await pbkdf2(pw, unb64(row.pass_salt), iterations);
  } catch {
    // A stored count the runtime refuses (over the cap) cannot be verified, so
    // this is treated exactly like a wrong password rather than a 500.
    return { ok: false, needsRehash: false };
  }
  const expected = unb64(row.pass_hash);
  if (expected.length !== got.length) return { ok: false, needsRehash: false };
  // Constant-time compare: a length-independent early exit would leak the
  // prefix length through timing.
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  const needsRehash = diff === 0 && iterations < PBKDF2_ITERATIONS;
  return { ok: diff === 0, needsRehash };
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Session token plus the value to store. The plaintext is returned exactly once,
 * to the client; the database only ever sees the hash.
 */
export async function newSession() {
  const token = newSecret();
  return { token, tokenHash: await secretHash(token) };
}

/**
 * Rejects a session unless it is unexpired and was issued to this client id.
 * The client check is what makes a leaked token useless if it is replayed from
 * a different browser than the one that created it.
 *
 * A request that carries no usable client id is rejected rather than allowed
 * through. Treating "no client id" as "cannot be wrong" looks permissive but
 * defeats the whole check: whoever holds a stolen token also controls the
 * request, so the one header they cannot guess is the only thing standing
 * between a leak and a takeover. The browser always sends this header, from a
 * value it generated, so requiring it costs an honest user nothing.
 */
export async function sessionValid(row, clientId) {
  if (!row?.token_hash) return false;
  if (Number(row.expires_at) <= now()) return false;
  if (!clientId) return false;
  if (row.client_id && row.client_id !== clientId) return false;
  return true;
}

/**
 * True when a user id is in the admin list. The list ships in the environment
 * as a comma-separated string, because it is a deploy-time fact rather than
 * account data anyone should be able to vote on.
 */
export function adminOf(env, id) {
  if (!env?.ADMIN_IDS || !id) return false;
  return String(env.ADMIN_IDS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(id));
}

/** Public shape of a user. Never includes any credential material. */
export function publicUser(row, env) {
  if (!row) return null;
  return {
    id: row.id,
    nick: row.nick,
    bio: str(row.bio, 200),
    logo: str(row.logo, 300),
    accent: str(row.accent, 16),
    bg: str(row.bg, 120),
    followers: Number(row.followers) || 0,
    following: Number(row.following) || 0,
    posts: Number(row.posts) || 0,
    createdAt: Number(row.created_at) || 0,
    admin: adminOf(env, row.id),
  };
}

export function newUserId() {
  return 'u_' + newId(12);
}

export { secretHash, secretMatches, sha256 };
