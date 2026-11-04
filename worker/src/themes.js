/**
 * Community designs: a gallery of CSS themes that people write, publish and
 * install.
 *
 * User CSS is the risky part, so it is never stored or served as written. It is
 * parsed and rebuilt from an allowlist (see sanitizeCss). The one rule that
 * removes most of the danger is that user CSS cannot load anything: no url(),
 * no @import, no @font-face. Textures arrive as small data: images, are checked
 * by the image moderator, and are exposed to the stylesheet only as --tex-1..3
 * variables the Worker writes itself. With nothing to fetch there is nothing to
 * leak to a third-party host, and what remains is appearance only.
 */
import { newId, now } from './util.js';
import { Store } from './store.js';
import { moderateText, moderateImage, rejection } from './moderation.js';

const MAX_CSS = 24 * 1024;
const MAX_TEX_CHARS = 180_000;
const MAX_RULES = 400;
const THEMES_PER_DAY = 5;

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const PROP = /^(--[a-z0-9_-]{1,40}|-webkit-[a-z-]{1,40}|[a-z-]{1,40})$/;
const BAD_PROP = /^(behavior|-moz-binding|-ms-behavior)$/;
// Anything that can fetch, execute, or hide a fetch behind an escape sequence.
const BAD_VALUE = /(url|image-set|image|src|element|cross-fade|expression|paint)\s*\(|javascript:|vbscript:|@import|data:|\\|<|>|[{}]/i;
const SELECTOR = /^[\w\s.#:>+~*,[\]="'^$|()%-]{1,240}$/;
const MEDIA = /^@media[\s\w:()<>=,.\/%-]{1,160}$/;
const KEYFRAMES = /^@(-webkit-)?keyframes\s+[A-Za-z0-9_-]{1,40}$/;
const KEYFRAME_STEP = /^(from|to|\d{1,3}(\.\d+)?%)(\s*,\s*(from|to|\d{1,3}(\.\d+)?%))*$/;

function scan(src) {
  const blocks = [];
  let cur = '', depth = 0, quote = '', prelude = '';
  const skipped = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { cur += ch; if (ch === quote && src[i - 1] !== '\\') quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ';' && depth === 0) { if (cur.trim()) skipped.push(cur.trim().slice(0, 40)); cur = ''; continue; }
    if (ch === '{') { if (depth === 0) { prelude = cur.trim(); cur = ''; } else cur += ch; depth++; continue; }
    if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) { blocks.push({ prelude, body: cur }); cur = ''; } else cur += ch;
      continue;
    }
    cur += ch;
  }
  return { blocks, skipped };
}

function splitDecls(body) {
  const parts = [];
  let cur = '', paren = 0, quote = '';
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') paren++;
    if (ch === ')') paren = Math.max(0, paren - 1);
    if (ch === ';' && paren === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function cleanDecls(body, dropped) {
  const out = [];
  for (const raw of splitDecls(body)) {
    const i = raw.indexOf(':');
    if (i < 1) continue;
    const prop = raw.slice(0, i).trim().toLowerCase();
    let value = raw.slice(i + 1).trim();
    const important = /\s*!important$/i.test(value);
    if (important) value = value.replace(/\s*!important$/i, '');
    const bad = !PROP.test(prop) || BAD_PROP.test(prop) || !value || value.length > 300 || BAD_VALUE.test(value)
      || (prop === 'content' && !/^(""|''|none|normal)$/.test(value))
      || (prop === 'position' && /fixed/i.test(value))
      || (prop === 'z-index' && !(/^-?\d{1,3}$/.test(value) && Number(value) <= 30));
    if (bad) { dropped.add(prop.slice(0, 30)); continue; }
    out.push(`${prop}:${value}${important ? ' !important' : ''}`);
  }
  return out.join(';');
}

/** Rebuilds user CSS from the allowlist. Returns the safe sheet and what was removed. */
export function sanitizeCss(input) {
  const dropped = new Set();
  const src = String(input || '').replace(/\/\*[\s\S]*?\*\//g, '').slice(0, MAX_CSS);
  let rules = 0;

  const build = (text, nested) => {
    const { blocks, skipped } = scan(text);
    for (const s of skipped) dropped.add(s.split(/\s/)[0]);
    const out = [];
    for (const { prelude, body } of blocks) {
      if (++rules > MAX_RULES) { dropped.add('слишком много правил'); break; }
      if (prelude.startsWith('@')) {
        if (!nested && MEDIA.test(prelude)) {
          const inner = build(body, true);
          if (inner) out.push(`${prelude}{${inner}}`);
        } else if (!nested && KEYFRAMES.test(prelude)) {
          const steps = scan(body).blocks
            .filter((b) => KEYFRAME_STEP.test(b.prelude))
            .map((b) => `${b.prelude}{${cleanDecls(b.body, dropped)}}`);
          if (steps.length) out.push(`${prelude}{${steps.join('')}}`);
        } else dropped.add(prelude.split(/[\s(]/)[0]);
        continue;
      }
      if (!SELECTOR.test(prelude)) { dropped.add('селектор'); continue; }
      const decls = cleanDecls(body, dropped);
      if (decls) out.push(`${prelude}{${decls}}`);
    }
    return out.join('\n');
  };

  return { css: build(src, false), dropped: [...dropped].slice(0, 20) };
}

const paletteOf = (css) => ['paper', 'fog', 'line', 'mute', 'ink', 'accent']
  .map((n) => new RegExp(`--${n}\\s*:\\s*(#[0-9a-fA-F]{3,8})`).exec(css)?.[1])
  .filter(Boolean);

const texVars = (tex) => `:root{${tex.map((d, i) => (d ? `--tex-${i + 1}:url("${d}");` : '')).join('')}}`;
const b64bytes = (dataUrl) => Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
const clip = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

const view = (r) => ({
  id: r.id, name: r.name, description: r.description, author: r.author_nick, authorId: r.author_id,
  palette: (() => { try { return JSON.parse(r.palette); } catch { return []; } })(),
  installs: r.installs, createdAt: r.created_at,
});

export async function handleThemes(request, env, { whoami, reply }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;
  const store = new Store(db);
  const who = request.headers.get('x-cheatlab-client') || request.headers.get('cf-connecting-ip') || 'anon';

  if (method === 'GET' && path === '/api/themes') {
    const order = url.searchParams.get('sort') === 'top' ? 'installs DESC, created_at DESC' : 'created_at DESC';
    const { results } = await db.prepare(
      `SELECT id, name, description, author_id, author_nick, palette, installs, created_at
         FROM theme WHERE status = 'approved' ORDER BY ${order} LIMIT 60`,
    ).all();
    return reply(200, { themes: results.map(view) });
  }

  if (method === 'POST' && path === '/api/themes/sanitize') {
    if (!(await store.throttle(`theme-san:${who}`, 'write', { cap: 90, windowMs: 60_000 }))) return reply(429, { error: 'slow down' });
    const body = await request.json().catch(() => ({}));
    const { css, dropped } = sanitizeCss(body.css);
    return reply(200, { css, dropped });
  }

  if (method === 'POST' && path === '/api/themes') {
    const user = await whoami(request);
    if (!user) return reply(401, { error: 'login required' });
    if (!(await store.throttle(`theme-new:${user.id}`, 'write', { cap: 20, windowMs: 3_600_000 }))) return reply(429, { error: 'slow down' });
    const raw = await request.text();
    if (raw.length > 700_000) return reply(413, { error: 'theme too large' });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: 'bad json' }); }

    const name = clip(body.name, 60);
    if (name.length < 2) return reply(400, { error: 'name is required' });
    const description = clip(body.description, 200);

    const tex = [0, 1, 2].map((i) => {
      const d = body.textures?.[i];
      return typeof d === 'string' && d.length <= MAX_TEX_CHARS && DATA_URL.test(d) ? d : '';
    });

    const { css: userCss, dropped } = sanitizeCss(body.css);
    if (!userCss) return reply(400, { error: 'empty theme', dropped });

    // One daily budget, counted from the table so it survives isolate restarts.
    const today = await db.prepare('SELECT COUNT(*) AS n FROM theme WHERE author_id = ? AND created_at > ?')
      .bind(user.id, now() - 86_400_000).first();
    if (Number(today?.n) >= THEMES_PER_DAY) return reply(429, { error: `limit ${THEMES_PER_DAY} designs per day` });

    // Every part a person can write is moderated: the words, and each texture.
    const verdicts = [await moderateText(env, `${name}\n${description}`)];
    for (const d of tex) if (d) verdicts.push(await moderateImage(env, b64bytes(d)));
    const bad = verdicts.filter((v) => !v.ok);
    if (bad.length) return reply(422, rejection({ reasons: bad.flatMap((v) => v.reasons) }));

    const css = `${texVars(tex)}\n${userCss}`;
    const id = newId(8);
    const scanned = verdicts.every((v) => v.source !== 'unscanned');
    await db.prepare(
      `INSERT INTO theme (id, author_id, author_nick, name, description, css, palette, status, mod_note, installs, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, 0, ?)`,
    ).bind(id, user.id, user.nick, name, description, css, JSON.stringify(paletteOf(css)), scanned ? 'ai' : 'rules-only', now()).run();
    return reply(201, { theme: { id, name }, dropped, moderation: scanned ? 'ai' : 'rules-only' });
  }

  const one = /^\/api\/themes\/([A-Za-z0-9]{4,16})(\/install)?$/.exec(path);
  if (one) {
    const id = one[1];
    const row = await db.prepare('SELECT * FROM theme WHERE id = ?').bind(id).first();
    if (!row) return reply(404, { error: 'not found' });

    if (method === 'GET' && !one[2]) {
      if (row.status !== 'approved') {
        const user = await whoami(request);
        if (!user || user.id !== row.author_id) return reply(404, { error: 'not found' });
      }
      return reply(200, { theme: { ...view(row), css: row.css } });
    }
    if (method === 'POST' && one[2]) {
      if (row.status === 'approved' && (await store.throttle(`theme-inst:${who}:${id}`, 'write', { cap: 1, windowMs: 3_600_000 }))) {
        await db.prepare('UPDATE theme SET installs = installs + 1 WHERE id = ?').bind(id).run();
      }
      return reply(200, { ok: true });
    }
    if (method === 'DELETE' && !one[2]) {
      const user = await whoami(request);
      if (!user) return reply(401, { error: 'login required' });
      const admins = String(env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (user.id !== row.author_id && !admins.includes(user.id)) return reply(403, { error: 'not yours' });
      await db.prepare('DELETE FROM theme WHERE id = ?').bind(id).run();
      return reply(200, { ok: true });
    }
  }
  return null;
}
