import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function newId(len = 10) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function newSecret() {
  return randomBytes(24).toString('base64url');
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function secretHash(secret) {
  return sha256(Buffer.from(String(secret)));
}

export function secretMatches(secret, expectedHash) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const a = Buffer.from(secretHash(secret));
  const b = Buffer.from(expectedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function normaliseClientId(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(v)) return null;
  return v;
}

export function now() {
  return Date.now();
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

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
  '.tsconfig': 'text/plain',
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
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
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
};

export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  if (i < 1) return '';
  return String(name).slice(i).toLowerCase().slice(0, 12);
}

export function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

export function isTextExt(ext) {
  return /\.(lua|luau|txt|md|json|py|js|ts|html|css|yml|yaml|sh|bat|ps1|cfg|ini|toml|log|csv|xml|glsl|frag|vert|compute)$/.test(ext);
}

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
