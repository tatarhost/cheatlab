import { newId, newSecret, secretHash, now, str } from './util.js';
import { sessionValid, adminOf } from './accounts.js';

const DAY = 24 * 60 * 60 * 1000;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

async function sessionActor(request, env) {
  const token = request.headers.get('x-cheatlab-session') || '';
  const client = request.headers.get('x-cheatlab-client') || '';
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token) || !/^[A-Za-z0-9_-]{16,64}$/.test(client)) return null;
  const tokenHash = await secretHash(token);
  const row = await env.STORE.getSession(tokenHash);
  if (!(await sessionValid(row, client))) return null;
  const user = await env.STORE.getUser(row.user_id);
  if (!user) return null;
  const ban = await env.STORE.activeBan(user.id);
  if (ban) return { error: fail(403, 'account is banned', { reason: ban.reason || '', until: ban.until_at }) };
  return { user, admin: adminOf(env, user.id), via: 'session' };
}

async function actor(request, env) {
  const signed = await sessionActor(request, env);
  if (signed) return signed;
  const raw = request.headers.get('x-ail-api-key') || '';
  if (!/^ail_[A-Za-z0-9_-]{24,100}$/.test(raw)) return null;
  const hash = await secretHash(raw);
  const row = await env.DB.prepare(
    `SELECT k.id AS key_id, k.user_id, k.expires_at, u.id, u.nick
       FROM ail_api_keys k JOIN user u ON u.id = k.user_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL LIMIT 1`,
  ).bind(hash).first();
  if (!row) return null;
  const user = await env.STORE.getUser(row.user_id);
  if (!user) return null;
  const isAdmin = adminOf(env, user.id);
  if (!isAdmin && Number(row.expires_at || 0) <= now()) return null;
  const ban = await env.STORE.activeBan(user.id);
  if (ban) return { error: fail(403, 'account is banned') };
  env.waitUntil?.(env.DB.prepare('UPDATE ail_api_keys SET last_used_at = ? WHERE id = ?').bind(now(), row.key_id).run().catch(() => {}));
  return { user, admin: isAdmin, via: 'api_key' };
}

async function readPayload(request, limit = 24_000) {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > limit) throw new Error('request too large');
  return raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : {};
}

function equalSecret(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function trainingStatus(env) {
  const latest = await env.DB.prepare(
    'SELECT * FROM ail_training_sessions ORDER BY created_at DESC LIMIT 1'
  ).first().catch(() => null);
  const recent = await env.DB.prepare(
    'SELECT id, run_id, status, parameters, total_steps, session_steps, train_loss, validation_loss, best_validation_loss, elapsed_seconds, compute, created_at FROM ail_training_sessions ORDER BY created_at DESC LIMIT 30'
  ).all().catch(() => ({ results: [] }));
  const sessions = (recent.results || []).map(x => ({
    id: x.id, runId: x.run_id, status: x.status, parameters: x.parameters,
    totalSteps: x.total_steps, sessionSteps: x.session_steps, trainLoss: x.train_loss,
    validationLoss: x.validation_loss, bestValidationLoss: x.best_validation_loss,
    elapsedSeconds: x.elapsed_seconds, compute: x.compute, createdAt: x.created_at,
  }));
  return {
    status: latest?.status || 'not_started',
    connected: !!latest,
    message: latest ? (latest.status === 'training' ? 'Обучение идёт сейчас: метрики поступают из активной сессии.' : latest.status === 'session_failed' ? 'Последняя сессия завершилась с ошибкой.' : 'Последняя сессия обучения зарегистрирована в Cloudflare.') : 'Ожидание первой регистрации сессии обучения.',
    progress: null,
    step: Number(latest?.total_steps || 0),
    loss: latest?.validation_loss ?? null,
    latest: sessions[0] || null,
    sessions,
    targetParameters: 1_000_000_000,
  };
}

export async function handleAil(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;


  // MCP PC bridge: secrets are issued once, then stored only as SHA-256 hashes.
  if (method === 'POST' && path === '/api/mcp/servers') {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    let payload;
    try { payload = await readPayload(request, 2048); } catch { return fail(400, 'invalid json'); }
    const name = str(payload.name, 40, 'Мой компьютер').replace(/[\\r\\n\\t]/g, ' ').trim() || 'Мой компьютер';
    const id = newId(12);
    const secret = 'mcp_' + newSecret();
    const createdAt = now();
    try {
      await env.DB.prepare(
        'INSERT INTO mcp_servers (id, user_id, name, secret_hash, secret_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(id, who.user.id, name, await secretHash(secret), secret.slice(0, 12), createdAt).run();
    } catch (error) {
      if (/MCP server limit/i.test(String(error?.message || error))) return fail(409, 'Можно создать не более пяти MCP-подключений.');
      throw error;
    }
    return json({ secret, server: { id, name, prefix: secret.slice(0, 12), createdAt } }, 201);
  }

  if (method === 'GET' && path === '/api/mcp/servers') {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    const rows = await env.DB.prepare(
      "SELECT s.id, s.name, s.secret_prefix, s.created_at, s.revoked_at, " +
      "(SELECT COUNT(*) FROM mcp_connections c WHERE c.server_id = s.id AND c.status = 'pending' AND c.expires_at > ?) AS pending_count, " +
      "(SELECT COUNT(*) FROM mcp_connections c WHERE c.server_id = s.id AND c.status = 'approved' AND c.last_seen_at > ?) AS online_count " +
      "FROM mcp_servers s WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 20"
    ).bind(now(), now() - 45_000, who.user.id).all();
    return json({ servers: (rows.results || []).map(row => ({
      id: row.id, name: row.name, prefix: row.secret_prefix, createdAt: row.created_at,
      revoked: !!row.revoked_at, pendingCount: Number(row.pending_count) || 0,
      onlineCount: Number(row.online_count) || 0,
    })) });
  }

  const serverConnections = /^\\/api\\/mcp\\/servers\\/([A-Za-z0-9_-]{8,24})\\/connections$/.exec(path);
  if (method === 'GET' && serverConnections) {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    const server = await env.DB.prepare('SELECT id FROM mcp_servers WHERE id = ? AND user_id = ?')
      .bind(serverConnections[1], who.user.id).first();
    if (!server) return fail(404, 'MCP server not found');
    await env.DB.prepare(
      "UPDATE mcp_connections SET status = 'expired' WHERE server_id = ? AND status = 'pending' AND expires_at <= ?",
    ).bind(server.id, now()).run();
    const rows = await env.DB.prepare(
      'SELECT id, device_name, platform, python_version, status, created_at, expires_at, approved_at, last_seen_at ' +
      'FROM mcp_connections WHERE server_id = ? ORDER BY created_at DESC LIMIT 40'
    ).bind(server.id).all();
    return json({ connections: (rows.results || []).map(row => ({
      id: row.id, deviceName: row.device_name, platform: row.platform, pythonVersion: row.python_version,
      status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
      approvedAt: row.approved_at, lastSeenAt: row.last_seen_at,
      online: row.status === 'approved' && Number(row.last_seen_at || 0) > now() - 45_000,
    })) });
  }

  const revokeServer = /^\\/api\\/mcp\\/servers\\/([A-Za-z0-9_-]{8,24})$/.exec(path);
  if (method === 'DELETE' && revokeServer) {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    const t = now();
    const result = await env.DB.prepare(
      'UPDATE mcp_servers SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ).bind(t, revokeServer[1], who.user.id).run();
    await env.DB.prepare(
      "UPDATE mcp_connections SET status = 'revoked', disconnected_at = ? WHERE server_id = ? AND status IN ('pending','approved')",
    ).bind(t, revokeServer[1]).run();
    return json({ ok: Number(result.meta?.changes || 0) > 0 });
  }

  const connectionAction = /^\\/api\\/mcp\\/connections\\/([A-Za-z0-9_-]{8,24})\\/(approve|deny)$/.exec(path);
  if (method === 'POST' && connectionAction) {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    const t = now();
    const next = connectionAction[2] === 'approve' ? 'approved' : 'denied';
    const timestampColumn = next === 'approved' ? 'approved_at' : 'disconnected_at';
    const result = await env.DB.prepare(
      "UPDATE mcp_connections SET status = ?, " + timestampColumn + " = ? " +
      "WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at > ? " +
      "AND EXISTS (SELECT 1 FROM mcp_servers s WHERE s.id = mcp_connections.server_id AND s.revoked_at IS NULL)"
    ).bind(next, t, connectionAction[1], who.user.id, t).run();
    if (!(Number(result.meta?.changes || 0) > 0)) return fail(409, 'Запрос уже обработан или истёк.');
    return json({ ok: true, status: next });
  }

  const revokeConnection = /^\\/api\\/mcp\\/connections\\/([A-Za-z0-9_-]{8,24})$/.exec(path);
  if (method === 'DELETE' && revokeConnection) {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    const result = await env.DB.prepare(
      "UPDATE mcp_connections SET status = 'revoked', disconnected_at = ? " +
      "WHERE id = ? AND user_id = ? AND status IN ('pending','approved')"
    ).bind(now(), revokeConnection[1], who.user.id).run();
    return json({ ok: Number(result.meta?.changes || 0) > 0 });
  }

  const agentSecret = request.headers.get('x-cheatlab-mcp-secret') || '';
  const agentServer = /^mcp_[A-Za-z0-9_-]{32}$/.test(agentSecret)
    ? await env.DB.prepare('SELECT id, user_id, revoked_at FROM mcp_servers WHERE secret_hash = ? LIMIT 1')
      .bind(await secretHash(agentSecret)).first()
    : null;

  if (method === 'POST' && path === '/api/mcp/agent/connect') {
    if (!agentServer || agentServer.revoked_at) return fail(401, 'invalid or revoked MCP secret');
    const allowed = await env.STORE.throttle('mcp-connect:' + agentServer.id, 'connect', { cap: 12, windowMs: 60_000 });
    if (!allowed) return fail(429, 'Слишком много попыток подключения.');
    let payload;
    try { payload = await readPayload(request, 2048); } catch { return fail(400, 'invalid json'); }
    const deviceName = str(payload.deviceName, 64, 'Новый компьютер').replace(/[\\r\\n\\t]/g, ' ');
    const platform = str(payload.platform, 40);
    const pythonVersion = str(payload.pythonVersion, 32);
    const id = newId(12);
    const createdAt = now();
    const expiresAt = createdAt + 5 * 60_000;
    await env.DB.prepare(
      "INSERT INTO mcp_connections (id, server_id, user_id, device_name, platform, python_version, status, created_at, expires_at, last_seen_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)"
    ).bind(id, agentServer.id, agentServer.user_id, deviceName, platform, pythonVersion, createdAt, expiresAt, createdAt).run();
    return json({ connectionId: id, status: 'pending', expiresAt }, 201);
  }

  const agentStatus = /^\\/api\\/mcp\\/agent\\/status\\/([A-Za-z0-9_-]{8,24})$/.exec(path);
  if (method === 'GET' && agentStatus) {
    if (!agentServer) return fail(401, 'invalid MCP secret');
    const row = await env.DB.prepare(
      'SELECT id, server_id, status, expires_at FROM mcp_connections WHERE id = ? AND server_id = ?',
    ).bind(agentStatus[1], agentServer.id).first();
    if (!row) return fail(404, 'connection not found');
    if (agentServer.revoked_at) {
      await env.DB.prepare(
        "UPDATE mcp_connections SET status = 'revoked', disconnected_at = ? WHERE id = ? AND status IN ('pending','approved')",
      ).bind(now(), row.id).run();
      return json({ status: 'revoked' });
    }
    if (row.status === 'pending' && Number(row.expires_at) <= now()) {
      await env.DB.prepare("UPDATE mcp_connections SET status = 'expired' WHERE id = ?").bind(row.id).run();
      return json({ status: 'expired' });
    }
    const allowed = await env.STORE.throttle('mcp-status:' + agentServer.id, 'heartbeat', { cap: 90, windowMs: 60_000 });
    if (!allowed) return fail(429, 'heartbeat rate limited');
    await env.DB.prepare('UPDATE mcp_connections SET last_seen_at = ? WHERE id = ?').bind(now(), row.id).run();
    return json({ status: row.status });
  }

  const agentDisconnect = /^\\/api\\/mcp\\/agent\\/disconnect\\/([A-Za-z0-9_-]{8,24})$/.exec(path);
  if (method === 'POST' && agentDisconnect) {
    if (!agentServer) return fail(401, 'invalid MCP secret');
    const result = await env.DB.prepare(
      "UPDATE mcp_connections SET status = 'disconnected', disconnected_at = ? " +
      "WHERE id = ? AND server_id = ? AND status IN ('pending','approved')"
    ).bind(now(), agentDisconnect[1], agentServer.id).run();
    return json({ ok: Number(result.meta?.changes || 0) > 0 });
  }

  if (method === 'POST' && path === '/api/ail/training/report') {
    const authorization = request.headers.get('authorization') || '';
    const supplied = authorization.replace(/^Bearer\s+/i, '').trim();
    // Do not assume a fixed GitHub token length; GitHub API verification below is authoritative.
    if (!supplied || /[\r\n\s]/.test(supplied)) {
      console.warn('[ail] missing Actions authorization header', JSON.stringify({ headerPresent: !!authorization, tokenLength: supplied.length }));
      return fail(401, 'GitHub Actions token required', { headerPresent: !!authorization, tokenLength: supplied.length });
    }
    let p;
    try { p = await readPayload(request, 12_000); } catch { return fail(400, 'invalid training report'); }
    const runId = str(p.run_id, 24);
    const status = ['training', 'session_completed', 'session_failed'].includes(p.status) ? p.status : '';
    if (!/^\d+$/.test(runId) || !status) return fail(400, 'run_id and a valid status are required');
    let run;
    try {
      const verify = await fetch('https://api.github.com/repos/tatarhost/cheatlab/actions/runs/' + runId, {
        headers: { Authorization: 'Bearer ' + supplied, Accept: 'application/vnd.github+json', 'User-Agent': 'CHEATLAB-AIL-Training' },
      });
      if (!verify.ok) return fail(401, 'GitHub run verification failed');
      run = await verify.json();
    } catch { return fail(502, 'could not verify GitHub Actions run'); }
    // Pin verification to the repository's AIL workflow ID. The workflow-run
    // API may expose path differently across token/API versions.
    const isAilWorkflow = Number(run?.workflow_id) === 412488269
      || run?.path === '.github/workflows/ail-cpu-training.yml';
    if (Number(run?.id) !== Number(runId)
      || !isAilWorkflow
      || run?.head_sha !== p.commit) {
      console.warn('[ail] rejected training report', JSON.stringify({
        runId: run?.id ?? null, workflowId: run?.workflow_id ?? null,
        path: run?.path ?? null, shaMatches: run?.head_sha === p.commit,
      }));
      return fail(403, 'run is not an authorized CHEATLAB AIL workflow', {
        verification: {
          requestedRunId: runId,
          verifiedRunId: run?.id ?? null,
          workflowId: run?.workflow_id ?? null,
          workflowPath: run?.path ?? null,
          commitMatches: run?.head_sha === p.commit,
        },
      });
    }
    const n = (v, max = 1e12) => Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Number(v))) : 0;
    const details = {
      workflow: str(p.workflow, 120), commit: str(p.commit, 80),
      note: str(p.note, 500), checkpoint_saved: p.checkpoint_saved === true,
      next_session_requested: p.next_session_requested === true,
    };
    await env.DB.prepare(
      `INSERT INTO ail_training_sessions
       (id, run_id, status, parameters, total_steps, session_steps, train_loss, validation_loss,
        best_validation_loss, elapsed_seconds, compute, initialized_from_random_weights,
        pretrained_model_used, created_at, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, parameters=excluded.parameters,
        total_steps=excluded.total_steps, session_steps=excluded.session_steps,
        train_loss=excluded.train_loss, validation_loss=excluded.validation_loss,
        best_validation_loss=excluded.best_validation_loss, elapsed_seconds=excluded.elapsed_seconds,
        created_at=excluded.created_at, details_json=excluded.details_json`
    ).bind(
      newId(12), runId, status, n(p.parameters), n(p.total_steps), n(p.session_steps),
      Number.isFinite(Number(p.train_loss)) ? n(p.train_loss) : null,
      Number.isFinite(Number(p.validation_loss)) ? n(p.validation_loss) : null,
      Number.isFinite(Number(p.best_validation_loss)) ? n(p.best_validation_loss) : null,
      n(p.elapsed_seconds), str(p.compute || 'GitHub Actions CPU', 80),
      p.initialized_from_random_weights === true ? 1 : 0,
      p.pretrained_model_used === true ? 1 : 0, now(), JSON.stringify(details),
    ).run();
    return json({ ok: true, recorded: true, runId, training: await trainingStatus(env) }, 201);
  }

  if (method === 'GET' && path === '/api/ail/status') {
    const training = await trainingStatus(env);
    return json({
      service: 'AIL AI',
      version: 'continuous-training-preview',
      targetParameters: 1_000_000_000,
      inference: {
        available: !!env.AI,
        provider: env.AI ? 'Cloudflare Workers AI' : null,
        model: env.AIL_INFERENCE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast',
        isAilTrainedModel: false,
      },
      training,
      updatedAt: now(),
    });
  }

  if (method === 'POST' && path === '/api/ail/chat') {
    const who = await actor(request, env);
    if (!who) return fail(401, 'Войдите в CHEATLAB или передайте x-ail-api-key.');
    if (who.error) return who.error;
    if (!env.AI) return fail(503, 'Workers AI binding is not available');
    const allowed = await env.STORE.throttle(`ail:${who.user.id}`, 'ai', { cap: 30, windowMs: 60_000 });
    if (!allowed) return fail(429, 'Слишком много запросов. Подождите минуту.');
    let payload;
    try { payload = await readPayload(request); }
    catch { return fail(400, 'Некорректный или слишком большой запрос.'); }
    const message = str(payload.message, 12_000);
    if (!message) return fail(400, 'Введите сообщение.');
    const history = Array.isArray(payload.history) ? payload.history.slice(-10) : [];
    const messages = [
      { role: 'system', content: 'Ты — AIL AI, помощник CHEATLAB. Отвечай на русском или английском в зависимости от языка пользователя. Хорошо помогай с программированием и обычными вопросами. Не утверждай, что ты обученная собственная модель AIL: сейчас используется подключённая базовая модель Cloudflare Workers AI.' },
      ...history.filter(x => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string')
        .map(x => ({ role: x.role, content: x.content.slice(0, 8000) })),
      { role: 'user', content: message },
    ];
    const model = env.AIL_INFERENCE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
    try {
      const result = await env.AI.run(model, { messages, max_tokens: 1200, temperature: 0.35 });
      const answer = typeof result?.response === 'string' ? result.response
        : typeof result?.output_text === 'string' ? result.output_text
        : typeof result?.result?.response === 'string' ? result.result.response : '';
      if (!answer) return fail(502, 'Модель вернула пустой ответ.');
      return json({ answer, model, provider: 'Cloudflare Workers AI', isAilTrainedModel: false });
    } catch (error) {
      const detail = String(error?.message || error || 'unknown inference error').slice(0, 500);
      console.error('[ail] inference failed', JSON.stringify({
        model, name: error?.name || 'Error', message: detail,
        status: error?.status || error?.statusCode || null,
        code: error?.code || null,
      }));
      return fail(502, 'Cloudflare Workers AI не смог выполнить запрос.', {
        model, reason: detail,
      });
    }
  }

  if (method === 'POST' && path === '/api/ail/keys') {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    let payload = {};
    try { payload = await readPayload(request, 2048); } catch { return fail(400, 'invalid json'); }
    const key = 'ail_' + newSecret();
    const id = newId(12);
    const createdAt = now();
    const expiresAt = who.admin ? null : createdAt + 10 * DAY;
    const label = str(payload.label || 'Мой API-ключ', 40);
    await env.DB.prepare(
      'INSERT INTO ail_api_keys (id, user_id, label, key_hash, key_prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, who.user.id, label, await secretHash(key), key.slice(0, 12), createdAt, expiresAt).run();
    return json({ key, item: { id, label, prefix: key.slice(0, 12), createdAt, expiresAt, unlimited: who.admin } }, 201);
  }

  if (method === 'GET' && path === '/api/ail/keys') {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    const rows = await env.DB.prepare(
      'SELECT id, label, key_prefix, created_at, expires_at, last_used_at, revoked_at FROM ail_api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    ).bind(who.user.id).all();
    return json({ keys: (rows.results || []).map(row => ({
      id: row.id, label: row.label, prefix: row.key_prefix, createdAt: row.created_at,
      expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revoked: !!row.revoked_at,
      unlimited: who.admin,
    })) });
  }

  const revoke = /^\/api\/ail\/keys\/([A-Za-z0-9_-]{8,24})$/.exec(path);
  if (method === 'DELETE' && revoke) {
    const who = await sessionActor(request, env);
    if (!who) return fail(401, 'login required');
    if (who.error) return who.error;
    const result = await env.DB.prepare(
      'UPDATE ail_api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ).bind(now(), revoke[1], who.user.id).run();
    return json({ ok: Number(result.meta?.changes || 0) > 0 });
  }

  return null;
}
