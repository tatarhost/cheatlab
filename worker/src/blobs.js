/**
 * Content-addressed R2 blob store.
 *
 * Objects are keyed by sha256 so identical uploads cost one write no matter how
 * many posts reference them, and a delete only issues an R2 delete once the
 * last reference is gone.
 */
export class BlobStore {
  constructor(bucket) {
    this.bucket = bucket;
  }

  static key(sha) {
    return `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  }

  async head(sha) {
    return this.bucket.head(this.key(sha));
  }

  /**
   * Stores a buffer unless the exact content is already present.
   * Returns `{ sha, size, deduped }` so callers can report honestly.
   */
  async put(buffer, sha) {
    const key = BlobStore.key(sha);
    const existing = await this.bucket.head(key);
    if (existing) return { sha, size: existing.size, deduped: true };
    await this.bucket.put(key, buffer, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    return { sha, size: buffer.byteLength, deduped: false };
  }

  /**
   * Range read, returned as a Response so streaming stays off the Workers heap.
   * Passing `{ range: request.headers }` lets R2 honour the client Range header
   * directly, which is what video scrubbing needs.
   */
  async get(sha, { range, onlyIf } = {}) {
    const opts = {};
    if (range) opts.range = range;
    if (onlyIf) opts.onlyIf = onlyIf;
    return this.bucket.get(BlobStore.key(sha), opts);
  }

  async remove(sha) {
    await this.bucket.delete(BlobStore.key(sha));
  }
}
