/**
 * D1-backed store.
 *
 * Statement-for-statement port of the original `lib/store.mjs`, with the two
 * `node:sqlite` differences handled here:
 *   - every call is async and returns plain objects (D1 has no .get/.all/.run)
 *   - D1 refuses `SELECT *` inside a statement that also writes, so writes and
 *     reads stay in separate round trips
 */

const ITEM_FIELDS = new Set([
  'id', 'type', 'title', 'body', 'language', 'tags',
  'author', 'author_label', 'secret_hash', 'access_key_hash', 'key_hint',
  'visibility', 'created_at', 'updated_at',
]);

function mapFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemId: row.item_id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    author: row.author,
    downloads: row.downloads,
    createdAt: row.created_at,
  };
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  /**
   * D1's `.all()` resolves to `{results, success}` rather than a bare array, so
   * every method that wants rows unwraps it here. Returns [] rather than
   * undefined on an empty result, because callers map over it directly.
   */
  async rows(stmt, ...vals) {
    const r = await this.db.prepare(stmt).bind(...vals).all();
    return r?.results || [];
  }

  async createItem(item) {
    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(item)) {
      if (!ITEM_FIELDS.has(k)) continue;
      cols.push(k);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    await this.db
      .prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .bind(...vals)
      .run();
    return this.getItem(item.id);
  }

  async getItem(id) {
    return (await this.db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first()) || null;
  }

  async updateItem(id, patch) {
    const keys = Object.keys(patch).filter((k) => ITEM_FIELDS.has(k) && k !== 'id');
    if (!keys.length) return this.getItem(id);
    const sets = keys.map((k) => `${k} = ?`);
    await this.db
      .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...keys.map((k) => patch[k]), id)
      .run();
    return this.getItem(id);
  }

  async deleteItem(id) {
    const r = await this.db.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /* ------------------------------------------------------------- accounts */

  /**
   * Registration. The UNIQUE index on nick_key is the real guard against a
   * double-registration race: two concurrent requests can both pass a SELECT,
   * but only one INSERT can succeed. The caller turns the constraint error
   * into a friendly "nick taken" rather than a 500.
   */
  async createUser({ id, nick, nickKey, passHash, passSalt, iterations }) {
    const t = Date.now();
    await this.db
      .prepare(
        `INSERT INTO user (id, nick, nick_key, pass_hash, pass_salt, iterations, bio,
                           followers, following, posts, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 0, 0, 0, ?, ?)`,
      )
      .bind(id, nick, nickKey, passHash, passSalt, iterations, t, t)
      .run();
    return this.getUser(id);
  }

  async getUser(id) {
    if (!id) return null;
    return (await this.db.prepare('SELECT * FROM user WHERE id = ?').bind(id).first()) || null;
  }

  async getUserByNickKey(key) {
    if (!key) return null;
    return (await this.db.prepare('SELECT * FROM user WHERE nick_key = ?').bind(key).first()) || null;
  }

  /** Nick search for the "find friends" screen. Excludes self, newest first. */
  async searchUsers(q, { excludeId = '', limit = 20 } = {}) {
    const like = `%${String(q || '').toLowerCase()}%`;
    return this.rows(
      `SELECT id, nick, bio, followers, following, posts, created_at FROM user
        WHERE (LOWER(nick) LIKE ? OR nick_key LIKE ?)
          AND (? = '' OR id != ?)
        ORDER BY followers DESC, created_at DESC
        LIMIT ?`,
      like, like, excludeId, excludeId, Math.min(50, Math.max(1, limit)),
    );
  }

  async updateUser(id, patch) {
    const allowed = [
      'nick', 'nick_key', 'bio', 'pass_hash', 'pass_salt', 'iterations', 'last_seen_at',
      'logo', 'accent', 'bg',
    ];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return this.getUser(id);
    const sets = keys.map((k) => `${k} = ?`);
    await this.db
      .prepare(`UPDATE user SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...keys.map((k) => patch[k]), id)
      .run();
    return this.getUser(id);
  }

  async createSession(row) {
    await this.db
      .prepare(
        `INSERT INTO session (token_hash, user_id, created_at, expires_at, client_id, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.tokenHash, row.userId, row.createdAt, row.expiresAt, row.clientId, row.userAgent)
      .run();
  }

  async getSession(tokenHash) {
    if (!tokenHash) return null;
    return (await this.db.prepare('SELECT * FROM session WHERE token_hash = ?').bind(tokenHash).first()) || null;
  }

  async deleteSession(tokenHash) {
    await this.db.prepare('DELETE FROM session WHERE token_hash = ?').bind(tokenHash).run();
  }

  async touchSession(tokenHash) {
    const t = Date.now();
    await this.db
      .prepare('UPDATE session SET expires_at = ? WHERE token_hash = ?')
      .bind(t + 30 * 24 * 60 * 60 * 1000, tokenHash)
      .run();
  }

  /** Sign out everywhere, and drop expired rows on the way. */
  async deleteAllSessions(userId) {
    await this.db.prepare('DELETE FROM session WHERE user_id = ?').bind(userId).run();
  }

  async sweepSessions() {
    const r = await this.db.prepare('DELETE FROM session WHERE expires_at < ?').bind(Date.now()).run();
    return r.meta?.changes ?? 0;
  }

  /* ---------------------------------------------------------- item binding */

  /**
   * Attach an item to the account that owns it. Kept in its own table so the
   * original author/secret columns stay authoritative for existing rows.
   */
  async bindItem(itemId, userId) {
    await this.db
      .prepare('INSERT OR REPLACE INTO item_owner (item_id, user_id, bound_at) VALUES (?, ?, ?)')
      .bind(itemId, userId, Date.now())
      .run();
  }

  async ownerOfItem(itemId) {
    const row = await this.db.prepare('SELECT user_id FROM item_owner WHERE item_id = ?').bind(itemId).first();
    return row?.user_id || null;
  }

  async itemsOfUser(userId, { limit = 30, offset = 0 } = {}) {
    return this.rows(
      `SELECT i.* FROM items i
         JOIN item_owner o ON o.item_id = i.id
        WHERE o.user_id = ?
        ORDER BY i.created_at DESC
        LIMIT ? OFFSET ?`,
      userId, Math.min(50, Math.max(1, limit)), Math.max(0, offset),
    );
  }

  /* ------------------------------------------------------------- following */

  /**
   * Follow is idempotent by primary key. Returns false when the row already
   * existed, which the route uses to avoid double-counting.
   */
  async followUser(followerId, followeeId) {
    if (followerId === followeeId) return { ok: false, reason: 'self' };
    const t = Date.now();
    const r = await this.db
      .prepare('INSERT OR IGNORE INTO follow (follower, followee, created_at) VALUES (?, ?, ?)')
      .bind(followerId, followeeId, t)
      .run();
    const inserted = (r.meta?.changes ?? 0) > 0;
    if (inserted) {
      await this.recomputeFollowCounts(followerId, followeeId);
    }
    return { ok: inserted, reason: inserted ? 'ok' : 'already' };
  }

  async unfollowUser(followerId, followeeId) {
    const r = await this.db
      .prepare('DELETE FROM follow WHERE follower = ? AND followee = ?')
      .bind(followerId, followeeId)
      .run();
    if ((r.meta?.changes ?? 0) > 0) {
      await this.recomputeFollowCounts(followerId, followeeId);
    }
    return (r.meta?.changes ?? 0) > 0;
  }

  /**
   * Every cached profile count, recomputed from the source of truth rather than
   * incremented. A lost update or a retried request then cannot make a counter
   * drift permanently, and one method covers all three counters so a new one
   * cannot be forgotten at a call site.
   */
  async recomputeCounts(...userIds) {
    for (const id of new Set(userIds.filter(Boolean))) {
      await this.db
        .prepare(
          `UPDATE user SET
             followers = (SELECT COUNT(*) FROM follow WHERE followee = ?),
             following = (SELECT COUNT(*) FROM follow WHERE follower = ?),
             posts = (SELECT COUNT(*) FROM item_owner WHERE user_id = ?)
           WHERE id = ?`,
        )
        .bind(id, id, id, id)
        .run();
    }
  }

  /** Follow/unfollow only touch the two follow counters. */
  async recomputeFollowCounts(...userIds) {
    for (const id of new Set(userIds.filter(Boolean))) {
      await this.db
        .prepare(
          `UPDATE user SET
             followers = (SELECT COUNT(*) FROM follow WHERE followee = ?),
             following = (SELECT COUNT(*) FROM follow WHERE follower = ?)
           WHERE id = ?`,
        )
        .bind(id, id, id)
        .run();
    }
  }

  async isFollowing(followerId, followeeId) {
    if (!followerId || !followeeId) return false;
    const row = await this.db
      .prepare('SELECT 1 AS ok FROM follow WHERE follower = ? AND followee = ?')
      .bind(followerId, followeeId)
      .first();
    return !!row;
  }

  async followersOf(userId, { limit = 50 } = {}) {
    return this.rows(
      `SELECT u.* FROM follow f JOIN user u ON u.id = f.follower
        WHERE f.followee = ? ORDER BY f.created_at DESC LIMIT ?`,
      userId, Math.min(100, Math.max(1, limit)),
    );
  }

  async followingOf(userId, { limit = 50 } = {}) {
    return this.rows(
      `SELECT u.* FROM follow f JOIN user u ON u.id = f.followee
        WHERE f.follower = ? ORDER BY f.created_at DESC LIMIT ?`,
      userId, Math.min(100, Math.max(1, limit)),
    );
  }

  /* ----------------------------------------------------------------- likes */

  /**
   * Like is idempotent per (item, user) thanks to the composite primary key,
   * so a double-tap cannot inflate the counter. The counter is recomputed
   * rather than incremented for the same reason.
   */
  async likeItem(itemId, userId) {
    const r = await this.db
      .prepare('INSERT OR IGNORE INTO like (item_id, user_id, created_at) VALUES (?, ?, ?)')
      .bind(itemId, userId, Date.now())
      .run();
    const inserted = (r.meta?.changes ?? 0) > 0;
    if (inserted) await this.recomputeItemCounters(itemId);
    return { ok: inserted, liked: true };
  }

  async unlikeItem(itemId, userId) {
    const r = await this.db
      .prepare('DELETE FROM like WHERE item_id = ? AND user_id = ?')
      .bind(itemId, userId)
      .run();
    if ((r.meta?.changes ?? 0) > 0) await this.recomputeItemCounters(itemId);
    return { ok: true, liked: false };
  }

  async hasLiked(itemId, userId) {
    if (!userId) return false;
    const row = await this.db
      .prepare('SELECT 1 AS ok FROM like WHERE item_id = ? AND user_id = ?')
      .bind(itemId, userId)
      .first();
    return !!row;
  }

  async recomputeItemCounters(itemId) {
    await this.db
      .prepare(
        `UPDATE items SET
           likes = (SELECT COUNT(*) FROM like WHERE item_id = ?),
           comments = (SELECT COUNT(*) FROM comment WHERE item_id = ?)
         WHERE id = ?`,
      )
      .bind(itemId, itemId, itemId)
      .run();
  }

  /* -------------------------------------------------------------- comments */

  async addComment({ id, itemId, userId, body }) {
    const t = Date.now();
    await this.db
      .prepare('INSERT INTO comment (id, item_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, itemId, userId, body, t)
      .run();
    await this.recomputeItemCounters(itemId);
    return this.getComment(id);
  }

  async getComment(id) {
    return (await this.db.prepare('SELECT * FROM comment WHERE id = ?').bind(id).first()) || null;
  }

  async listComments(itemId, { limit = 50, offset = 0 } = {}) {
    return this.rows(
      `SELECT c.*, u.nick, u.id AS author_id FROM comment c
         JOIN user u ON u.id = c.user_id
        WHERE c.item_id = ?
        ORDER BY c.created_at ASC
        LIMIT ? OFFSET ?`,
      itemId, Math.min(100, Math.max(1, limit)), Math.max(0, offset),
    );
  }

  /** Returns the comment plus its author's id, so the route can check ownership. */
  async deleteComment(id) {
    const row = await this.getComment(id);
    if (!row) return null;
    await this.db.prepare('DELETE FROM comment WHERE id = ?').bind(id).run();
    await this.recomputeItemCounters(row.item_id);
    return row;
  }

  async countPostsOf(userId) {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM item_owner WHERE user_id = ?')
      .bind(userId)
      .first();
    return row?.n ?? 0;
  }

  /**
   * Counts a view of an item, deduplicated by client id.
   *
   * The `item_view` table's primary key means the same browser (client id)
   * counts once per item; a refresh or a repeated GET does not farm the
   * counter. The publish/author client id and the viewing account's own items
   * are skipped entirely - loading your own page is not a view. Returns 1 when
   * this call actually incremented the counter.
   *
   * A signed-in viewer is keyed by the account instead of the browser id, so
   * clearing localStorage does not hand out a fresh identity and re-farm the
   * counter. Anonymous visitors are still keyed by client id: there is nothing
   * stronger to key on without fingerprinting a reader who never opted in.
   */
  async incItemHits(id, clientId, { viewerUserId = null } = {}) {
    const key = viewerUserId ? `viewer:${viewerUserId}` : clientId;
    if (!key) return 0;
    const row = await this.getItem(id);
    if (!row) return 0;
    if (!viewerUserId && clientId === row.author) return 0;
    if (viewerUserId && (await this.ownerOfItem(id)) === viewerUserId) return 0;
    const r = await this.db
      .prepare('INSERT OR IGNORE INTO item_view (item_id, client_id, first_at) VALUES (?, ?, ?)')
      .bind(id, key, Date.now())
      .run();
    if ((r.meta?.changes ?? 0) <= 0) return 0;
    await this.db.prepare('UPDATE items SET hits = hits + 1 WHERE id = ?').bind(id).run();
    return 1;
  }

  async listItems({ type = '', q = '', tag = '', author = '', sort = 'new', limit = 30, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (type) { where.push('type = ?'); params.push(type); }
    if (tag) { where.push('(tags = ? OR tags LIKE ? OR tags LIKE ? OR tags LIKE ?)'); params.push(tag, `${tag} %`, `% ${tag}`, `% ${tag} %`); }
    if (author) { where.push('author = ?'); params.push(author); }
    if (q) {
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = sort === 'hot'
      ? "(hits * 3 + (strftime('%s','now') - created_at / 1000) * -0.05) DESC, created_at DESC"
      : sort === 'old' ? 'created_at ASC' : 'created_at DESC';

    const total = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM items ${clause}`)
      .bind(...params)
      .first()).n;

    const rows = await this.db
      .prepare(`SELECT * FROM items ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all();

    return { total, items: rows.results || [] };
  }

  async addFile(file) {
    await this.db
      .prepare('INSERT INTO files (id, item_id, name, mime, size, sha256, author, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(file.id, file.item_id, file.name, file.mime, file.size, file.sha256, file.author, file.created_at)
      .run();
    return this.getFile(file.id);
  }

  async getFile(id) {
    return mapFile(await this.db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first());
  }

  async listFiles(itemId) {
    const r = await this.db
      .prepare('SELECT * FROM files WHERE item_id = ? ORDER BY created_at')
      .bind(itemId)
      .all();
    return (r.results || []).map(mapFile);
  }

  async deleteFile(id) {
    const r = await this.db.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async incFileDownloads(id) {
    await this.db.prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
  }

  async otherRefsToSha(sha, excludeId) {
    return (await this.db
      .prepare('SELECT COUNT(*) AS n FROM files WHERE sha256 = ? AND id != ?')
      .bind(sha, excludeId)
      .first()).n;
  }

  async filesOfAuthor(author) {
    const r = await this.db
      .prepare('SELECT id FROM files WHERE author = ? ORDER BY created_at DESC LIMIT 200')
      .bind(author)
      .all();
    const rows = r.results || [];
    return Promise.all(rows.map((row) => this.getFile(row.id)));
  }

  async touchClient(id) {
    const t = Date.now();
    await this.db
      .prepare('INSERT INTO clients (id, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at')
      .bind(id, t, t)
      .run();
  }

  async getClient(id) {
    return (await this.db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first()) || null;
  }

  async stats() {
    const one = async (sql) => (await this.db.prepare(sql).first()).n;
    const types = await this.db
      .prepare("SELECT type, COUNT(*) AS n FROM items WHERE type IN ('script','paste','app','image','video','file') GROUP BY type")
      .all();
    const byType = {};
    for (const r of types.results || []) byType[r.type] = r.n;

    return {
      items: await one('SELECT COUNT(*) AS n FROM items'),
      scripts: byType.script || 0,
      pastes: byType.paste || 0,
      apps: byType.app || 0,
      images: byType.image || 0,
      videos: byType.video || 0,
      documents: byType.file || 0,
      files: await one('SELECT COUNT(*) AS n FROM files'),
      bytes: await one('SELECT COALESCE(SUM(size), 0) AS n FROM files'),
      clients: await one('SELECT COUNT(*) AS n FROM clients'),
    };
  }

  /**
   * Fixed-window throttle. Returns true when the caller may proceed.
   *
   * The window counter is a count of rows in `rate`, so the write happens only
   * when the caller is still inside their allowance; a rejected caller costs
   * one read and nothing else.
   */
  async throttle(client, bucket, { cap, windowMs }) {
    const t = Date.now();
    const since = t - windowMs;
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM rate WHERE client = ? AND bucket = ? AND ts > ?')
      .bind(client, bucket, since)
      .first();

    if (row.n >= cap) return false;

    await this.db
      .prepare('INSERT INTO rate (client, bucket, ts) VALUES (?, ?, ?)')
      .bind(client, bucket, t)
      .run();
    return true;
  }

  /** Opportunistic cleanup; rate limits are per-minute so lag is harmless. */
  async sweepRate(maxAgeMs = 10 * 60 * 1000) {
    await this.db
      .prepare('DELETE FROM rate WHERE ts < ?')
      .bind(Date.now() - maxAgeMs)
      .run();
  }
}
