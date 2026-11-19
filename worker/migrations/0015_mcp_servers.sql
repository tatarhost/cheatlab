-- User-owned MCP launchers and explicit PC connection approvals.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  secret_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_servers_owner_idx ON mcp_servers(user_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS mcp_servers_limit
BEFORE INSERT ON mcp_servers
WHEN (SELECT COUNT(*) FROM mcp_servers WHERE user_id = NEW.user_id AND revoked_at IS NULL) >= 5
BEGIN
  SELECT RAISE(ABORT, 'MCP server limit reached');
END;

CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  python_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','revoked','disconnected','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_seen_at INTEGER,
  disconnected_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_connections_server_idx ON mcp_connections(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_connections_owner_idx ON mcp_connections(user_id, status, created_at DESC);
