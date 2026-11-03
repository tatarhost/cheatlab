-- CheatLab Mail: private mailboxes and message metadata.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS mail_mailbox (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
  created_at INTEGER NOT NULL,
  UNIQUE(owner_user_id, local_part)
);
CREATE INDEX IF NOT EXISTS idx_mail_mailbox_owner ON mail_mailbox(owner_user_id, created_at);
CREATE TABLE IF NOT EXISTS mail_message (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mail_mailbox(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('inbox','sent')),
  from_address TEXT NOT NULL DEFAULT '',
  to_address TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_message_box ON mail_message(mailbox_id, direction, created_at DESC);
