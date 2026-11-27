BEGIN;
CREATE TABLE profile_assessment (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, task_id uuid NOT NULL,
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(owner_id,task_id) REFERENCES analysis_task(owner_id,id), UNIQUE(owner_id,task_id), UNIQUE(owner_id,id),
 CHECK((content->>'taskId'=task_id::text AND content->>'schemaVersion'='1') IS TRUE)
);
CREATE TRIGGER profile_assessment_immutable BEFORE UPDATE ON profile_assessment FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
COMMIT;
