-- Migration number: 0002
-- digest_ts: Slack message ts of the posted digest, so late check-ins can update it in place.
ALTER TABLE runs ADD COLUMN digest_ts TEXT;
-- snoozed_until: "YYYY-MM-DD" (standup timezone); prompts/reminders/waiting-on skip the
-- participant through this date. NULL = active.
ALTER TABLE participants ADD COLUMN snoozed_until TEXT;
