import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export class PluginHost {
  constructor(dir) {
    this.dir = dir;
    this.plugins = [];
    this.failed = [];
  }

  async load() {
    let entries = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return this;
    }

    for (const file of entries.filter((f) => f.endsWith('.mjs')).sort()) {
      const full = join(this.dir, file);
      try {
        const mod = await import(pathToFileURL(full).href);
        const plugin = mod.default || mod.plugin;
        if (!plugin || typeof plugin.name !== 'string' || typeof plugin.hooks !== 'object') {
          throw new Error('expected default export { name, hooks }');
        }
        this.plugins.push({ file, name: plugin.name, description: plugin.description || '', hooks: plugin.hooks });
      } catch (err) {
        this.failed.push({ file, error: err.message });
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

export function reject(reason) {
  const err = new Error(reason);
  err.code = 'REJECT';
  return err;
}
