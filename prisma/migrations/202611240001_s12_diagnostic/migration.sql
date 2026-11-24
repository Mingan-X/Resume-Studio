CREATE TABLE "s12_diagnostic_record" (
  "id" UUID NOT NULL,
  "run_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "s12_diagnostic_record_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "s12_diagnostic_record_key_key" ON "s12_diagnostic_record"("key");
CREATE INDEX "s12_diagnostic_record_run_id_idx" ON "s12_diagnostic_record"("run_id");
