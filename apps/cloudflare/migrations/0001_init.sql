-- Migration number: 0001
CREATE TABLE standups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  questions TEXT NOT NULL,             -- JSON array of strings
  schedule_days TEXT NOT NULL,         -- JSON array of 0-6 (Sun-Sat)
  prompt_time TEXT NOT NULL,           -- "HH:MM" 24h
  digest_time TEXT NOT NULL,           -- "HH:MM" 24h
  timezone TEXT NOT NULL,              -- IANA tz anchoring the standup's day
  user_tz_prompts INTEGER NOT NULL DEFAULT 1,
  reminder_minutes INTEGER NOT NULL DEFAULT 60,
  include_mood INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE participants (
  standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  tz TEXT,
  PRIMARY KEY (standup_id, user_id)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,              -- "YYYY-MM-DD" in the standup timezone
  digest_posted_at TEXT,
  UNIQUE (standup_id, run_date)
);

CREATE TABLE run_participants (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  prompted_at TEXT,
  reminded_at TEXT,
  PRIMARY KEY (run_id, user_id)
);

CREATE TABLE responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  answers TEXT NOT NULL,               -- JSON array, same order as questions
  mood INTEGER,
  submitted_at TEXT NOT NULL,
  UNIQUE (run_id, user_id)
);

CREATE TABLE kudos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL,
  message TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_runs_standup_date ON runs(standup_id, run_date);
CREATE INDEX idx_responses_run ON responses(run_id);
CREATE INDEX idx_kudos_created ON kudos(created_at);
