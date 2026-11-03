-- Rich message rendering and Gmail-style message state.
ALTER TABLE mail_message ADD COLUMN html_body TEXT NOT NULL DEFAULT '';
ALTER TABLE mail_message ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_message ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_mail_message_starred ON mail_message(mailbox_id, is_starred, created_at DESC);
