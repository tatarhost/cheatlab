-- AIL AI API keys. Plaintext is returned only once at creation; only hashes are stored.
CREATE TABLE IF NOT EXISTS ail_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ail_api_keys_user ON ail_api_keys(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ail_api_keys_expiry ON ail_api_keys(expires_at);
