/**
 * Anti-abuse: proof-of-work, CAPTCHA and per-tier quotas.
 *
 * The threat this addresses is an anonymous flood of accounts and posts. Three
 * independent controls, cheapest first, so a legitimate user never sees a
 * CAPTCHA when they have not misbehaved:
 *
 *   1. per-IP/request throttling      - cheap, already in store.throttle
 *   2. proof-of-work                  - free for the user, expensive per bot
 *   3. CAPTCHA                        - only after actual abuse signals
 *
 * A CAPTCHA on every anonymous post would cost more real users than it costs
 * bots, because a bot pays it once per throwaway account and a person pays it
 * on every idea. So the challenge is issued on a risk score, not blanket.
 */
import { newId, now, secretHash, hexEquals } from './util.js';

const enc = new TextEncoder();

/**
 * Difficulty in leading zero *bits* of the digest. 22 bits is ~4.2M hashes:
 * tens of milliseconds in a browser, seconds in a naive server-side loop, which
 * is the asymmetry that makes it a filter.
 *
 * Read from env so the cost can be tuned per deployment - and so the test suite
 * can run at a difficulty that does not take minutes. It is clamped to a range
 * that still means something: low enough to be solvable, high enough to cost.
 */
export const DEFAULT_POW_BITS = 22;

export function powBits(env = {}) {
  const n = Number(env?.POW_BITS);
  if (!Number.isFinite(n)) return DEFAULT_POW_BITS;
  return Math.min(30, Math.max(8, Math.floor(n)));
}

/**
 * Stateless proof of work. The client must find `nonce` such that
 * sha256(`${challenge}.${nonce}`) starts with the required number of zero bits.
 * Nothing is stored, so there is no table to exhaust and no nonce table to farm.
 */
export async function checkPow(challenge, nonce, env = {}) {
  if (typeof challenge !== 'string' || typeof nonce !== 'string') return false;
  if (!challenge || !nonce) return false;
  const bits = powBits(env);
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}.${nonce}`));
  const bytes = new Uint8Array(digest);
  const full = Math.floor(bits / 4);
  for (let i = 0; i < full; i++) {
    if (bytes[i] !== 0) return false;
  }
  const rem = bits % 4;
  if (rem && (bytes[full] >> (4 - rem)) !== 0) return false;
  return true;
}

export const newPowChallenge = () => newId(12);

/**
 * Reference solver. Not used in production - the browser does this - but kept
 * here so the test suite and any future server-side verification share one
 * implementation, and so a wrong answer cannot be blamed on the client.
 */
export async function solvePow(challenge, env = {}, maxTries = 1e8) {
  for (let nonce = 0; nonce < maxTries; nonce++) {
    if (await checkPow(challenge, String(nonce), env)) return String(nonce);
  }
  return null;
}

/* --------------------------------------------------------------- CAPTCHA -- */

/**
 * Questions with answers a language model can guess and a database of common
 * words cannot. Deliberately not arithmetic: "what is 7 times 8" is solved by
 * any LLM or a spreadsheet, so it filters nobody. The point is to cost a
 * *scaling* attacker something per request, which only non-trivial computation
 * or private context can do.
 *
 * Signed, stateless, and short-lived: there is no challenge table to fill up,
 * and a replayed token is only good for 10 minutes.
 */
const CAPTCHA_TTL_MS = 10 * 60 * 1000;
const SECRETLESS = 'dev';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const WORDS = [
  'аккаунт', 'скрипт', 'сообщение', 'канал', 'группа', 'профиль', 'подписчик',
  'настройка', 'обновление', 'загрузка', 'хранилище', 'пароль', 'защита',
  'памятка', 'структура', 'программа', 'страница', 'раздел', 'плагин', 'шаблон',
];

/**
 * Each puzzle returns the question and the answer it must produce. The answer
 * is derived from the same random draw as the question, so it is recomputable
 * for verification and never stored.
 *
 * Multi-step arithmetic, not a single operation: "7 * 8" is one lookup for a
 * model or a calculator, whereas three chained operations with a per-question
 * random operand is real work that a scaling bot pays for on every request.
 */
const PUZZLES = [
  () => {
    const a = 2 + Math.floor(Math.random() * 40);
    const b = 2 + Math.floor(Math.random() * 40);
    const c = 2 + Math.floor(Math.random() * 20);
    return {
      q: `Сколько будет ${a} * ${b} + ${c}? Ответ числом.`,
      a: a * b + c,
    };
  },
  () => {
    const a = 11 + Math.floor(Math.random() * 89);
    const b = 2 + Math.floor(Math.random() * 9);
    return {
      q: `Сколько будет ${a} * ${b} - ${b * 3}? Ответ числом.`,
      a: a * b - b * 3,
    };
  },
  () => {
    const word = pick(WORDS);
    // Answer is the character count, so it needs the word, not a lookup.
    return {
      q: `Сколько букв в слове «${word}»? Ответ числом.`,
      a: [...word].length,
    };
  },
  () => {
    const a = 100 + Math.floor(Math.random() * 900);
    const b = 2 + Math.floor(Math.random() * 9);
    return {
      q: `Сколько будет ${a} * ${b} + 7? Ответ числом.`,
      a: a * b + 7,
    };
  },
];

/**
 * Issues a captcha and returns the question plus an opaque handle to it.
 *
 * The handle is `id.signature`, where the signature covers the id alone. It
 * carries no answer: an earlier build put the answer in the signed payload,
 * which any caller could base64-decode, so the CAPTCHA stopped being a check on
 * anything. Now the answer is a row in D1 and the token is only a reference.
 *
 * The cost is one write per challenge request. That is a deliberate trade: a
 * stateless design is cheaper, but a stateless design cannot hide its own answer
 * from the party being challenged. Expired rows are swept on issue, so the table
 * stays proportional to live challenges rather than to total requests.
 */
export async function issueCaptcha(db, env, { risk = 0 } = {}) {
  const p = pick(PUZZLES)();
  const id = newId(10);
  const issuedAt = now();
  const expires = issuedAt + CAPTCHA_TTL_MS;
  await db
    .prepare('DELETE FROM captcha WHERE expires_at < ?')
    .bind(issuedAt - CAPTCHA_TTL_MS)
    .run();
  await db
    .prepare(
      'INSERT INTO captcha (id, question, answer, issued_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)',
    )
    .bind(id, p.q, String(p.a), issuedAt, expires)
    .run();
  const token = await signCaptcha(env, id);
  return { id, q: p.q, token, exp: expires, risk };
}

async function signCaptcha(env, id) {
  const sig = await secretHash(`${captchaKey(env)}.${id}`);
  return `${id}.${sig}`;
}

/**
 * Checks an answer against the stored challenge and burns it.
 *
 * `used_at IS NULL` is part of the WHERE clause, so the update is the claim: two
 * concurrent replays of the same token produce one winner, and the loser reads
 * back no row and is rejected.
 */
export async function verifyCaptcha(db, env, token, answer) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [id, sig] = token.split('.');
  if (!id || !sig) return false;
  if (!hexEquals(await secretHash(`${captchaKey(env)}.${id}`), sig)) return false;

  const row = await db
    .prepare('SELECT answer, expires_at, used_at FROM captcha WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return false;
  if (row.used_at != null) return false;
  if (Number(row.expires_at) < now()) return false;

  const given = String(answer ?? '').trim().toLowerCase();
  if (given !== String(row.answer).trim().toLowerCase()) return false;

  const claim = await db
    .prepare('UPDATE captcha SET used_at = ? WHERE id = ? AND used_at IS NULL')
    .bind(now(), id)
    .run();
  return Number(claim?.meta?.changes) === 1;
}

/**
 * Signing key for captcha handles.
 *
 * The answer no longer travels with the token, so this key is no longer the sole
 * thing standing between a bot and a solved challenge - it signs the challenge
 * id, which is what stops a caller minting handles for ids it guesses and then
 * brute-forcing answers against them. A published fallback would remove that, so
 * it is dev-only and says so once per isolate rather than failing silently.
 */
function captchaKey(env) {
  const key = env.CAPTCHA_SECRET;
  if (key) return key;
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn(
      '[cheatlab] CAPTCHA_SECRET is not set; using a public fallback. '
      + 'Set it with: wrangler secret put CAPTCHA_SECRET',
    );
  }
  return SECRETLESS;
}
let warnedAboutSecret = false;

/* ---------------------------------------------------------------- quotas -- */

/**
 * The per-tier policy, in one table so the site cannot drift from the docs.
 * Numbers come from the product decision, not from taste:
 *
 *   anonymous : 1 new item per day, captcha on each post, no friends/voice
 *   registered: 3-4 new items per day, no captcha, unlimited code edits
 *
 * Edits are deliberately uncapped for registered users and tightly capped for
 * anonymous ones, because editing an existing item costs no storage while
 * creating one does. That is the whole reason the two limits differ.
 */
export const QUOTA = {
  anonymous: {
    newItemsPerDay: 1,
    editsPerDay: 5,
    editsPerHour: 10,
    storageBytes: 64 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    captchaOnPost: true,
    captchaOnMessage: true,
    canFollow: false,
    canVoice: false,
  },
  registered: {
    newItemsPerDay: 4,
    // "безлимитное обновление кода" - bounded only by burst, not by a daily
    // budget, because it consumes no quota.
    editsPerDay: Infinity,
    editsPerHour: 120,
    storageBytes: 2 * 1024 * 1024 * 1024,
    maxFileBytes: 24 * 1024 * 1024,
    captchaOnPost: false,
    captchaOnMessage: false,
    canFollow: true,
    canVoice: true,
  },
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Effective policy for a request: registered users get the full tier.
 *
 * The two daily item caps are overridable from the environment because they are
 * the numbers most likely to be tuned after launch, and a policy constant that
 * can only be changed by a redeploy gets tuned by editing source. The default is
 * the shipped policy; setting the var is the only way to change it.
 */
export function quotaFor(user, env = {}) {
  const base = user ? QUOTA.registered : QUOTA.anonymous;
  const capVar = user ? env.REG_NEW_ITEMS_PER_DAY : env.ANON_NEW_ITEMS_PER_DAY;
  const cap = capVar === undefined || capVar === '' ? undefined : Number(capVar);
  return Number.isFinite(cap) && cap >= 0 ? { ...base, newItemsPerDay: cap } : base;
}

/**
 * Storage is accounted per owner so one account cannot fill the bucket for
 * everyone. `ownerKey` is `u:<userId>` for a signed-in account and the raw
 * client id for an anonymous caller - weak against a determined attacker, but
 * the honest limit for an identity they did not have to create.
 *
 * Items are attributed to a user through item_owner, not items.author, because
 * a signed-in user publishes under the same client id an anonymous one uses.
 * The two branches are separate queries rather than one clever expression: the
 * parameter binding is then unambiguous.
 */
export async function storageUsed(db, ownerKey) {
  const isUser = ownerKey.startsWith('u:');
  const row = isUser
    ? await db
        .prepare(
          `SELECT COALESCE(SUM(f.size), 0) AS bytes
             FROM files f
             JOIN item_owner o ON o.item_id = f.item_id
            WHERE o.user_id = ?`,
        )
        .bind(ownerKey.slice(2))
        .first()
    : await db
        .prepare(
          `SELECT COALESCE(SUM(f.size), 0) AS bytes
             FROM files f
             JOIN items i ON i.id = f.item_id
            WHERE i.author = ?`,
        )
        .bind(ownerKey)
        .first();
  return Number(row?.bytes) || 0;
}
