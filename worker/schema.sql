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
  -- Access key (LootLabs-style lock): only the SHA-256 hex is stored, never the
  -- key. A non-NULL value locks the item body and files behind the key.
  access_key_hash TEXT,
  key_hint        TEXT NOT NULL DEFAULT '',
  visibility   TEXT NOT NULL DEFAULT 'public',
  hits         INTEGER NOT NULL DEFAULT 0,
  -- Denormalised social counters, kept in step by the store after each
  -- insert/delete so a feed query needs no per-item subquery.
  likes        INTEGER NOT NULL DEFAULT 0,
  comments     INTEGER NOT NULL DEFAULT 0,
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

/* ------------------------------------------------------------- accounts --
 * Mirrors migrations/0002_accounts.sql. The test harness builds from this file
 * rather than replaying migrations, so both are kept in the same final shape:
 * this is the full schema, the migration is the path that reaches production.
 *
 * Nothing here is required for anonymous publishing. `items.author` stays the
 * authoritative author column and `user_id` lives in its own table, so existing
 * anonymous rows stay valid and registering never rewrites history.
 */

CREATE TABLE IF NOT EXISTS user (
  id            TEXT PRIMARY KEY,
  -- `nick` is the display form, `nick_key` the folded form used for
  -- uniqueness and lookup, so "Danil" and "danil" cannot both register.
  nick          TEXT NOT NULL,
  nick_key      TEXT NOT NULL UNIQUE,
  -- PBKDF2-HMAC-SHA256. Only the derived key is stored, never the password,
  -- and never a plain sha256 of it.
  pass_hash     TEXT NOT NULL,
  pass_salt     TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  -- Profile design: logo is an https image URL, accent a #hex colour, bg a
  -- safe CSS background value (gradients allowed, no url()).
  logo          TEXT NOT NULL DEFAULT '',
  accent        TEXT NOT NULL DEFAULT '',
  bg            TEXT NOT NULL DEFAULT '',
  -- `avatar_id` is a server-minted id served from KV through /a/<id>; it is
  -- separate from `logo` (an https URL) so an uploaded avatar can never be a
  -- third-party tracking pixel. `role` only ever holds 'user' or 'moderator':
  -- full admin is the ADMIN_IDS env var, not a row anyone can write.
  avatar_id     TEXT NOT NULL DEFAULT '',
  avatar_mime   TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
  popular       INTEGER NOT NULL DEFAULT 0,
  -- Cached counts, kept in step after each follow/unfollow and post.
  followers     INTEGER NOT NULL DEFAULT 0,
  following     INTEGER NOT NULL DEFAULT 0,
  posts         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON user(created_at DESC);

-- Sessions are bearer tokens, but only sha256(token) is stored, so a database
-- leak cannot hand out live sessions.
CREATE TABLE IF NOT EXISTS session (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  -- Client that created the session. Checked on presentation so a stolen
  -- token is useless from another browser, and used to revoke on logout.
  client_id   TEXT NOT NULL,
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_session_user   ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session(expires_at);

-- Ties an existing anonymous item to the account that claimed it, instead of
-- rewriting items.author and breaking the original edit secret.
CREATE TABLE IF NOT EXISTS item_owner (
  item_id   TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  bound_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_owner_user ON item_owner(user_id);

CREATE TABLE IF NOT EXISTS follow (
  follower   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  followee   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower, followee)
);
CREATE INDEX IF NOT EXISTS idx_follow_followee ON follow(followee);
CREATE INDEX IF NOT EXISTS idx_follow_follower ON follow(follower);

-- One like per user per item, enforced by the primary key so a double-tap
-- cannot inflate the counter.
CREATE TABLE IF NOT EXISTS like (
  item_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_like_user ON like(user_id);
CREATE INDEX IF NOT EXISTS idx_like_item ON like(item_id);

-- Deduplicates view counting: one row per (item, client) so refreshing the
-- page or farming the counter from the same browser counts once. Rows are
-- never deleted - an identity is an identity.
CREATE TABLE IF NOT EXISTS item_view (
  item_id   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (item_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_item_view_item ON item_view(item_id);

CREATE TABLE IF NOT EXISTS comment (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comment_item ON comment(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_user ON comment(user_id);

-- Outstanding CAPTCHA challenges. The answer stays on the server: a token the
-- client can read is not evidence that anyone solved the question. See
-- migrations/0002_accounts.sql for the reasoning.
CREATE TABLE IF NOT EXISTS captcha (
  id         TEXT PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_captcha_expires ON captcha(expires_at);

/* ------------------------------------------------------------- moderation --
 * Mirrors migrations/0004_moderation.sql. See that file for the reasoning; the
 * short version is that every moderation action leaves a row naming who did it
 * and when, because "we removed it" is only useful if it can be evidenced.
 */
CREATE TABLE IF NOT EXISTS ban (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  until_at   INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  by_user_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  lifted_at  INTEGER,
  lifted_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ban_user ON ban(user_id, until_at DESC);

CREATE TABLE IF NOT EXISTS nick_block (
  nick_key   TEXT PRIMARY KEY,
  nick       TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  by_user_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS report (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  by_user_id  TEXT NOT NULL DEFAULT '',
  by_client   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_target ON report(target_type, target_id);
