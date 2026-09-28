import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  language     TEXT NOT NULL DEFAULT 'text',
  tags         TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL,
  author_label TEXT NOT NULL DEFAULT '',
  secret_hash  TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'public',
  hits         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_created ON items (created_at DESC);
CREATE INDEX IF NOT EXISTS items_author   ON items (author, created_at DESC);
CREATE INDEX IF NOT EXISTS items_type     ON items (type, created_at DESC);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  author      TEXT NOT NULL,
  downloads   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_item ON files (item_id, created_at);
CREATE INDEX IF NOT EXISTS files_sha  ON files (sha256);

CREATE TABLE IF NOT EXISTS clients (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;

const ITEM_FIELDS = new Set([
  'id', 'type', 'title', 'body', 'language', 'tags',
  'author', 'author_label', 'secret_hash', 'visibility', 'created_at', 'updated_at',
]);

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'cheatlab.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  createItem(item) {
    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(item)) {
      if (!ITEM_FIELDS.has(k)) continue;
      cols.push(k);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    this.db
      .prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...vals);
    return this.getItem(item.id);
  }

  getItem(id) {
    return this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) || null;
  }

  updateItem(id, patch) {
    const keys = Object.keys(patch).filter((k) => ITEM_FIELDS.has(k) && k !== 'id');
    if (!keys.length) return this.getItem(id);
    this.db
      .prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => patch[k]), id);
    return this.getItem(id);
  }

  deleteItem(id) {
    return this.db.prepare('DELETE FROM items WHERE id = ?').run(id).changes > 0;
  }

  incItemHits(id) {
    this.db.prepare('UPDATE items SET hits = hits + 1 WHERE id = ?').run(id);
  }

  listItems({ type = '', q = '', tag = '', author = '', sort = 'new', limit = 30, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (type) { where.push('type = ?'); params.push(type); }
    if (tag) { where.push('(tags = ? OR tags LIKE ? OR tags LIKE ? OR tags LIKE ?)'); params.push(tag, `${tag} %`, `% ${tag}`, `% ${tag} %`); }
    if (author) { where.push('author = ?'); params.push(author); }
    if (q) {
      where.push('(title LIKE ? ESCAPE \'\\\' OR body LIKE ? ESCAPE \'\\\' OR tags LIKE ? ESCAPE \'\\\')');
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = sort === 'hot'
      ? '(hits * 3 + (strftime(\'%s\',\'now\') - created_at / 1000) * -0.05) DESC, created_at DESC'
      : sort === 'old' ? 'created_at ASC' : 'created_at DESC';

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM items ${clause}`).get(...params).n;
    const rows = this.db
      .prepare(`SELECT * FROM items ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);

    return { total, items: rows };
  }

  addFile(file) {
    this.db
      .prepare(
        'INSERT INTO files (id, item_id, name, mime, size, sha256, author, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(file.id, file.item_id, file.name, file.mime, file.size, file.sha256, file.author, file.created_at);
    return this.getFile(file.id);
  }

  getFile(id) {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
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

  listFiles(itemId) {
    return this.db
      .prepare('SELECT * FROM files WHERE item_id = ? ORDER BY created_at')
      .all(itemId)
      .map((row) => ({
        id: row.id,
        itemId: row.item_id,
        name: row.name,
        mime: row.mime,
        size: row.size,
        sha256: row.sha256,
        downloads: row.downloads,
        createdAt: row.created_at,
      }));
  }

  deleteFile(id) {
    return this.db.prepare('DELETE FROM files WHERE id = ?').run(id).changes > 0;
  }

  incFileDownloads(id) {
    this.db.prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?').run(id);
  }

  otherRefsToSha(sha, excludeId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE sha256 = ? AND id != ?').get(sha, excludeId).n;
  }

  filesOfAuthor(author) {
    return this.db
      .prepare('SELECT * FROM files WHERE author = ? ORDER BY created_at DESC LIMIT 200')
      .all(author)
      .map((row) => this.getFile(row.id));
  }

  touchClient(id) {
    const t = Date.now();
    this.db
      .prepare(
        'INSERT INTO clients (id, created_at, last_seen_at) VALUES (?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at',
      )
      .run(id, t, t);
  }

  getClient(id) {
    return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get().n;
    return {
      items: one('SELECT COUNT(*) AS n FROM items'),
      scripts: one("SELECT COUNT(*) AS n FROM items WHERE type = 'script'"),
      pastes: one("SELECT COUNT(*) AS n FROM items WHERE type = 'paste'"),
      apps: one("SELECT COUNT(*) AS n FROM items WHERE type = 'app'"),
      files: one('SELECT COUNT(*) AS n FROM files'),
      bytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM files'),
      clients: one('SELECT COUNT(*) AS n FROM clients'),
    };
  }
}
