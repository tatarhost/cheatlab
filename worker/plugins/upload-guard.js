import { reject } from '../src/plugins.js';

/**
 * Rejects malformed upload names before any bytes are written to R2.
 *
 * Kept in the upload path (rather than relying on `safeFilename` alone) so the
 * rejection reason reaches the client verbatim.
 */
export default {
  name: 'upload-guard',
  description: 'rejects malformed upload names before any bytes are stored',

  hooks: {
    async 'file:upload'(file) {
      const name = file.name || '';
      if (name.length < 2) throw reject('filename missing');
      if (/[\\/]/.test(name) || name.includes('..')) throw reject('filename may not contain path characters');
      if (/[\u0000-\u001f\u007f]/.test(name)) throw reject('filename contains control characters');
      if (!name.includes('.')) throw reject('filename needs an extension');

      const ext = name.split('.').pop().toLowerCase();
      if (!/^[a-z0-9]{1,11}$/.test(ext)) throw reject('unusable file extension');

      return { ...file, name };
    },
  },
};
