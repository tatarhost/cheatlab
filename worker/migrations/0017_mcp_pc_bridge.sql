-- Bounded, expiring jobs sent only to an owner-approved PC agent.
CREATE TABLE IF NOT EXISTS mcp_pc_jobs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('pc_get_system_info','pc_list_shared_files','pc_read_shared_file')),
  arguments_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','completed','failed','expired')),
  response_json TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_pc_jobs_connection_idx
  ON mcp_pc_jobs(connection_id, status, created_at);
CREATE INDEX IF NOT EXISTS mcp_pc_jobs_expiry_idx
  ON mcp_pc_jobs(status, expires_at);
