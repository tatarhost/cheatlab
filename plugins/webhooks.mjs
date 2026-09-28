const target = process.env.CL_WEBHOOK_URL || '';

async function post(payload) {
  if (!target) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
  } finally {
    clearTimeout(timer);
  }
}

export default {
  name: 'webhooks',
  description: target ? `posts new items to ${new URL(target).host}` : 'idle (set CL_WEBHOOK_URL to enable)',

  hooks: {
    async 'item:published'(item, ctx) {
      const base = ctx.req?.headers?.origin || `http://${ctx.req?.headers?.host || 'localhost'}`;
      void post({
        event: 'item.published',
        id: item.id,
        type: item.type,
        title: item.title,
        tags: item.tags,
        author: item.author,
        files: item.files.length,
        url: `${base}/i/${item.id}`,
      });
      return item;
    },

    async 'item:delete'(item) {
      void post({ event: 'item.deleted', id: item.id, type: item.type, title: item.title });
      return item;
    },
  },
};
