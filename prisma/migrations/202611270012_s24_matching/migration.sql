BEGIN;
CREATE TABLE match_plan (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, task_id uuid NOT NULL,
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(owner_id,task_id) REFERENCES analysis_task(owner_id,id), UNIQUE(owner_id,task_id), UNIQUE(owner_id,id),
 CHECK((content->>'taskId'=task_id::text AND content->>'schemaVersion'='1') IS TRUE)
);
CREATE TRIGGER match_plan_immutable BEFORE UPDATE ON match_plan FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
CREATE TABLE requirement_execution (
 owner_id uuid NOT NULL, plan_id uuid NOT NULL, job_version_id uuid NOT NULL, requirement_id varchar(128) NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=0), status varchar(16) NOT NULL CHECK(status IN ('PENDING','DONE','FAILED','BUDGET')),
 judgment jsonb, error_code varchar(64), PRIMARY KEY(plan_id,job_version_id,requirement_id), UNIQUE(plan_id,ordinal),
 FOREIGN KEY(owner_id,plan_id) REFERENCES match_plan(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,job_version_id) REFERENCES job_version(owner_id,id),
 CHECK((status='PENDING' AND judgment IS NULL AND error_code IS NULL)
 OR (status='DONE' AND judgment IS NOT NULL AND error_code IS NULL)
 OR (status IN ('FAILED','BUDGET') AND judgment IS NULL AND error_code IS NOT NULL))
);
CREATE FUNCTION requirement_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.job_version_id IS DISTINCT FROM OLD.job_version_id
 OR NEW.requirement_id IS DISTINCT FROM OLD.requirement_id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR OLD.status<>'PENDING'
 THEN RAISE EXCEPTION 'Requirement result and plan identity are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER requirement_execution_guard BEFORE UPDATE ON requirement_execution FOR EACH ROW EXECUTE FUNCTION requirement_execution_guard();
COMMIT;
