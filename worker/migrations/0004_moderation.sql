-- 0004 — moderation: roles, timed bans, blocked nicks, reports, avatars.
--
-- Nothing here changes what an anonymous visitor can do. Every rule is additive
-- and enforced by the Worker, and every write records who did it, because a
-- moderation log that cannot answer "who banned this and why" is not evidence
-- of anything when someone complains to a regulator or a court.

-- 1. Roles. 'admin' is deliberately NOT a value here: full admin comes from the
--    ADMIN_IDS environment var, which is a deploy-time fact an account holder
--    cannot grant themselves by writing a row. This column only ever holds
--    'user' or 'moderator', so a database edit cannot mint a full admin.
ALTER TABLE user ADD COLUMN role   TEXT NOT NULL DEFAULT 'user';
ALTER TABLE user ADD COLUMN popular INTEGER NOT NULL DEFAULT 0;

-- Avatar uploaded from the user's own device. Kept apart from `logo`, which is
-- an https URL: this id is server-minted and only ever resolves through /a/<id>,
-- so an avatar cannot be pointed at a third-party tracker the operator does not
-- control. `logo` keeps working unchanged for people who still prefer a URL.
ALTER TABLE user ADD COLUMN avatar_id TEXT NOT NULL DEFAULT '';
-- The stored content type. Not a header the client sends: the upload route
-- picks from its own allowlist, so a caller cannot get an arbitrary
-- Content-Type stored and later served back as a trusted type.
ALTER TABLE user ADD COLUMN avatar_mime TEXT NOT NULL DEFAULT '';

-- 2. Timed bans. A ban is a row, not a flag, so history survives: `until_at`
--   is the moment it lapses, and lifting one early is recorded in lifted_at
--   rather than by deleting the row. NULL until_at would mean "forever", which
--   is why it is a non-null column with a far-future default instead.
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

-- 3. Nicks that must never be registered or claimed. `nick_key` is the folded
--    form, matching user.nick_key, so blocking "Admin" blocks "admin" too.
--    The existing WEAK_NICKS list in accounts.js is a built-in floor; this table
--    is the operator's own list on top of it.
CREATE TABLE IF NOT EXISTS nick_block (
  nick_key   TEXT PRIMARY KEY,
  nick       TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  by_user_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- 4. Reports. The operator's legal protection is not the disclaimer alone, it
--    is being able to show that a report was received and acted on, so reports
--    are a first-class table with a status and a resolution trail rather than
--    mail that arrives and gets forgotten.
CREATE TABLE IF NOT EXISTS report (
  id          TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,            -- 'item' | 'user' | 'comment'
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  by_user_id  TEXT NOT NULL DEFAULT '',  -- empty for anonymous reports
  by_client   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'resolved' | 'dismissed'
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_status ON report(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_target ON report(target_type, target_id);
