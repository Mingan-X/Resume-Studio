BEGIN;
CREATE TABLE analysis_configuration (
 owner_id uuid NOT NULL REFERENCES owner(id), version varchar(64) NOT NULL,
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(owner_id,version),
 CHECK((jsonb_typeof(content)='object' AND content->>'configurationVersion'=version) IS TRUE)
);
CREATE TRIGGER analysis_configuration_immutable BEFORE UPDATE ON analysis_configuration
 FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
ALTER TABLE analysis_task
 ADD COLUMN real_resume_version_id uuid,
 ADD COLUMN corpus_version varchar(64),
 ADD COLUMN rubric_version varchar(64),
 ADD COLUMN configuration_version varchar(64),
 ADD CONSTRAINT analysis_real_resume_fk FOREIGN KEY(owner_id,real_resume_version_id) REFERENCES resume_version(owner_id,id),
 ADD CONSTRAINT analysis_corpus_fk FOREIGN KEY(owner_id,corpus_version) REFERENCES job_corpus_version(owner_id,version),
 ADD CONSTRAINT analysis_rubric_fk FOREIGN KEY(owner_id,rubric_version) REFERENCES rubric_version(owner_id,version),
 ADD CONSTRAINT analysis_configuration_fk FOREIGN KEY(owner_id,configuration_version) REFERENCES analysis_configuration(owner_id,version);
ALTER TABLE analysis_task DROP CONSTRAINT analysis_task_snapshot_check;
ALTER TABLE analysis_task ADD CONSTRAINT analysis_task_snapshot_check CHECK ((
 jsonb_typeof(input_snapshot)='object' AND input_snapshot->>'schemaVersion'='1'
 AND input_snapshot->>'ownerId'=owner_id::text AND input_snapshot->>'resumeVersionId'=resume_version_id::text
 AND graph_generation>0 AND (
  (input_snapshot->>'kind'='synthetic' AND real_resume_version_id IS NULL AND corpus_version IS NULL
   AND rubric_version IS NULL AND configuration_version IS NULL)
  OR (input_snapshot->>'kind'='analysis' AND real_resume_version_id=resume_version_id
   AND corpus_version=input_snapshot->>'jobCorpusVersionId' AND rubric_version=input_snapshot->>'rubricVersion'
   AND configuration_version=input_snapshot->>'configurationVersion')
 )
) IS TRUE);
CREATE FUNCTION analysis_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.real_resume_version_id IS DISTINCT FROM OLD.real_resume_version_id
  OR NEW.corpus_version IS DISTINCT FROM OLD.corpus_version OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
  OR NEW.configuration_version IS DISTINCT FROM OLD.configuration_version) THEN
  RAISE EXCEPTION 'Analysis input identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.input_snapshot->>'kind'='analysis' AND NOT EXISTS (
  SELECT 1 FROM extracted_document d, job_corpus_version c, rubric_version r, analysis_configuration a
  WHERE d.owner_id=NEW.owner_id AND d.source_version_id=NEW.real_resume_version_id
   AND d.file_hash=NEW.input_snapshot->>'resumeFileHash'
   AND c.owner_id=NEW.owner_id AND c.version=NEW.corpus_version AND c.content_hash=NEW.input_snapshot->>'corpusHash'
   AND r.owner_id=NEW.owner_id AND r.version=NEW.rubric_version AND r.content_hash=NEW.input_snapshot->>'rubricHash'
   AND a.owner_id=NEW.owner_id AND a.version=NEW.configuration_version AND a.content_hash=NEW.input_snapshot->>'configurationHash'
   AND (NEW.input_snapshot - ARRAY['kind','ownerId','resumeVersionId','asOfDate','jobCorpusVersionId',
    'configurationHash','resumeFileHash','corpusHash','rubricHash'])=a.content
 ) THEN RAISE EXCEPTION 'Analysis requires frozen authorized resources' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_input_guard BEFORE INSERT OR UPDATE ON analysis_task FOR EACH ROW EXECUTE FUNCTION analysis_input_guard();
COMMIT;
