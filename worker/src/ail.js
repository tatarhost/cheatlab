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
