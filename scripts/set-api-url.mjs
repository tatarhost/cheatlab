/**
 * Writes the API origin into public/index.html.
 *
 * The site is static and the API is a Worker on another host, so the browser
 * needs to be told where to send requests. This rewrites the single
 * `<meta name="cheatlab-api">` line instead of making the user find it.
 *
 *   node scripts/set-api-url.mjs https://cheatlab.example.workers.dev
 *   node scripts/set-api-url.mjs            # clears it back to same-origin
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'public', 'index.html');
const PATTERN = /(<meta\s+name="cheatlab-api"\s+content=")[^"]*(")/;

const raw = (process.argv[2] || '').trim().replace(/\/+$/, '');

if (raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.error(`not a valid absolute URL: ${raw}`);
    process.exit(1);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    console.error('the API origin must be https (or localhost during development)');
    process.exit(1);
  }
}

const source = readFileSync(INDEX, 'utf8');
if (!PATTERN.test(source)) {
  console.error('no <meta name="cheatlab-api"> found in public/index.html');
  process.exit(1);
}

writeFileSync(INDEX, source.replace(PATTERN, `$1${raw}$2`), 'utf8');
console.log(raw ? `cheatlab-api = ${raw}` : 'cheatlab-api cleared (same origin)');
