BEGIN;
ALTER TABLE analysis_task ADD COLUMN scoring_policy_version varchar(64),
 ADD CONSTRAINT analysis_scoring_policy_fk FOREIGN KEY(owner_id,scoring_policy_version) REFERENCES scoring_policy(owner_id,version),
 ADD CONSTRAINT analysis_scoring_policy_check CHECK ((
  (NOT (input_snapshot ? 'scoringPolicyHash') AND scoring_policy_version IS NULL)
  OR (input_snapshot->>'kind'='analysis' AND scoring_policy_version IS NOT NULL
    AND input_snapshot->>'scoringVersion'=scoring_policy_version AND input_snapshot->>'scoringPolicyHash' ~ '^[a-f0-9]{64}$')
 ) IS TRUE);
CREATE OR REPLACE FUNCTION analysis_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.real_resume_version_id IS DISTINCT FROM OLD.real_resume_version_id
  OR NEW.corpus_version IS DISTINCT FROM OLD.corpus_version OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
  OR NEW.configuration_version IS DISTINCT FROM OLD.configuration_version OR NEW.scoring_policy_version IS DISTINCT FROM OLD.scoring_policy_version) THEN
  RAISE EXCEPTION 'Analysis input identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.input_snapshot->>'kind'='analysis' AND NOT EXISTS (
  SELECT 1 FROM extracted_document d, job_corpus_version c, rubric_version r, analysis_configuration a, scoring_policy p
  WHERE d.owner_id=NEW.owner_id AND d.source_version_id=NEW.real_resume_version_id AND d.file_hash=NEW.input_snapshot->>'resumeFileHash'
   AND c.owner_id=NEW.owner_id AND c.version=NEW.corpus_version AND c.content_hash=NEW.input_snapshot->>'corpusHash'
   AND r.owner_id=NEW.owner_id AND r.version=NEW.rubric_version AND r.content_hash=NEW.input_snapshot->>'rubricHash'
   AND a.owner_id=NEW.owner_id AND a.version=NEW.configuration_version AND a.content_hash=NEW.input_snapshot->>'configurationHash'
   AND p.owner_id=NEW.owner_id AND p.version=NEW.scoring_policy_version AND p.content_hash=NEW.input_snapshot->>'scoringPolicyHash'
   AND (NEW.input_snapshot - ARRAY['kind','ownerId','resumeVersionId','asOfDate','jobCorpusVersionId',
    'configurationHash','resumeFileHash','corpusHash','rubricHash','scoringPolicyHash'])=a.content
 ) THEN RAISE EXCEPTION 'Analysis requires frozen authorized resources' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TABLE score_set (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, task_id uuid NOT NULL, policy_version varchar(64) NOT NULL,
 source_score_set_id uuid, operation_key char(64) NOT NULL UNIQUE CHECK(operation_key ~ '^[a-f0-9]{64}$'),
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,task_id) REFERENCES analysis_task(owner_id,id),
 FOREIGN KEY(owner_id,policy_version) REFERENCES scoring_policy(owner_id,version),
 FOREIGN KEY(owner_id,source_score_set_id) REFERENCES score_set(owner_id,id),
 CHECK((content->>'taskId'=task_id::text AND content->'policy'->>'version'=policy_version AND content->>'schemaVersion'='1') IS TRUE)
);
CREATE INDEX score_set_task_idx ON score_set(owner_id,task_id);
CREATE UNIQUE INDEX score_set_original_task_idx ON score_set(owner_id,task_id) WHERE source_score_set_id IS NULL;
CREATE TRIGGER score_set_immutable BEFORE UPDATE ON score_set FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
CREATE TABLE ranking_snapshot (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, score_set_id uuid NOT NULL UNIQUE,
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,score_set_id) REFERENCES score_set(owner_id,id)
);
CREATE UNIQUE INDEX ranking_snapshot_owner_score_key ON ranking_snapshot(owner_id,score_set_id);
CREATE TRIGGER ranking_snapshot_immutable BEFORE UPDATE ON ranking_snapshot FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
COMMIT;
