/**
 * MCP device pairing and owner approval tests.
 */
import { makeEnv, call } from './harness.mjs';
import worker from '../src/index.js';
import { Store } from '../src/store.js';
import { hashPassword, newUserId, newSession, nickKey, SESSION_TTL_MS } from '../src/accounts.js';

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
async function createAccount(env, nick, client = 'testclient0123456789abcdef') {
  const store = new Store(env.DB);
  const password = await hashPassword('Tr0ub4dor-and-3-ducks');
  const user = await store.createUser({
    id: newUserId(), nick, nickKey: nickKey(nick),
    passHash: password.passHash, passSalt: password.passSalt, iterations: password.iterations,
  });
  const issued = await newSession();
  const createdAt = Date.now();
  await store.createSession({
    tokenHash: issued.tokenHash, userId: user.id, createdAt,
    expiresAt: createdAt + SESSION_TTL_MS, clientId: client, userAgent: 'MCP tests',
  });
  return { user, token: issued.token, client };
}
function agentOpts(secret) {
  return { headers: { 'x-cheatlab-mcp-secret': secret } };
}

await t('MCP server requires a signed-in owner and returns its secret once', async (env) => {
  const anon = await call(worker, env, '/api/mcp/servers', { method: 'POST', body: { name: 'Desk' } });
  check('anonymous creation refused', anon.status === 401);
  const reg = await createAccount(env, 'mcpowner');
  check('test account session created', typeof reg.token === 'string');
  const created = await call(worker, env, '/api/mcp/servers', {
    method: 'POST', session: reg.token, body: { name: 'Домашний ПК' },
  });
  check('server created', created.status === 201, created.text);
  check('secret has strong format', /^mcp_[A-Za-z0-9_-]{32}$/.test(created.json?.secret || ''));
  const listed = await call(worker, env, '/api/mcp/servers', { session: reg.token });
  check('server listed', listed.json?.servers?.length === 1);
  check('list never reveals secret', !JSON.stringify(listed.json).includes(created.json.secret));
});

await t('remote MCP endpoint implements JSON-RPC and exposes only the owner own publications', async (env) => {
  const reg = await createAccount(env, 'mcpremote');
  const created = await call(worker, env, '/api/mcp/servers', {
    method: 'POST', session: reg.token, body: { name: 'Remote MCP' },
  });
  check('remote endpoint URL returned', typeof created.json?.remoteUrl === 'string' && created.json.remoteUrl.includes('/mcp/'));
  check('remote secret is strong', /^mcpr_[A-Za-z0-9_-]{32}$/.test(created.json?.remoteSecret || ''));
  const secret = created.json.remoteSecret;
  const path = new URL(created.json.remoteUrl).pathname;

  const denied = await call(worker, env, path.replace(secret, 'mcpr_' + 'A'.repeat(32)), {
    method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  });
  check('wrong remote token is refused', denied.status === 401);

  const init = await call(worker, env, path, {
    method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  });
  check('initialize succeeds', init.status === 200 && init.json?.result?.serverInfo?.name === 'CHEATLAB MCP');

  const tools = await call(worker, env, path, {
    method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  });
  check('read-only tools are listed', tools.json?.result?.tools?.some(tool => tool.name === 'cheatlab_read_my_publication'));

  await env.DB.prepare(
    'INSERT INTO items (id, type, title, body, language, tags, author, author_label, secret_hash, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind('mcpitem1', 'paste', 'Private owner note', 'Text only for the owner.', 'text', 'mcp,test', reg.user.nick, reg.user.nick, 'test-secret-hash', 'unlisted', Date.now(), Date.now()).run();
  await env.DB.prepare('INSERT INTO item_owner (item_id, user_id, bound_at) VALUES (?, ?, ?)')
    .bind('mcpitem1', reg.user.id, Date.now()).run();

  const list = await call(worker, env, path, {
    method: 'POST', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cheatlab_list_my_publications', arguments: {} } },
  });
  check('owner publication appears in tool output', list.json?.result?.content?.[0]?.text?.includes('mcpitem1'));

  const read = await call(worker, env, path, {
    method: 'POST', body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cheatlab_read_my_publication', arguments: { id: 'mcpitem1' } } },
  });
  check('owner can read publication body', read.json?.result?.content?.[0]?.text?.includes('Text only for the owner.'));

  const stranger = await createAccount(env, 'mcpnotowner');
  const notOwned = await call(worker, env, path, {
    method: 'POST', body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cheatlab_read_my_publication', arguments: { id: 'otheritem' } } },
  });
  check('tool returns controlled error for non-owned publication', notOwned.json?.result?.isError === true);

  const remoteListed = await call(worker, env, '/api/mcp/servers', { session: reg.token });
  check('remote secret is never returned by account listing', !JSON.stringify(remoteListed.json).includes(secret));
  check('remote endpoint usage is recorded', Number(remoteListed.json?.servers?.[0]?.remoteLastUsedAt) > 0);

  const rotated = await call(worker, env, '/api/mcp/servers/' + created.json.server.id + '/remote-key', {
    method: 'POST', session: reg.token,
  });
  check('owner can rotate remote endpoint', rotated.status === 201 && rotated.json?.remoteUrl !== created.json.remoteUrl);
  const oldToken = await call(worker, env, path, {
    method: 'POST', body: { jsonrpc: '2.0', id: 6, method: 'ping' },
  });
  check('rotated endpoint immediately invalidates old URL', oldToken.status === 401);
});
await t('every PC process waits for explicit site approval and can be revoked', async (env) => {
  const reg = await createAccount(env, 'mcppair');
  const owner = reg.token;
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
  const strangerClient = 'otherclient0987654321abcdef';
  const stranger = await createAccount(env, 'mcpstranger', strangerClient);
  const wrongOwner = await call(worker, env, '/api/mcp/connections/' + id + '/approve', {
    method: 'POST', session: stranger.token, client: strangerClient,
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
  const reg = await createAccount(env, 'mcprevoke');
  const server = await call(worker, env, '/api/mcp/servers', {
    method: 'POST', session: reg.token, body: { name: 'PC' },
  });
  const secret = server.json.secret;
  const conn = await call(worker, env, '/api/mcp/agent/connect', {
    method: 'POST', body: { deviceName: 'Laptop' }, ...agentOpts(secret),
  });
  await call(worker, env, '/api/mcp/connections/' + conn.json.connectionId + '/approve', {
    method: 'POST', session: reg.token,
  });
  const deleted = await call(worker, env, '/api/mcp/servers/' + server.json.server.id, {
    method: 'DELETE', session: reg.token,
  });
  check('server revoked', deleted.json?.ok === true);
  const status = await call(worker, env, '/api/mcp/agent/status/' + conn.json.connectionId, agentOpts(secret));
  check('server revocation disables session', status.json?.status === 'revoked');
  const reconnect = await call(worker, env, '/api/mcp/agent/connect', {
    method: 'POST', body: { deviceName: 'Laptop' }, ...agentOpts(secret),
  });
  check('revoked secret cannot reconnect', reconnect.status === 401);
});


await t('remote MCP can call only read-only tools on an explicitly approved PC agent', async (env) => {
  const reg = await createAccount(env, 'mcppctunnel');
  const server = await call(worker, env, '/api/mcp/servers', {
    method: 'POST', session: reg.token, body: { name: 'Approved PC' },
  });
  const secret = server.json.secret;
  const endpoint = new URL(server.json.remoteUrl).pathname;
  const created = await call(worker, env, '/api/mcp/agent/connect', {
    method: 'POST', body: { deviceName: 'Test Windows PC', platform: 'Windows', pythonVersion: '3.12' },
    ...agentOpts(secret),
  });
  const connectionId = created.json.connectionId;
  const tools = await call(worker, env, endpoint, {
    method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  check('PC exposes only named safe read tools', ['pc_get_system_info','pc_list_shared_files','pc_read_shared_file']
    .every(name => tools.json?.result?.tools?.some(tool => tool.name === name)));
  const noApproval = await call(worker, env, endpoint, {
    method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pc_get_system_info', arguments: {} } },
  });
  check('PC tool refuses pending connection', noApproval.json?.result?.isError === true);

  const approved = await call(worker, env, '/api/mcp/connections/' + connectionId + '/approve', {
    method: 'POST', session: reg.token,
  });
  check('owner approves PC link', approved.status === 200);
  const callPromise = call(worker, env, endpoint, {
    method: 'POST', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pc_get_system_info', arguments: {} } },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  const claimed = await call(worker, env, '/api/mcp/agent/next/' + connectionId, {
    method: 'POST', body: {}, ...agentOpts(secret),
  });
  check('approved agent receives queued PC job', claimed.status === 200 && claimed.json?.job?.tool === 'pc_get_system_info');
  const returned = await call(worker, env, '/api/mcp/agent/result/' + connectionId + '/' + claimed.json.job.id, {
    method: 'POST', body: { result: { computer_name: 'TEST-PC', system: 'Windows' } }, ...agentOpts(secret),
  });
  check('agent can return read-only tool result', returned.status === 200 && returned.json?.ok);
  const response = await callPromise;
  check('remote MCP receives PC result through tunnel', response.json?.result?.content?.[0]?.text?.includes('TEST-PC'));

  const traversal = await call(worker, env, endpoint, {
    method: 'POST', body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'pc_read_shared_file', arguments: { name: '..\\\\secret.txt' },
    } },
  });
  check('PC file tool rejects path traversal without contacting device', traversal.json?.result?.isError === true);

  const rotated = await call(worker, env, '/api/mcp/servers/' + server.json.server.id + '/pc-key', {
    method: 'POST', session: reg.token,
  });
  check('owner can rotate PC pairing code', rotated.status === 201 && /^mcp_[A-Za-z0-9_-]{32}$/.test(rotated.json?.secret || ''));
  const oldSecret = await call(worker, env, '/api/mcp/agent/status/' + connectionId, agentOpts(secret));
  check('rotating PC code revokes prior agent secret', oldSecret.status === 401);
});

if (fail) {
  console.error('MCP tests: ' + pass + ' passed, ' + fail + ' failed\n' + failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('MCP tests: ' + pass + ' passed, 0 failed');
}
