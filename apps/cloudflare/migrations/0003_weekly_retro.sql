-- Migration number: 0003
-- Tracks the last date a weekly retro was posted, so the retro is idempotent per week.
ALTER TABLE standups ADD COLUMN last_retro_date TEXT;
