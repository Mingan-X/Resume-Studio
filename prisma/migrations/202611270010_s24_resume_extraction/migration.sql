BEGIN;
CREATE TABLE resume_extraction (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, resume_version_id uuid NOT NULL,
 prompt_version varchar(64) NOT NULL, model_config_version varchar(64) NOT NULL, schema_version integer NOT NULL CHECK(schema_version=1),
 input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 content jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(owner_id,resume_version_id) REFERENCES resume_version(owner_id,id),
 UNIQUE(owner_id,resume_version_id,prompt_version,model_config_version,schema_version), UNIQUE(owner_id,id),
 CHECK((content->>'resumeVersionId'=resume_version_id::text AND content->>'schemaVersion'='1') IS TRUE)
);
CREATE TRIGGER resume_extraction_immutable BEFORE UPDATE ON resume_extraction FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
COMMIT;
