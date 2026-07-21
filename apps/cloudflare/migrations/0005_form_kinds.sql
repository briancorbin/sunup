-- Migration number: 0005
-- A channel may now run one check-in per KIND ('sunup' morning check-in,
-- 'sundown' evening checkout): replace UNIQUE(channel_id) with
-- UNIQUE(channel_id, kind), which requires rebuilding the standups table.
--
-- DANGER, HANDLED: on D1, DROP TABLE performs an implicit DELETE first, and
-- ON DELETE CASCADE children get wiped — PRAGMA defer_foreign_keys does NOT
-- prevent this. So: park all child data in constraint-free temp tables, drop
-- the children, rebuild standups while nothing references it, then recreate
-- the children (schemas + indexes intact) and refill them.

-- 1. Park child data (CREATE TABLE AS copies data without constraints).
CREATE TABLE _tmp_participants AS SELECT * FROM participants;
CREATE TABLE _tmp_runs AS SELECT * FROM runs;
CREATE TABLE _tmp_run_participants AS SELECT * FROM run_participants;
CREATE TABLE _tmp_responses AS SELECT * FROM responses;
CREATE TABLE _tmp_blockers AS SELECT * FROM blockers;

-- 2. Drop children — grandchildren of standups first, so no cascade ever fires.
DROP TABLE run_participants;
DROP TABLE responses;
DROP TABLE runs;
DROP TABLE participants;
DROP TABLE blockers;

-- 3. Rebuild standups: + kind, UNIQUE(channel_id) -> UNIQUE(channel_id, kind).
CREATE TABLE standups_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sunup',
  questions TEXT NOT NULL,
  schedule_days TEXT NOT NULL,
  prompt_time TEXT NOT NULL,
  digest_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  user_tz_prompts INTEGER NOT NULL DEFAULT 1,
  reminder_minutes INTEGER NOT NULL DEFAULT 60,
  include_mood INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_retro_date TEXT,
  UNIQUE (channel_id, kind)
);
INSERT INTO standups_new (id, name, channel_id, questions, schedule_days, prompt_time, digest_time, timezone, user_tz_prompts, reminder_minutes, include_mood, created_at, last_retro_date)
  SELECT id, name, channel_id, questions, schedule_days, prompt_time, digest_time, timezone, user_tz_prompts, reminder_minutes, include_mood, created_at, last_retro_date
  FROM standups;
DROP TABLE standups;
ALTER TABLE standups_new RENAME TO standups;

-- 4. Recreate children exactly as before (schemas from 0001/0002/0004) and refill.
CREATE TABLE participants (
  standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  tz TEXT,
  snoozed_until TEXT,
  PRIMARY KEY (standup_id, user_id)
);
INSERT INTO participants SELECT * FROM _tmp_participants;

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,
  digest_posted_at TEXT,
  digest_ts TEXT,
  UNIQUE (standup_id, run_date)
);
INSERT INTO runs SELECT * FROM _tmp_runs;

CREATE TABLE run_participants (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  prompted_at TEXT,
  reminded_at TEXT,
  PRIMARY KEY (run_id, user_id)
);
INSERT INTO run_participants SELECT * FROM _tmp_run_participants;

CREATE TABLE responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  answers TEXT NOT NULL,
  mood INTEGER,
  submitted_at TEXT NOT NULL,
  UNIQUE (run_id, user_id)
);
INSERT INTO responses SELECT * FROM _tmp_responses;

CREATE TABLE blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  standup_id INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  opened_date TEXT NOT NULL,
  last_confirmed_date TEXT NOT NULL,
  resolved_at TEXT
);
INSERT INTO blockers SELECT * FROM _tmp_blockers;

-- 5. Recreate indexes lost with the dropped tables, and clean up.
CREATE INDEX idx_runs_standup_date ON runs(standup_id, run_date);
CREATE INDEX idx_responses_run ON responses(run_id);
CREATE INDEX idx_blockers_standup_open ON blockers(standup_id, user_id) WHERE resolved_at IS NULL;

DROP TABLE _tmp_participants;
DROP TABLE _tmp_runs;
DROP TABLE _tmp_run_participants;
DROP TABLE _tmp_responses;
DROP TABLE _tmp_blockers;
