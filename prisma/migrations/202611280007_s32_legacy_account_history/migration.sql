BEGIN;
ALTER TABLE account ADD COLUMN lifecycle_history_complete boolean NOT NULL DEFAULT true;
-- Accounts that existed before trace/operation registration may have unrecorded
-- JD suggestion traces too, even if they have no analysis attempts.
UPDATE account SET lifecycle_history_complete=false;
COMMIT;
