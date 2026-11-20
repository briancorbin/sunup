-- Migration number: 0006
-- created_by: Slack user id of whoever ran `/sunup setup`. Management commands
-- (remove / config / questions) are gated on this user or a Slack admin.
-- NULL = created before this migration; see README "Who can manage a check-in".
ALTER TABLE standups ADD COLUMN created_by TEXT;
-- last_prompt_date: the participant's OWN local "YYYY-MM-DD" most recently
-- handled by the prompt scheduler. One prompt per person per local day, no
-- matter how far their timezone sits from the channel's.
ALTER TABLE participants ADD COLUMN last_prompt_date TEXT;
