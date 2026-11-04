-- Community designs. css is stored already sanitised (see src/themes.js).
CREATE TABLE IF NOT EXISTS theme (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL,
  author_nick TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  css         TEXT NOT NULL,
  palette     TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'approved',
  mod_note    TEXT NOT NULL DEFAULT '',
  installs    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS theme_status_created ON theme (status, created_at DESC);
CREATE INDEX IF NOT EXISTS theme_author ON theme (author_id, created_at DESC);
