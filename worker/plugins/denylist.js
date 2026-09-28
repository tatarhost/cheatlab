import { reject } from '../src/plugins.js';

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export default {
  name: 'denylist',
  description: 'operator blocklist, configured per environment',

  describe(env = {}) {
    const exts = list(env.DENY_EXT);
    const shas = list(env.DENY_SHA).filter((s) => /^[a-f0-9]{64}$/.test(s));
    return `operator blocklist: ${exts.length} extensions, ${shas.length} hashes`;
  },

  hooks: {
    async 'file:upload'(file, ctx = {}) {
      const denyExt = new Set(list(ctx.env?.DENY_EXT).map((s) => s.replace(/^\./, '')));
      const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
      if (denyExt.has(ext)) throw reject(`.${ext} is blocked by the operator denylist`);
      return file;
    },

    async 'file:stored'(file, ctx = {}) {
      const denySha = new Set(list(ctx.env?.DENY_SHA).filter((s) => /^[a-f0-9]{64}$/.test(s)));
      if (denySha.has(file.sha256)) throw reject('payload blocked by hash denylist');
      return file;
    },
  },
};
