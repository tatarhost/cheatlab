function targetOf(env = {}) {
  const raw = env.WEBHOOK_URL || '';
  try {
    const url = new URL(raw);
    return url.protocol.startsWith('http') ? url.href : '';
  } catch {
    return '';
  }
}

async function post(payload, env) {
  const target = targetOf(env);
  if (!target) return;
  try {
    await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // delivery is best-effort and must never fail the request that triggered it
  }
}

export default {
  name: 'webhooks',
  description: 'idle by default (set WEBHOOK_URL to enable)',

  describe(env = {}) {
    const target = targetOf(env);
    return target ? `posts new items to ${new URL(target).host}` : 'idle (set WEBHOOK_URL to enable)';
  },

  hooks: {
    async 'item:published'(item, ctx = {}) {
      const site = String(ctx.env?.SITE_URL || '').replace(/\/+$/, '');
      void post({
        event: 'item.published',
        id: item.id,
        type: item.type,
        title: item.title,
        tags: item.tags,
        author: item.author,
        files: item.files.length,
        url: site ? `${site}/i/${item.id}` : null,
      }, ctx.env);
      return item;
    },

    async 'item:delete'(item, ctx = {}) {
      void post({ event: 'item.deleted', id: item.id, type: item.type, title: item.title }, ctx.env);
      return item;
    },
  },
};
