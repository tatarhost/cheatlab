-- Email verification for registration and mandatory email 2FA on every login.
-- Existing accounts remain intact; they attach and verify an email at their next login.
ALTER TABLE user ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE user ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_user_email_unique ON user(email) WHERE email <> '';
CREATE TABLE email_otp (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('register','login','login_bind')),
  email TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  nick TEXT NOT NULL DEFAULT '',
  nick_key TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL DEFAULT '',
  pass_salt TEXT NOT NULL DEFAULT '',
  iterations INTEGER NOT NULL DEFAULT 0,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_email_otp_expiry ON email_otp(expires_at);
