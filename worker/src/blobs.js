import { cloudinaryReady, upload as cloudUpload, destroy as cloudDestroy } from './cloudinary.js';

/**
 * Largest value Workers KV accepts is 25 MiB. The cap here is one MiB lower, so a
 * file that passes this check still fits once KV has written its own metadata
 * around it, instead of failing at the write with an opaque provider error.
 */
export const KV_MAX_PUT_BYTES = 24 * 1024 * 1024;

/**
 * Content-addressed blob store.
 *
 * Objects are keyed by sha256 so identical uploads cost one write no matter how
 * many posts reference them, and a delete only issues one delete once the last
 * reference is gone.
 *
 * Bytes go to Cloudinary when its four secrets are set, and stay on Workers KV
 * when they are not. KV is the fallback rather than the default because it is
 * 1 GB for the whole project and 25 MiB per value, which no video survives, and
 * because it has no transform: resizing a 6000 px screenshot there means pulling
 * 6 MB into the Workers heap to throw most of it away. Cloudinary also means a
 * takedown can delete the asset itself instead of only the row pointing at it.
 *
 * The KV paths are kept exactly as they were, so the blobs already uploaded stay
 * readable and the shim shims off for files uploaded before the migration.
 */
export class BlobStore {
  constructor(env) {
    this.kv = env.BUCKET;
    this.env = env;
  }

  static key(sha) {
    return `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
  }

  /** True when new uploads should go to Cloudinary. */
  get remote() {
    return cloudinaryReady(this.env);
  }

  /**
   * The most bytes this store can actually take, right now.
   *
   * Cloudinary's own per-file cap is 100 MB, so there the binding limit is the
   * Worker's request body budget and nothing here matters. On KV the store's
   * ceiling is real and lower than the configured MAX_FILE_MB, so callers have to
   * ask this instead of assuming: an upload that is refused by the provider
   * mid-stream looks like a server fault, while a refusal before the read looks
   * like a limit.
   */
  get maxPutBytes() {
    return this.remote ? Infinity : KV_MAX_PUT_BYTES;
  }

  async exists(sha) {
    if (this.remote) return true; // content addressing: a digest that is listed is present
    const { keys } = await this.kv.list({ prefix: BlobStore.key(sha), limit: 1 });
    return keys.length > 0;
  }

  /**
   * Stores a buffer unless the exact content is already present.
   * Returns `{ sha, size, deduped }` so callers can report honestly, plus
   * `{ store, url, rid }` for a Cloudinary upload, which the D1 row needs.
   */
  async put(buffer, sha, { mime, name } = {}) {
    if (this.remote) {
      const sent = await cloudUpload(this.env, { bytes: buffer, sha, mime, name });
      return {
        sha, size: buffer.byteLength, deduped: false, store: 'cloudinary', url: sent.url, rid: sent.rid,
      };
    }
    if (await this.exists(sha)) return { sha, size: buffer.byteLength, deduped: true, store: 'kv', url: '', rid: '' };
    await this.kv.put(BlobStore.key(sha), buffer);
    return { sha, size: buffer.byteLength, deduped: false, store: 'kv', url: '', rid: '' };
  }

  /**
   * Range read on the KV path. The caller has already parsed and clamped the
   * Range header, so KV can serve the slice itself and the whole object is never
   * pulled into the Workers heap - that is what keeps video scrubbing cheap.
   * Returns null when the blob is missing.
   *
   * `store: 'cloudinary'` returns `{ url }` instead of a body: the bytes are on
   * Cloudinary's CDN and re-fetching them through the Worker would add a hop and
   * spend egress to copy bytes the browser can have directly.
   */
  async get(sha, { range, store = 'kv' } = {}) {
    if (store === 'cloudinary') return null;
    const key = BlobStore.key(sha);
    const opts = range ? { range, type: 'arrayBuffer' } : 'arrayBuffer';
    const body = await this.kv.get(key, opts);
    return body === null ? null : { body };
  }

  async remove(sha, store = 'kv', rid = '', url = '', mime = '') {
    if (store === 'cloudinary') {
      // The url and mime go with the rid because Cloudinary's destroy has to name
      // the resource type, and only the row knows which one the asset was stored
      // under. Without them the call cannot be built.
      //
      // A destroy that fails must not fail the delete. Once the row is gone the
      // asset is unreachable through the site whatever happens, and holding a
      // takedown hostage to Cloudinary's uptime would leave content the moderator
      // already removed visible in the feed. The cost of swallowing it is an
      // orphaned asset that costs storage and is listed by nobody; the cost of
      // not swallowing it is a moderation decision that does not take effect. The
      // orphan is also recoverable - the rid is in the D1 backup, and the file
      // can be destroyed by hand from the Cloudinary console.
      if (rid) {
        try {
          await cloudDestroy(this.env, rid, url, mime);
        } catch (err) {
          console.warn('cloudinary destroy failed for', rid, err?.message || err);
        }
      }
      return;
    }
    await this.kv.delete(BlobStore.key(sha));
  }

  /* --------------------------------------------------------------- avatars --
   * Not content-addressed, unlike files. An avatar is addressed by the id
   * already on the profile row, so putting a new one must overwrite that exact
   * key rather than accumulate a digest nobody references. The cost is that two
   * people uploading the same picture cost two writes, which is a rounding
   * error next to the 256px cap on the thing being uploaded.
   */

  static avatarKey(id) {
    return `avatars/${id}`;
  }

  async putAvatar(id, buffer) {
    await this.kv.put(BlobStore.avatarKey(id), buffer);
    return { size: buffer.byteLength };
  }

  async getAvatar(id) {
    const body = await this.kv.get(BlobStore.avatarKey(id), 'arrayBuffer');
    return body === null ? null : { body };
  }

  async removeAvatar(id) {
    await this.kv.delete(BlobStore.avatarKey(id));
  }

  /**
   * A small JSON cache that shares the KV namespace with the blobs.
   *
   * It lives here rather than being reached for through `this.kv` at the call
   * site because the alternative is every caller inventing its own key prefix
   * and TTL convention. Values are strings, not parsed objects, so a cache
   * poisoning bug cannot turn into an unexpected type downstream.
   */
  async kvGet(key) {
    return this.kv.get(key);
  }

  async kvPut(key, value, ttlSeconds) {
    await this.kv.put(key, value, { expirationTtl: ttlSeconds });
  }
}
