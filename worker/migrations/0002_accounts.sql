-- Accounts, sessions, follows, likes and comments.
--
-- Everything social hangs off `user`, but nothing breaks for anonymous callers:
-- items keep their own `client` author column and `item_owner` maps them to an
-- account. This keeps the anonymous publishing path working while registered
-- users gain a durable identity they can log back into.
--
-- schema.sql already describes the final shape (the test harness builds from it
-- rather than replaying migrations), so this file only adds what is missing
-- remotely. Every statement is idempotent.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user (
  id            TEXT PRIMARY KEY,
  -- `nick` is the display form, `nick_key` the folded form used for uniqueness
  -- and lookup, so "Danil" and "danil" cannot both register.
  nick          TEXT NOT NULL,
  nick_key      TEXT NOT NULL UNIQUE,
  -- PBKDF2-HMAC-SHA256. Only the derived key is stored, never the password,
  -- and never a plain sha256 of it.
  pass_hash     TEXT NOT NULL,
  pass_salt     TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
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
  -- Client that created the session. Checked on presentation so a stolen token
  -- is useless from another browser, and used to revoke on logout.
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

-- Outstanding CAPTCHA challenges.
--
-- The answer lives here rather than inside the token handed to the client: a
-- signed-but-readable token only proves the *server* issued it, not that the
-- caller solved anything, since anyone can base64-decode a payload. Storing it
-- server-side makes the question the only thing the caller ever sees.
--
-- `used_at` is set on the first successful solve, so one solved challenge
-- cannot be replayed for a burst of posts.
CREATE TABLE IF NOT EXISTS captcha (
  id         TEXT PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_captcha_expires ON captcha(expires_at);

-- Counter columns on the pre-existing table. `user` is created above, so its
-- counters are inline; only `items` predates this migration. D1 has no
-- ADD COLUMN IF NOT EXISTS, and a duplicate column aborts the migration, which
-- is the behaviour we want here: 0002 is applied exactly once, and D1 records
-- that it ran. A re-run fails loudly instead of silently drifting.
ALTER TABLE items ADD COLUMN likes    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN comments INTEGER NOT NULL DEFAULT 0;
