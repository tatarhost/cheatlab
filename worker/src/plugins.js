export function reject(reason) {
  const err = new Error(reason);
  err.code = 'REJECT';
  return err;
}

/**
 * Static plugin registry.
 *
 * The original host scanned a directory on disk; Workers has no filesystem at
 * request time, so plugins are registered with static imports instead. The hook
 * contract is unchanged: a hook may return a replacement object, mutate nothing,
 * or throw `reject(reason)` to veto the operation.
 */
const REGISTRY = [
  { file: 'denylist.js', mod: () => import('../plugins/denylist.js') },
  { file: 'upload-guard.js', mod: () => import('../plugins/upload-guard.js') },
  { file: 'webhooks.js', mod: () => import('../plugins/webhooks.js') },
];

export class PluginHost {
  constructor() {
    this.plugins = [];
    this.failed = [];
  }

  async load(env) {
    for (const entry of REGISTRY) {
      try {
        const mod = await entry.mod();
        const plugin = mod.default || mod.plugin;
        if (!plugin || typeof plugin.name !== 'string' || typeof plugin.hooks !== 'object') {
          throw new Error('expected default export { name, hooks }');
        }
        const describe = typeof plugin.describe === 'function' ? plugin.describe(env) : plugin.description || '';
        this.plugins.push({ file: entry.file, name: plugin.name, description: describe, hooks: plugin.hooks });
      } catch (err) {
        this.failed.push({ file: entry.file, error: err.message });
      }
    }
    return this;
  }

  describe() {
    return {
      loaded: this.plugins.map((p) => ({ name: p.name, file: p.file, description: p.description, hooks: Object.keys(p.hooks) })),
      failed: this.failed,
    };
  }

  has(hook) {
    return this.plugins.some((p) => typeof p.hooks[hook] === 'function');
  }

  async run(hook, value, ctx = {}) {
    const rejections = [];
    let current = value;

    for (const plugin of this.plugins) {
      const fn = plugin.hooks[hook];
      if (typeof fn !== 'function') continue;
      try {
        const out = await fn(current, ctx);
        if (out && typeof out === 'object') current = out;
      } catch (err) {
        if (err && err.code === 'REJECT') {
          rejections.push({ plugin: plugin.name, reason: err.message || 'rejected' });
        } else {
          rejections.push({ plugin: plugin.name, reason: `plugin error: ${err.message}` });
        }
      }
    }

    return { value: current, rejections };
  }
}
