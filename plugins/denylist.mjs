import { reject } from '../lib/plugins.mjs';

const denyExt = new Set(
  String(process.env.CL_DENY_EXT || '')
    .split(',')
    .map((s) => s.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean),
);

const denySha = new Set(
  String(process.env.CL_DENY_SHA || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-f0-9]{64}$/.test(s)),
);

export default {
  name: 'denylist',
  description: `operator blocklist: ${denyExt.size} extensions, ${denySha.size} hashes`,

  hooks: {
    async 'file:upload'(file) {
      const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
      if (denyExt.has(ext)) throw reject(`.${ext} is blocked by the operator denylist`);
      return file;
    },

    async 'file:stored'(file) {
      if (denySha.has(file.sha256)) throw reject('payload blocked by hash denylist');
      return file;
    },
  },
};
