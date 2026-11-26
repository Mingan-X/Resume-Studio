BEGIN;
ALTER TABLE "analysis_task" ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "analysis_task_recovery_count_check" CHECK (recovery_count >= 0);
ALTER TABLE "job_index_task" ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "job_index_task_recovery_count_check" CHECK (recovery_count >= 0);
CREATE INDEX "analysis_task_owner_id_status_updated_at_idx" ON "analysis_task"("owner_id", "status", "updated_at");
CREATE INDEX "job_index_task_owner_id_status_updated_at_idx" ON "job_index_task"("owner_id", "status", "updated_at");
COMMIT;
