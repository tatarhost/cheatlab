/**
 * Content-addressed blob store on Workers KV.
 *
 * Objects are keyed by sha256 so identical uploads cost one write no matter how
 * many posts reference them, and a delete only issues one delete once the last
 * reference is gone.
 *
 * KV rather than R2 because KV ships with the free Workers plan, while R2 has
 * to be enabled in the dashboard behind a payment method. The cost is that KV
 * has no HEAD, so existence is answered with a prefix list, and that it is
 * eventually consistent - acceptable here because blobs are immutable and only
 * ever read through a path the caller has just verified in D1.
 *
 * Size is never read back: content addressing makes it redundant, since the
 * same digest always means the same byte length. The media routes take the
 * length from the D1 file row instead.
 */
export class BlobStore {
  constructor(kv) {
    this.kv = kv;
  }

  static key(sha) {
    return `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  }

  async exists(sha) {
    const { keys } = await this.kv.list({ prefix: BlobStore.key(sha), limit: 1 });
    return keys.length > 0;
  }

  /**
   * Stores a buffer unless the exact content is already present.
   * Returns `{ sha, size, deduped }` so callers can report honestly.
   */
  async put(buffer, sha) {
    if (await this.exists(sha)) return { sha, size: buffer.byteLength, deduped: true };
    await this.kv.put(BlobStore.key(sha), buffer);
    return { sha, size: buffer.byteLength, deduped: false };
  }

  /**
   * Range read. The caller has already parsed and clamped the Range header, so
   * KV can serve the slice itself and the whole object is never pulled into the
   * Workers heap - that is what keeps video scrubbing cheap.
   * Returns null when the blob is missing.
   */
  async get(sha, { range } = {}) {
    const key = BlobStore.key(sha);
    const opts = range ? { range, type: 'arrayBuffer' } : 'arrayBuffer';
    const body = await this.kv.get(key, opts);
    return body === null ? null : { body };
  }

  async remove(sha) {
    await this.kv.delete(BlobStore.key(sha));
  }
}
