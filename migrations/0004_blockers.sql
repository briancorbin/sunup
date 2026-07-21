-- Migration number: 0004
-- Blockers as first-class tracked entities with a lifecycle (TOBC-201).
-- v1 invariant: at most one OPEN blocker per (standup, user); text refreshes
-- to the latest phrasing while the opened_date keeps the true age.
CREATE TABLE blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  opened_date TEXT NOT NULL,           -- run_date first reported
  last_confirmed_date TEXT NOT NULL,   -- latest run_date reported/confirmed still blocked
  resolved_at TEXT                     -- ISO timestamp; NULL = open
);

CREATE INDEX idx_blockers_standup_open ON blockers(standup_id, user_id) WHERE resolved_at IS NULL;
