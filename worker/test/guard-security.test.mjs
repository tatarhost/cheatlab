import { makeEnv, request } from './harness.mjs';
import guardedWorker from '../src/guard.js';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else { failed++; console.error('FAIL:', name, detail); }
}

{
  const env = makeEnv();
  const res = await guardedWorker.fetch(request('/api/themes/sanitize', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: { css: 'body { color: red; }' },
  }), env);
  check('unlisted origin receives no CORS permission', !res.headers.has('Access-Control-Allow-Origin'));
}

{
  const env = makeEnv();
  const res = await guardedWorker.fetch(request('/api/themes/sanitize', {
    method: 'POST',
    headers: { Origin: 'https://cheatlab.fun' },
    body: { css: 'body { color: red; }' },
  }), env);
  check('listed origin receives exact CORS permission', res.headers.get('Access-Control-Allow-Origin') === 'https://cheatlab.fun');
}

{
  const env = makeEnv({
    AI: { run: async () => { throw new Error('simulated AI outage'); } },
  });
  const res = await guardedWorker.fetch(request('/api/items', {
    method: 'POST',
    headers: { Origin: 'https://cheatlab.fun' },
    body: { type: 'paste', title: 'Moderation outage test', body: 'This content is long enough to invoke AI moderation.' },
  }), env);
  check('moderation outage blocks publishing', res.status === 503, `got ${res.status}`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
