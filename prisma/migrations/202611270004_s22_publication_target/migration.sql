BEGIN;
CREATE TABLE job_index_target (
 owner_id uuid NOT NULL, job_version_id uuid PRIMARY KEY, task_id uuid NOT NULL,
 embedding_version varchar(64) NOT NULL, index_version varchar(64) NOT NULL,
 UNIQUE(owner_id,job_version_id),
 FOREIGN KEY(owner_id,job_version_id) REFERENCES job_version(owner_id,id),
 FOREIGN KEY(owner_id,task_id) REFERENCES job_index_task(owner_id,id)
);
CREATE FUNCTION job_index_target_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.job_version_id IS DISTINCT FROM OLD.job_version_id) THEN
   RAISE EXCEPTION 'Index target identity is immutable' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM job_index_task WHERE owner_id=NEW.owner_id AND id=NEW.task_id
   AND real_job_version_id=NEW.job_version_id AND embedding_version=NEW.embedding_version AND index_version=NEW.index_version)
 THEN RAISE EXCEPTION 'Index target must match its real task' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER job_index_target_guard BEFORE INSERT OR UPDATE ON job_index_target FOR EACH ROW EXECUTE FUNCTION job_index_target_guard();
COMMIT;
