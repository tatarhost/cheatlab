/**
 * Moderation for text and images.
 *
 * Runs on Cloudflare Workers AI through the `AI` binding in wrangler.toml. That
 * needs no API key and no separate account: the binding belongs to this Worker.
 * The free plan has a daily allowance, so this is not unlimited. Three things keep
 * the allowance going a long way:
 *
 *   - cheap rules run first and reject obvious spam without calling a model,
 *   - verdicts are cached in KV by content hash, so the same text or image is
 *     judged once,
 *   - when the model is unavailable or the allowance is spent, the content is
 *     allowed through on the rules alone and the response says so (`source`).
 *
 * Models are read from env so they can be swapped without a deploy of new code:
 *   MOD_TEXT_MODEL   default @cf/meta/llama-guard-3-8b
 *   MOD_IMAGE_MODEL  default @cf/llava-hf/llava-1.5-7b-hf
 */

const TEXT_MODEL = '@cf/meta/llama-guard-3-8b';
const IMAGE_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';

// Llama Guard hazard categories this site refuses. S2 (non-violent crime) is left
// out on purpose: on a scripts site it would flag ordinary cheat and automation
// code. S5-S8 and S13-S14 are left to the report queue.
const BLOCK = {
  S1: 'насилие',
  S3: 'сексуальные преступления',
  S4: 'эксплуатация детей',
  S9: 'оружие массового поражения',
  S10: 'язык вражды',
  S11: 'самоповреждение',
  S12: 'сексуальный контент',
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return hex(await crypto.subtle.digest('SHA-256', data));
}

/** Rules that need no model: link floods, character floods, mass mentions. */
function rules(text) {
  const links = (text.match(/https?:\/\/|t\.me\/|discord\.gg\//gi) || []).length;
  if (links >= 6) return 'слишком много ссылок';
  if (/(.)\1{39,}/s.test(text)) return 'повторяющиеся символы';
  if (text.length > 400 && new Set(text.split(/\s+/)).size < 6) return 'повторяющийся текст';
  return '';
}

function parseGuard(out) {
  const r = out?.response;
  if (r && typeof r === 'object') {
    const cats = (r.categories || []).map((c) => String(c).toUpperCase());
    return { safe: r.safe !== false && !cats.length, cats };
  }
  const s = String(r ?? '');
  if (/^\s*safe/i.test(s)) return { safe: true, cats: [] };
  return { safe: false, cats: (s.match(/S\d{1,2}/gi) || []).map((c) => c.toUpperCase()) };
}

async function cached(env, key) {
  try { const v = await env.BUCKET?.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function remember(env, key, verdict) {
  try { await env.BUCKET?.put(key, JSON.stringify(verdict), { expirationTtl: 7 * 86400 }); } catch { /* cache only */ }
}

/**
 * @returns {{ok: boolean, reasons: string[], source: 'rules'|'ai'|'cache'|'unscanned'}}
 */
export async function moderateText(env, text, { skip = [] } = {}) {
  const t = String(text || '').trim().slice(0, 6000);
  if (t.length < 8) return { ok: true, reasons: [], source: 'rules' };

  const rule = rules(t);
  if (rule) return { ok: false, reasons: [rule], source: 'rules' };
  if (!env.AI) return { ok: true, reasons: [], source: 'unscanned' };

  const key = `mod:t:${await sha(t)}`;
  const hit = await cached(env, key);
  if (hit) return { ...hit, source: 'cache' };

  try {
    const out = await env.AI.run(env.MOD_TEXT_MODEL || TEXT_MODEL, { messages: [{ role: 'user', content: t }] });
    const { safe, cats } = parseGuard(out);
    const hits = cats.filter((c) => BLOCK[c] && !skip.includes(c));
    const verdict = { ok: safe || !hits.length, reasons: hits.map((c) => BLOCK[c]), source: 'ai' };
    await remember(env, key, verdict);
    return verdict;
  } catch (err) {
    console.warn('[moderation] text model unavailable', err?.message || err);
    return { ok: true, reasons: [], source: 'unscanned' };
  }
}

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
export const imageMimeOf = (name) => IMAGE_MIME[String(name).split('.').pop().toLowerCase()] || '';

/** Images up to 3.5 MB are scanned; larger ones are passed on and reported as unscanned. */
export async function moderateImage(env, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!env.AI || u8.byteLength > 3.5 * 1024 * 1024) return { ok: true, reasons: [], source: 'unscanned' };

  const key = `mod:i:${await sha(u8)}`;
  const hit = await cached(env, key);
  if (hit) return { ...hit, source: 'cache' };

  try {
    const out = await env.AI.run(env.MOD_IMAGE_MODEL || IMAGE_MODEL, {
      image: [...u8],
      prompt: 'Answer with one word, YES or NO. Does this image show nudity, pornography, graphic gore, or sexual content involving minors?',
      max_tokens: 8,
    });
    const answer = String(out?.description ?? out?.response ?? '').trim().toUpperCase();
    const verdict = /^YES/.test(answer)
      ? { ok: false, reasons: ['недопустимое изображение'], source: 'ai' }
      : { ok: true, reasons: [], source: 'ai' };
    await remember(env, key, verdict);
    return verdict;
  } catch (err) {
    console.warn('[moderation] image model unavailable', err?.message || err);
    return { ok: true, reasons: [], source: 'unscanned' };
  }
}

export const rejection = (verdict) => ({ error: 'rejected', reasons: verdict.reasons.map((r) => `Модерация: ${r}`) });
