const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const enc = new TextEncoder();

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function newId(len = 10) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function newSecret() {
  const b = randomBytes(24);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const b of view) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export const secretHash = (secret) => sha256(enc.encode(String(secret)));

/** Constant-time compare, works on hex strings. */
export async function secretMatches(secret, expectedHash) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof expectedHash !== 'string' || expectedHash.length !== 64) return false;
  return hexEquals(await secretHash(secret), expectedHash);
}

/**
 * Constant-time comparison of two hashes that are *already* hashed.
 *
 * `secretMatches` hashes its first argument, so it cannot compare two digests -
 * doing that silently double-hashes one side and always fails. Signatures that
 * travel alongside their payload need this instead.
 */
export function hexEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authorTag(id) {
  return (await sha256(enc.encode(String(id)))).slice(0, 6);
}

export function normaliseClientId(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(v)) return null;
  return v;
}

export const now = () => Date.now();

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function str(v, max, fallback = '') {
  if (typeof v !== 'string') return fallback;
  const t = v.replace(/\u0000/g, '').trim();
  if (!t) return fallback;
  return t.length > max ? t.slice(0, max) : t;
}

export function tags(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    const s = str(t, 24).toLowerCase().replace(/[^a-z0-9_+#.-]/g, '');
    if (s && !out.includes(s)) out.push(s);
    if (out.length === 8) break;
  }
  return out;
}

const MIME = {
  '.lua': 'text/plain; charset=utf-8',
  '.luau': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.ts': 'text/javascript',
  '.html': 'text/plain',
  '.css': 'text/plain',
  '.yml': 'text/plain',
  '.yaml': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.bat': 'text/plain',
  '.ps1': 'text/plain',
  '.cfg': 'text/plain',
  '.ini': 'text/plain',
  '.toml': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'text/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
  '.jar': 'application/java-archive',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.pdf': 'application/pdf',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.so': 'application/octet-stream',
  '.dll': 'application/octet-stream',
  '.exe': 'application/octet-stream',
};

export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  if (i < 1) return '';
  return String(name).slice(i).toLowerCase().slice(0, 12);
}

export const mimeOf = (name) => MIME[extOf(name)] || 'application/octet-stream';

export function isTextExt(ext) {
  return /\.(lua|luau|txt|md|json|py|js|ts|html|css|yml|yaml|sh|bat|ps1|cfg|ini|toml|log|csv|xml|glsl|frag|vert|compute)$/.test(ext);
}

export const isImage = (mime) => /^image\//.test(mime);
export const isVideo = (mime) => /^video\//.test(mime);
export const isAudio = (mime) => /^audio\//.test(mime);

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function safeFilename(raw) {
  const base = String(raw || 'file')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '_')
    .trim();
  return (base || 'file').slice(0, 120);
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
