import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export class BlobStore {
  constructor(root) {
    this.root = root;
    this.kind = 'local-disk';
  }

  pathFor(sha) {
    return join(this.root, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  async put(readable, maxBytes) {
    const tmpDir = join(this.root, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

    const hash = createHash('sha256');
    let size = 0;
    let overflow = false;

    const counter = async function* (src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > maxBytes) {
          overflow = true;
          break;
        }
        hash.update(chunk);
        yield chunk;
      }
    };

    try {
      await pipeline(readable, counter, createWriteStream(tmp));
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }

    if (overflow) {
      await unlink(tmp).catch(() => {});
      const err = new Error('file too large');
      err.code = 'TOO_LARGE';
      err.maxBytes = maxBytes;
      throw err;
    }

    const sha = hash.digest('hex');
    const dest = this.pathFor(sha);

    try {
      await stat(dest);
      await unlink(tmp).catch(() => {});
      return { sha, size, deduped: true };
    } catch {
    }

    await mkdir(dirname(dest), { recursive: true });
    await rename(tmp, dest);
    return { sha, size, deduped: false };
  }

  async putBuffer(buf, maxBytes) {
    if (buf.length > maxBytes) {
      const err = new Error('file too large');
      err.code = 'TOO_LARGE';
      err.maxBytes = maxBytes;
      throw err;
    }
    return this.put((async function* () { yield buf; })(), maxBytes);
  }

  createReadStream(sha, range) {
    return createReadStream(this.pathFor(sha), range || undefined);
  }

  async readBuffer(sha) {
    return readFile(this.pathFor(sha));
  }

  async remove(sha) {
    await unlink(this.pathFor(sha)).catch(() => {});
  }
}
