BEGIN;
CREATE TABLE job_index_request (
 owner_id uuid NOT NULL, idempotency_key uuid NOT NULL,
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 task_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(owner_id,idempotency_key),
 FOREIGN KEY(owner_id,task_id) REFERENCES job_index_task(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX job_index_request_owner_id_task_id_idx ON job_index_request(owner_id,task_id);
CREATE FUNCTION job_index_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Index request identity is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM job_index_task WHERE owner_id=NEW.owner_id AND id=NEW.task_id AND real_job_version_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Index request requires a real index task' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER job_index_request_guard BEFORE INSERT OR UPDATE ON job_index_request FOR EACH ROW EXECUTE FUNCTION job_index_request_guard();
COMMIT;
