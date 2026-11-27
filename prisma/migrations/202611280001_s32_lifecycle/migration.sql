BEGIN;
CREATE TABLE deletion_request (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES owner(id),scope varchar(16) NOT NULL CHECK(scope IN ('ALL','RESUME')),
 resume_version_id uuid,idempotency_key varchar(80) NOT NULL,status varchar(16) NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','RUNNING','DONE')),
 reason varchar(64),created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,completed_at timestamptz(3),
 UNIQUE(owner_id,idempotency_key),CHECK((scope='ALL' AND resume_version_id IS NULL) OR (scope='RESUME' AND resume_version_id IS NOT NULL))
);
CREATE INDEX deletion_request_pending ON deletion_request(status,created_at);
CREATE UNIQUE INDEX deletion_owner_active ON deletion_request(owner_id) WHERE scope='ALL' AND status<>'DONE';
CREATE UNIQUE INDEX deletion_resume_active ON deletion_request(owner_id,resume_version_id) WHERE scope='RESUME' AND status<>'DONE';
CREATE TABLE deletion_step(id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES deletion_request(id) ON DELETE CASCADE,
 resource_key varchar(128) NOT NULL,resource jsonb NOT NULL,completed_at timestamptz(3),attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),retry_at timestamptz(3),UNIQUE(request_id,resource_key));
CREATE TABLE resource_operation(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES owner(id) ON DELETE CASCADE,kind varchar(32) NOT NULL,
 stopped_at timestamptz(3),created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX resource_operation_active ON resource_operation(owner_id,stopped_at);
CREATE TABLE resource_trace(trace_id char(32) PRIMARY KEY CHECK(trace_id ~ '^[a-f0-9]{32}$'),owner_id uuid NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
 task_id uuid,created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX resource_trace_scope ON resource_trace(owner_id,task_id);
ALTER TABLE analysis_task ADD COLUMN lifecycle_history_complete boolean NOT NULL DEFAULT true;
UPDATE analysis_task SET lifecycle_history_complete=false WHERE graph_generation>1;
CREATE TABLE task_checkpoint_thread(thread_id uuid PRIMARY KEY,owner_id uuid NOT NULL,task_id uuid NOT NULL,
 FOREIGN KEY(owner_id,task_id) REFERENCES analysis_task(owner_id,id) ON DELETE CASCADE);
CREATE INDEX checkpoint_thread_task ON task_checkpoint_thread(owner_id,task_id);
INSERT INTO task_checkpoint_thread SELECT active_graph_thread_id,owner_id,id FROM analysis_task;
CREATE FUNCTION record_checkpoint_thread() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO task_checkpoint_thread(thread_id,owner_id,task_id) VALUES(NEW.active_graph_thread_id,NEW.owner_id,NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW; END $$;
CREATE TRIGGER checkpoint_thread_history AFTER INSERT OR UPDATE OF active_graph_thread_id ON analysis_task FOR EACH ROW EXECUTE FUNCTION record_checkpoint_thread();

-- Same owner lock as deletion request creation. All business writers wait for the
-- committed deletion barrier; workers may still record cancellation/stopped evidence.
CREATE FUNCTION lifecycle_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.owner_id::text,7325));
 IF EXISTS(SELECT 1 FROM deletion_request WHERE owner_id=NEW.owner_id AND scope='ALL' AND status<>'DONE') THEN
  RAISE EXCEPTION 'DATA_DELETION_PENDING' USING ERRCODE='P7325';
 END IF;
 IF TG_TABLE_NAME='analysis_task' THEN
  IF EXISTS(SELECT 1 FROM deletion_request WHERE owner_id=NEW.owner_id AND scope='RESUME' AND resume_version_id=NEW.real_resume_version_id AND status<>'DONE') THEN
   RAISE EXCEPTION 'DATA_DELETION_PENDING' USING ERRCODE='P7325';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['analysis_task','job_index_task','resume','file_asset','resume_version','resource_operation'] LOOP
  EXECUTE format('CREATE TRIGGER lifecycle_insert_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_write_guard()',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['job','job_version','job_corpus_version','rubric_version','scoring_policy','analysis_configuration','analysis_report','score_set','ranking_snapshot','resource_trace'] LOOP
  EXECUTE format('CREATE TRIGGER lifecycle_write_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION lifecycle_write_guard()',name);
 END LOOP;
END $$;
COMMIT;
