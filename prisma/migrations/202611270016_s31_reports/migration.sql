BEGIN;
CREATE TABLE analysis_report (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL,task_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 root_report_id uuid NOT NULL,source_report_id uuid,operation_key char(64) NOT NULL UNIQUE,
 input_snapshot jsonb NOT NULL,content jsonb NOT NULL,content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,id),UNIQUE(task_id,revision),FOREIGN KEY(owner_id,task_id) REFERENCES analysis_task(owner_id,id),
 FOREIGN KEY(owner_id,source_report_id) REFERENCES analysis_report(owner_id,id),
 CHECK((content->>'taskId'=task_id::text AND content->>'schemaVersion'='1' AND input_snapshot->>'ownerId'=owner_id::text) IS TRUE),
 CHECK((revision=1 AND source_report_id IS NULL AND root_report_id=id) OR (revision>1 AND source_report_id IS NOT NULL))
);
CREATE INDEX analysis_report_page_idx ON analysis_report(owner_id,created_at,id);
CREATE TRIGGER analysis_report_immutable BEFORE UPDATE ON analysis_report FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
CREATE TABLE report_recompute_request (
 owner_id uuid NOT NULL,idempotency_key uuid NOT NULL,request_hash char(64) NOT NULL,report_id uuid NOT NULL,
 PRIMARY KEY(owner_id,idempotency_key),FOREIGN KEY(owner_id,report_id) REFERENCES analysis_report(owner_id,id)
);
CREATE TRIGGER report_recompute_request_immutable BEFORE UPDATE ON report_recompute_request FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
-- Historical task rows retain their original snapshot and completion semantics.
CREATE OR REPLACE FUNCTION analysis_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.real_resume_version_id IS DISTINCT FROM OLD.real_resume_version_id
  OR NEW.corpus_version IS DISTINCT FROM OLD.corpus_version OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
  OR NEW.configuration_version IS DISTINCT FROM OLD.configuration_version OR NEW.scoring_policy_version IS DISTINCT FROM OLD.scoring_policy_version) THEN
  RAISE EXCEPTION 'Analysis input identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.input_snapshot->>'kind'='analysis' AND NOT EXISTS (
  SELECT 1 FROM extracted_document d,job_corpus_version c,rubric_version r,analysis_configuration a,scoring_policy p
  WHERE d.owner_id=NEW.owner_id AND d.source_version_id=NEW.real_resume_version_id AND d.file_hash=NEW.input_snapshot->>'resumeFileHash'
   AND c.owner_id=NEW.owner_id AND c.version=NEW.corpus_version AND c.content_hash=NEW.input_snapshot->>'corpusHash'
   AND r.owner_id=NEW.owner_id AND r.version=NEW.rubric_version AND r.content_hash=NEW.input_snapshot->>'rubricHash'
   AND a.owner_id=NEW.owner_id AND a.version=NEW.configuration_version AND a.content_hash=NEW.input_snapshot->>'configurationHash'
   AND p.owner_id=NEW.owner_id AND p.version=NEW.scoring_policy_version AND p.content_hash=NEW.input_snapshot->>'scoringPolicyHash'
   AND NEW.input_snapshot->>'reportVersion'='1'
   AND (NEW.input_snapshot-ARRAY['kind','ownerId','resumeVersionId','asOfDate','jobCorpusVersionId','configurationHash','resumeFileHash','corpusHash','rubricHash','scoringPolicyHash','reportVersion'])=a.content
 ) THEN RAISE EXCEPTION 'Analysis requires frozen authorized resources' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
COMMIT;
