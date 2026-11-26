BEGIN;
ALTER TABLE "outbox_event"
  ADD COLUMN "failed_at" TIMESTAMP(3),
  ADD COLUMN "last_error_code" VARCHAR(64),
  ADD CONSTRAINT "outbox_event_outcome_check" CHECK (published_at IS NULL OR failed_at IS NULL);
CREATE INDEX "outbox_event_owner_id_failed_at_published_at_available_at_idx"
  ON "outbox_event" ("owner_id", "failed_at", "published_at", "available_at");
COMMIT;
