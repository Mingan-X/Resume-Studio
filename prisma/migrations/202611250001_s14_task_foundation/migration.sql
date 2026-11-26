BEGIN;

-- CreateEnum
CREATE TYPE "AnalysisTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobIndexTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('ANALYSIS', 'JOB_INDEX');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('RUNNING', 'DONE');

-- CreateTable
CREATE TABLE "owner" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_task" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "resume_version_id" UUID NOT NULL,
    "active_graph_thread_id" UUID NOT NULL,
    "graph_generation" INTEGER NOT NULL DEFAULT 1,
    "report_id" UUID,
    "input_snapshot" JSONB NOT NULL,
    "status" "AnalysisTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" VARCHAR(64) NOT NULL DEFAULT 'QUEUED',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "fence_token" BIGINT NOT NULL DEFAULT 0,
    "lease_owner" UUID,
    "lease_until" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "error_code" VARCHAR(64),
    "budget_usage" JSONB NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_index_task" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "job_version_id" UUID NOT NULL,
    "embedding_version" VARCHAR(64) NOT NULL,
    "index_version" VARCHAR(64) NOT NULL,
    "input_snapshot" JSONB NOT NULL,
    "status" "JobIndexTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" VARCHAR(64) NOT NULL DEFAULT 'QUEUED',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "fence_token" BIGINT NOT NULL DEFAULT 0,
    "lease_owner" UUID,
    "lease_until" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "error_code" VARCHAR(64),
    "budget_usage" JSONB NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_index_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_attempt" (
    "attempt_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "fence_token" BIGINT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "trace_id" CHAR(32),
    "error_class" VARCHAR(64),
    "tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "owner_id" UUID NOT NULL,
    "task_type" "TaskType" NOT NULL,
    "task_id" UUID NOT NULL,
    "analysis_task_id" UUID,
    "job_index_task_id" UUID,

    CONSTRAINT "task_attempt_pkey" PRIMARY KEY ("attempt_id")
);

-- CreateTable
CREATE TABLE "task_event" (
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "stage" VARCHAR(64) NOT NULL,
    "counts" JSONB NOT NULL,
    "safe_message" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "owner_id" UUID NOT NULL,
    "task_type" "TaskType" NOT NULL,
    "task_id" UUID NOT NULL,
    "analysis_task_id" UUID,
    "job_index_task_id" UUID,

    CONSTRAINT "task_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_receipt" (
    "id" UUID NOT NULL,
    "consumer_name" VARCHAR(128) NOT NULL,
    "message_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'RUNNING',
    "lease_owner" UUID,
    "lease_until" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "owner_id" UUID NOT NULL,
    "task_type" "TaskType" NOT NULL,
    "task_id" UUID NOT NULL,
    "analysis_task_id" UUID,
    "job_index_task_id" UUID,

    CONSTRAINT "consumer_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "event_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "payload_version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" UUID,
    "lease_until" TIMESTAMP(3),
    "publish_attempts" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "quarantine" (
    "id" UUID NOT NULL,
    "message_id" UUID,
    "message_hash" CHAR(64) NOT NULL,
    "error_code" VARCHAR(64) NOT NULL,
    "safe_metadata" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_task_owner_id_status_created_at_idx" ON "analysis_task"("owner_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "analysis_task_status_lease_until_idx" ON "analysis_task"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_task_owner_id_idempotency_key_key" ON "analysis_task"("owner_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_task_owner_id_id_key" ON "analysis_task"("owner_id", "id");

-- CreateIndex
CREATE INDEX "job_index_task_owner_id_status_created_at_idx" ON "job_index_task"("owner_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "job_index_task_status_lease_until_idx" ON "job_index_task"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "job_index_task_owner_id_idempotency_key_key" ON "job_index_task"("owner_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "job_index_task_owner_id_id_key" ON "job_index_task"("owner_id", "id");

-- CreateIndex
CREATE INDEX "task_attempt_owner_id_task_type_task_id_started_at_idx" ON "task_attempt"("owner_id", "task_type", "task_id", "started_at");

-- CreateIndex
CREATE INDEX "task_event_owner_id_task_type_task_id_seq_idx" ON "task_event"("owner_id", "task_type", "task_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "task_event_task_type_task_id_seq_key" ON "task_event"("task_type", "task_id", "seq");

-- CreateIndex
CREATE INDEX "consumer_receipt_owner_id_task_type_task_id_idx" ON "consumer_receipt"("owner_id", "task_type", "task_id");

-- CreateIndex
CREATE INDEX "consumer_receipt_status_lease_until_idx" ON "consumer_receipt"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_receipt_consumer_name_message_id_key" ON "consumer_receipt"("consumer_name", "message_id");

-- CreateIndex
CREATE INDEX "outbox_event_published_at_available_at_lease_until_idx" ON "outbox_event"("published_at", "available_at", "lease_until");

-- CreateIndex
CREATE INDEX "outbox_event_owner_id_aggregate_type_aggregate_id_idx" ON "outbox_event"("owner_id", "aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "quarantine_message_hash_created_at_idx" ON "quarantine"("message_hash", "created_at");

-- AddForeignKey
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_index_task" ADD CONSTRAINT "job_index_task_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_owner_id_analysis_task_id_fkey" FOREIGN KEY ("owner_id", "analysis_task_id") REFERENCES "analysis_task"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_owner_id_job_index_task_id_fkey" FOREIGN KEY ("owner_id", "job_index_task_id") REFERENCES "job_index_task"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_event" ADD CONSTRAINT "task_event_owner_id_analysis_task_id_fkey" FOREIGN KEY ("owner_id", "analysis_task_id") REFERENCES "analysis_task"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_event" ADD CONSTRAINT "task_event_owner_id_job_index_task_id_fkey" FOREIGN KEY ("owner_id", "job_index_task_id") REFERENCES "job_index_task"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumer_receipt" ADD CONSTRAINT "consumer_receipt_owner_id_analysis_task_id_fkey" FOREIGN KEY ("owner_id", "analysis_task_id") REFERENCES "analysis_task"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumer_receipt" ADD CONSTRAINT "consumer_receipt_owner_id_job_index_task_id_fkey" FOREIGN KEY ("owner_id", "job_index_task_id") REFERENCES "job_index_task"("owner_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Explicit SQL constraints are maintained here; Prisma cannot represent CHECKs/triggers.
INSERT INTO "owner" ("id") VALUES ('00000000-0000-4000-8000-000000000001');

ALTER TABLE "analysis_task"
  ADD CONSTRAINT "analysis_task_values_check" CHECK (
    generation > 0 AND fence_token >= 0 AND request_hash ~ '^[a-f0-9]{64}$'
    AND length(stage) > 0
    AND (lease_owner IS NULL) = (lease_until IS NULL)
    AND jsonb_typeof(budget_usage) = 'object'
  ),
  ADD CONSTRAINT "analysis_task_snapshot_check" CHECK ((
    jsonb_typeof(input_snapshot) = 'object'
    AND (input_snapshot->>'schemaVersion') = '1'
    AND (input_snapshot->>'kind') = 'synthetic'
    AND (input_snapshot->>'ownerId') = owner_id::text
    AND (input_snapshot->>'resumeVersionId') = resume_version_id::text
    AND graph_generation > 0
  ) IS TRUE);

CREATE FUNCTION "analysis_task_keep_input"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.resume_version_id IS DISTINCT FROM OLD.resume_version_id
  THEN
    RAISE EXCEPTION 'Task creation identity and input are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "analysis_task_keep_input" BEFORE UPDATE ON "analysis_task"
  FOR EACH ROW EXECUTE FUNCTION "analysis_task_keep_input"();

ALTER TABLE "job_index_task"
  ADD CONSTRAINT "job_index_task_values_check" CHECK (
    generation > 0 AND fence_token >= 0 AND request_hash ~ '^[a-f0-9]{64}$'
    AND length(stage) > 0
    AND (lease_owner IS NULL) = (lease_until IS NULL)
    AND jsonb_typeof(budget_usage) = 'object'
  ),
  ADD CONSTRAINT "job_index_task_snapshot_check" CHECK ((
    jsonb_typeof(input_snapshot) = 'object'
    AND (input_snapshot->>'schemaVersion') = '1'
    AND (input_snapshot->>'kind') = 'synthetic'
    AND (input_snapshot->>'ownerId') = owner_id::text
    AND (input_snapshot->>'jobVersionId') = job_version_id::text
    AND (input_snapshot->>'embeddingVersion') = embedding_version
    AND (input_snapshot->>'indexVersion') = index_version
  ) IS TRUE);

CREATE FUNCTION "job_index_task_keep_input"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.job_version_id IS DISTINCT FROM OLD.job_version_id
    OR NEW.embedding_version IS DISTINCT FROM OLD.embedding_version
    OR NEW.index_version IS DISTINCT FROM OLD.index_version
  THEN
    RAISE EXCEPTION 'Task creation identity and input are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "job_index_task_keep_input" BEFORE UPDATE ON "job_index_task"
  FOR EACH ROW EXECUTE FUNCTION "job_index_task_keep_input"();

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_task_reference_check" CHECK (
  (task_type = 'ANALYSIS' AND analysis_task_id IS NOT NULL AND job_index_task_id IS NULL AND task_id = analysis_task_id)
  OR (task_type = 'JOB_INDEX' AND job_index_task_id IS NOT NULL AND analysis_task_id IS NULL AND task_id = job_index_task_id)
);

ALTER TABLE "task_event" ADD CONSTRAINT "task_event_task_reference_check" CHECK (
  (task_type = 'ANALYSIS' AND analysis_task_id IS NOT NULL AND job_index_task_id IS NULL AND task_id = analysis_task_id)
  OR (task_type = 'JOB_INDEX' AND job_index_task_id IS NOT NULL AND analysis_task_id IS NULL AND task_id = job_index_task_id)
);

ALTER TABLE "consumer_receipt" ADD CONSTRAINT "consumer_receipt_task_reference_check" CHECK (
  (task_type = 'ANALYSIS' AND analysis_task_id IS NOT NULL AND job_index_task_id IS NULL AND task_id = analysis_task_id)
  OR (task_type = 'JOB_INDEX' AND job_index_task_id IS NOT NULL AND analysis_task_id IS NULL AND task_id = job_index_task_id)
);

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_values_check" CHECK (
  generation > 0 AND fence_token >= 0 AND tokens >= 0 AND cost_micros >= 0
  AND currency ~ '^[A-Z]{3}$'
  AND (ended_at IS NULL OR ended_at >= started_at)
  AND (trace_id IS NULL OR trace_id ~ '^[a-f0-9]{32}$')
);
ALTER TABLE "task_event" ADD CONSTRAINT "task_event_values_check" CHECK (
  seq > 0 AND length(stage) > 0 AND jsonb_typeof(counts) = 'object'
);
ALTER TABLE "consumer_receipt" ADD CONSTRAINT "consumer_receipt_values_check" CHECK (
  generation > 0 AND length(consumer_name) > 0
  AND (lease_owner IS NULL) = (lease_until IS NULL)
  AND (status = 'DONE') = (processed_at IS NOT NULL)
);
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_values_check" CHECK (
  payload_version > 0 AND publish_attempts >= 0 AND jsonb_typeof(payload) = 'object'
  AND length(aggregate_type) > 0 AND length(event_type) > 0
  AND (lease_owner IS NULL) = (lease_until IS NULL)
);
ALTER TABLE "quarantine" ADD CONSTRAINT "quarantine_values_check" CHECK (
  message_hash ~ '^[a-f0-9]{64}$' AND length(error_code) > 0
  AND jsonb_typeof(safe_metadata) = 'object'
);

COMMIT;

