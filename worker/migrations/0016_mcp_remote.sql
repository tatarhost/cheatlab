-- Per-account remote MCP endpoint credentials.
-- Tokens are returned once and only their SHA-256 hashes are stored.
ALTER TABLE mcp_servers ADD COLUMN remote_secret_hash TEXT;
ALTER TABLE mcp_servers ADD COLUMN remote_secret_prefix TEXT;
ALTER TABLE mcp_servers ADD COLUMN remote_last_used_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_remote_secret_hash_idx
  ON mcp_servers(remote_secret_hash) WHERE remote_secret_hash IS NOT NULL;
