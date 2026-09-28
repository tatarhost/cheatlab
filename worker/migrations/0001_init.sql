-- CHEATLAB metadata store (Cloudflare D1, SQLite dialect)
--
-- D1 is SQLite, so the original node:sqlite schema ports unchanged. The only
-- addition is `rate`, which replaces the in-process token bucket: Workers
-- isolates are ephemeral, so request throttling has to live in the database.

PRAGMA foreign_keys = ON;

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
CREATE INDEX IF NOT EXISTS files_author ON files (author, created_at DESC);

CREATE TABLE IF NOT EXISTS clients (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- Write throttling. Rows are transient; index supports the windowed count.
CREATE TABLE IF NOT EXISTS rate (
  client  TEXT NOT NULL,
  bucket  TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_client ON rate (client, bucket, ts);
