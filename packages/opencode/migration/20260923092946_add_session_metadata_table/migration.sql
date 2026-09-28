CREATE TABLE IF NOT EXISTS session_metadata (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  time_created INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  time_updated INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (session_id, key),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);