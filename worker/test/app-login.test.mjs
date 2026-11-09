import { makeEnv, call } from './harness.mjs';
import worker from '../src/index.js';
import { Store } from '../src/store.js';
import { newSession } from '../src/accounts.js';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
}

const env = makeEnv();
const store = new Store(env.DB);
const now = Date.now();
const userId = 'u_device_test01';
const webClient = 'cheatlab-web-client-0123456789';
const appClient = 'cheatlab-app-client-0123456789';
await store.createUser({
  id: userId,
  nick: 'deviceuser',
  nickKey: 'deviceuser',
  passHash: 'not-used-in-device-flow',
  passSalt: 'not-used-in-device-flow',
  iterations: 1000,
  email: 'device@example.test',
  emailVerified: true,
});
const browser = await newSession();
await store.createSession({
  tokenHash: browser.tokenHash,
  userId,
  createdAt: now,
  expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  clientId: webClient,
  userAgent: 'CHEATLAB test browser',
});

const init = await call(worker, env, '/api/app-auth/init', {
  method: 'POST', body: {}, client: appClient,
});
check('device initialization succeeds', init.status === 200, init.text);
check('device code is returned', typeof init.json?.deviceCode === 'string' && init.json.deviceCode.length > 20);
check('approval URL points to CHEATLAB',
  init.json?.verificationUrl?.startsWith('https://cheatlab.fun/app-authorize.html?device_code='),
  init.json?.verificationUrl);

const pending = await call(worker, env, '/api/app-auth/poll', {
  method: 'POST', body: { deviceCode: init.json?.deviceCode }, client: appClient,
});
check('app stays pending before browser approval', pending.status === 200 && pending.json?.status === 'pending', pending.text);

const wrongBrowser = await call(worker, env, '/api/app-auth/approve', {
  method: 'POST', body: { deviceCode: init.json?.deviceCode },
  client: 'other-browser-client-0123456789', session: browser.token,
});
check('browser session is bound to its original browser', wrongBrowser.status === 401, wrongBrowser.text);

const approved = await call(worker, env, '/api/app-auth/approve', {
  method: 'POST', body: { deviceCode: init.json?.deviceCode },
  client: webClient, session: browser.token,
});
check('signed-in CHEATLAB browser approves device', approved.status === 200 && approved.json?.ok === true, approved.text);

const redeemed = await call(worker, env, '/api/app-auth/poll', {
  method: 'POST', body: { deviceCode: init.json?.deviceCode }, client: appClient,
});
check('app redeems approved device code', redeemed.status === 200 && redeemed.json?.user?.nick === 'deviceuser', redeemed.text);
check('app receives its own session token', typeof redeemed.json?.token === 'string' && redeemed.json.token.length > 20);

const me = await call(worker, env, '/api/auth/me', {
  session: redeemed.json?.token, client: appClient,
});
check('saved app session authenticates as the approved user', me.status === 200 && me.json?.user?.nick === 'deviceuser', me.text);

const browserCannotUseAppToken = await call(worker, env, '/api/auth/me', {
  session: redeemed.json?.token, client: webClient,
});
check('app token cannot be replayed from the browser', browserCannotUseAppToken.status === 200 && browserCannotUseAppToken.json?.user === null, browserCannotUseAppToken.text);

const replay = await call(worker, env, '/api/app-auth/poll', {
  method: 'POST', body: { deviceCode: init.json?.deviceCode }, client: appClient,
});
check('device code is single-use', replay.status === 410, replay.text);

const failures = checks.filter((x) => !x.ok);
for (const item of checks) {
  process.stdout.write((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.detail ? ' — ' + item.detail : '') + '\\n');
}
process.stdout.write('\\n' + (checks.length - failures.length) + ' passed, ' + failures.length + ' failed\\n');
if (failures.length) process.exitCode = 1;
