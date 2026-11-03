-- Persist attachment metadata for the sent-mail view.
ALTER TABLE mail_message ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
