BEGIN;
ALTER TABLE deletion_request ADD COLUMN checked_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- Pre-registry attempts may have emitted traces or abandoned threads. Do not claim
-- complete deletion of such history without an explicit inventory reconciliation.
UPDATE analysis_task SET lifecycle_history_complete=false WHERE EXISTS
 (SELECT 1 FROM task_attempt a WHERE a.analysis_task_id=analysis_task.id);
COMMIT;
