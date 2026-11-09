CREATE TABLE IF NOT EXISTS ail_training_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  parameters INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  session_steps INTEGER NOT NULL DEFAULT 0,
  train_loss REAL,
  validation_loss REAL,
  best_validation_loss REAL,
  elapsed_seconds REAL,
  compute TEXT NOT NULL DEFAULT 'GitHub Actions CPU',
  initialized_from_random_weights INTEGER NOT NULL DEFAULT 0,
  pretrained_model_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ail_training_sessions_created ON ail_training_sessions(created_at DESC);
