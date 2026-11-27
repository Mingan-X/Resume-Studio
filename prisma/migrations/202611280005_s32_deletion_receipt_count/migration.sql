BEGIN;
ALTER TABLE deletion_request ADD COLUMN step_count integer NOT NULL DEFAULT 0 CHECK(step_count>=0);
COMMIT;
