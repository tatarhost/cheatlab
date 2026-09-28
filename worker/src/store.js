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
  'author', 'author_label', 'secret_hash', 'visibility', 'created_at', 'updated_at',
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

  async incItemHits(id) {
    await this.db.prepare('UPDATE items SET hits = hits + 1 WHERE id = ?').bind(id).run();
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
