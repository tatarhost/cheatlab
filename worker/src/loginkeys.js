/**
 * Login keys — a signed link that logs a browser into an account.
 *
 * The site already knows how to log someone in with a nick and password. What
 * it could not do is hand a registered user a link they can open later (or on
 * another device) and be signed in without typing anything. That is what this
 * module issues: `clab2-<payload>-<mac>`, an HMAC-signed bearer string whose
 * payload names the account, in the same visual shape as the desktop app's
 * `clab1-…` gate key but signed with a secret that never leaves the Worker.
 *
 * Three properties matter, and each one is a reason the verification lives
 * here rather than in the browser:
 *
 *   1. The signing secret is server-side. The app's own key secret is embedded
 *      in public/app.js because the desktop app verifies offline; a login key
 *      verified with a public secret would let anyone sign a key for anyone
 *      else's account and walk straight in. So the two key families share a
 *      shape and nothing else — a `clab1-…` string presented to the login
 *      endpoint is rejected before any crypto runs, and even a well-formed
 *      `clab2-…` has to carry an HMAC this module computed.
 *   2. Keys expire. A login key is a password-equivalent bearer string that
 *      will sit in browser history, screenshots and chat logs, so it carries
 *      its issue time and stops verifying after LOGIN_KEY_TTL_MS. Expired is
 *      the safe failure: the user asks for a new one, the leaked link dies.
 *   3. The payload names the account by id, not by nick. A key issued before a
 *      rename keeps working, and a key for a deleted account resolves to
 *      nothing instead of following the nick to whoever holds it now.
 *
 * Everything here is pure: secrets and time come in, a string or null comes
 * out. The routes in index.js own sessions, throttling and responses.
 */
import { hexEquals } from './util.js';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const enc = new TextEncoder();

/** Same visual family as the desktop app key, different family in practice. */
export const LOGIN_KEY_PREFIX = 'clab2-';

/** How long a login key stays valid. Long enough to bookmark, short enough that a leaked link rots. */
export const LOGIN_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Payload version. A future format can change this without ambiguity. */
const VERSION = 'v2';

/** Small allowance for a browser and the Worker disagreeing about the clock. */
const SKEW_MS = 5 * 60 * 1000;

/** RFC 4648 base32, lowercase, no padding — the encoding the site already uses for app keys. */
export function b32encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out.toLowerCase();
}

/**
 * Inverse of b32encode. Returns null rather than throwing: every caller is
 * parsing attacker-supplied text, and "cannot decode" is an ordinary outcome,
 * not an exception worth a 500.
 */
export function b32decode(text) {
  if (typeof text !== 'string' || !text) return null;
  const upper = text.toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of upper) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // A base32 string whose leftover bits are not zero decodes to something that
  // would not re-encode to the same input — that is a corrupt tail, not a key.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return new Uint8Array(out);
}

async function macOf(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  // Twelve bytes of a HMAC-SHA256 is 96 bits of forgery resistance — the same
  // cut the desktop app key uses, so both families read the same way.
  return b32encode(sig.slice(0, 12));
}

/**
 * Signs a login key for `userId`.
 *
 * `issuedAt` is an argument rather than a hidden `Date.now()` so a test can
 * mint an already-expired key without waiting 90 days or faking the clock.
 */
export async function issueLoginKey(secret, userId, issuedAt = Date.now()) {
  if (!secret || typeof userId !== 'string' || !userId) return null;
  const payload = `${VERSION}|${userId}|${issuedAt}`;
  return LOGIN_KEY_PREFIX + b32encode(enc.encode(payload)) + '-' + await macOf(secret, payload);
}

/**
 * Verifies a login key and returns `{ userId, issuedAt, expiresAt }`, or null.
 *
 * Null means every failure the caller is allowed to see: wrong family, corrupt
 * encoding, bad signature, unknown version, expired, or issued in the future.
 * The caller must treat null as "not signed in" and never as a server error.
 */
export async function verifyLoginKey(secret, key, now = Date.now()) {
  if (!secret || typeof key !== 'string') return null;
  if (!key.startsWith(LOGIN_KEY_PREFIX)) return null;
  const body = key.slice(LOGIN_KEY_PREFIX.length);
  const dash = body.lastIndexOf('-');
  if (dash <= 0 || dash === body.length - 1) return null;
  const payloadB32 = body.slice(0, dash);
  const macB32 = body.slice(dash + 1);

  const bytes = b32decode(payloadB32);
  if (!bytes) return null;
  const payload = new TextDecoder().decode(bytes);
  const parts = payload.split('|');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, userId, tsRaw] = parts;
  // `u_` + 12 id characters is what newUserId mints; the loose shape keeps a
  // future id format compatible without silently accepting arbitrary text.
  if (!/^u_[A-Za-z0-9_-]{4,40}$/.test(userId)) return null;
  const issuedAt = Number(tsRaw);
  if (!Number.isFinite(issuedAt) || !Number.isInteger(issuedAt)) return null;
  if (issuedAt > now + SKEW_MS) return null;
  if (now - issuedAt > LOGIN_KEY_TTL_MS) return null;

  const expected = await macOf(secret, payload);
  // Canonical base32 only: b32decode already rejected corrupt input, so the
  // comparison cannot be walked around by re-casing or padding the key.
  if (!hexEquals(expected, macB32.toLowerCase())) return null;

  return { userId, issuedAt, expiresAt: issuedAt + LOGIN_KEY_TTL_MS };
}
