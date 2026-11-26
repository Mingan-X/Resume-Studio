BEGIN;
ALTER TABLE "analysis_task" ADD COLUMN "retry_at" TIMESTAMP(3);
ALTER TABLE "job_index_task" ADD COLUMN "retry_at" TIMESTAMP(3);
ALTER TABLE "quarantine"
  ADD COLUMN "owner_id" UUID,
  ADD COLUMN "consumer_name" VARCHAR(128),
  ADD COLUMN "dedupe_key" CHAR(64),
  ADD CONSTRAINT "quarantine_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "quarantine_identity_check" CHECK (
    (owner_id IS NULL AND consumer_name IS NULL AND dedupe_key IS NULL) OR
    (owner_id IS NOT NULL AND consumer_name IS NOT NULL AND length(consumer_name) > 0
      AND dedupe_key IS NOT NULL AND dedupe_key ~ '^[a-f0-9]{64}$')
  );
CREATE UNIQUE INDEX "quarantine_owner_id_consumer_name_dedupe_key_key" ON "quarantine"("owner_id", "consumer_name", "dedupe_key");
COMMIT;
