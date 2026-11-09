-- Short-lived device authorizations for the unofficial Android launcher.
-- The browser approves an app session; the app receives a session bound to its own client id.
CREATE TABLE IF NOT EXISTS app_login (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed', 'expired', 'denied')),
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  consumed_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS app_login_expiry_idx ON app_login(expires_at);
CREATE INDEX IF NOT EXISTS app_login_client_idx ON app_login(client_id, created_at);
