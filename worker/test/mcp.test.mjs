/**
 * MCP device pairing and owner approval tests.
 */
import { makeEnv, call } from './harness.mjs';
import worker from '../src/index.js';
import { solvePow } from '../src/abuse.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(name + (detail ? ' -- ' + detail : '')); }
}
async function t(name, fn) {
  const env = makeEnv();
  try { await fn(env); }
  catch (error) { fail++; failures.push(name + ' threw: ' + (error?.stack || error)); }
}
async function register(env, nick, client = 'testclient0123456789abcdef') {
  const challenge = await call(worker, env, '/api/auth/pow', { client });
  const nonce = await solvePow(challenge.json.challenge, env);
  return call(worker, env, '/api/auth/register', {
    method: 'POST', body: { nick, password: 'Tr0ub4dor-and-3-ducks' }, client,
    headers: { 'x-cheatlab-pow': challenge.json.challenge, 'x-cheatlab-pow-nonce': nonce },
  });
}
function agentOpts(secret) {
  return { headers: { 'x-cheatlab-mcp-secret': secret } };
}

await t('MCP server requires a signed-in owner and returns its secret once', async (env) => {
  const anon = await call(worker, env, '/api/mcp/servers', { method: 'POST', body: { name: 'Desk' } });
  check('anonymous creation refused', anon.status === 401);
  const reg = await register(env, 'mcpowner');
  check('account registered', reg.status === 201);
  const created = await call(worker, env, '/api/mcp/servers', {
    method: 'POST', session: reg.json.token, body: { name: 'Домашний ПК' },
  });
  check('server created', created.status === 201, created.text);
  check('secret has strong format', /^mcp_[A-Za-z0-9_-]{32}$/.test(created.json?.secret || ''));
  const listed = await call(worker, env, '/api/mcp/servers', { session: reg.json.token });
  check('server listed', listed.json?.servers?.length === 1);
  check('list never reveals secret', !JSON.stringify(listed.json).includes(created.json.secret));
});

await t('every PC process waits for explicit site approval and can be revoked', async (env) => {
  const reg = await register(env, 'mcppair');
  const owner = reg.json.token;
  const created = await call(worker, env, '/api/mcp/servers', {
    method: 'POST', session: owner, body: { name: 'Work PC' },
  });
  const secret = created.json.secret;
  const missing = await call(worker, env, '/api/mcp/agent/connect', {
    method: 'POST', body: { deviceName: 'PC' },
  });
  check('agent secret required', missing.status === 401);
  const connected = await call(worker, env, '/api/mcp/agent/connect', {
    method: 'POST', body: { deviceName: 'PC • Windows', platform: 'Windows', pythonVersion: '3.12' },
    ...agentOpts(secret),
  });
  check('new connection starts pending', connected.status === 201 && connected.json.status === 'pending');
  const id = connected.json.connectionId;
  const statusBefore = await call(worker, env, '/api/mcp/agent/status/' + id, agentOpts(secret));
  check('agent sees pending before approval', statusBefore.json?.status === 'pending');
  const stranger = await register(env, 'mcpstranger', 'otherclient0987654321abcdef');
  const wrongOwner = await call(worker, env, '/api/mcp/connections/' + id + '/approve', {
    method: 'POST', session: stranger.json.token,
  });
  check('another account cannot approve', wrongOwner.status === 409);
  const approved = await call(worker, env, '/api/mcp/connections/' + id + '/approve', {
    method: 'POST', session: owner,
  });
  check('owner can approve', approved.status === 200 && approved.json.status === 'approved');
  const statusAfter = await call(worker, env, '/api/mcp/agent/status/' + id, agentOpts(secret));
  check('agent sees owner approval', statusAfter.json?.status === 'approved');
  const rows = await call(worker, env, '/api/mcp/servers/' + created.json.server.id + '/connections', { session: owner });
  check('owner can monitor the session', rows.json?.connections?.[0]?.status === 'approved');
  const revoke = await call(worker, env, '/api/mcp/connections/' + id, { method: 'DELETE', session: owner });
  check('owner can disconnect the PC', revoke.status === 200 && revoke.json.ok);
  const statusRevoked = await call(worker, env, '/api/mcp/agent/status/' + id, agentOpts(secret));
  check('disconnected PC cannot remain approved', statusRevoked.json?.status === 'revoked');
});

await t('revoking a server disables every attached script', async (env) => {
  const reg = await register(env, 'mcprevoke');
  const server = await call(worker, env, '/api/mcp/servers', {
    method: 'POST', session: reg.json.token, body: { name: 'PC' },
  });
  const secret = server.json.secret;
  const conn = await call(worker, env, '/api/mcp/agent/connect', {
    method: 'POST', body: { deviceName: 'Laptop' }, ...agentOpts(secret),
  });
  await call(worker, env, '/api/mcp/connections/' + conn.json.connectionId + '/approve', {
    method: 'POST', session: reg.json.token,
  });
  const deleted = await call(worker, env, '/api/mcp/servers/' + server.json.server.id, {
    method: 'DELETE', session: reg.json.token,
  });
  check('server revoked', deleted.json?.ok === true);
  const status = await call(worker, env, '/api/mcp/agent/status/' + conn.json.connectionId, agentOpts(secret));
  check('server revocation disables session', status.json?.status === 'revoked');
  const reconnect = await call(worker, env, '/api/mcp/agent/connect', {
    method: 'POST', body: { deviceName: 'Laptop' }, ...agentOpts(secret),
  });
  check('revoked secret cannot reconnect', reconnect.status === 401);
});

if (fail) {
  console.error('MCP tests: ' + pass + ' passed, ' + fail + ' failed\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('MCP tests: ' + pass + ' passed, 0 failed');
}
