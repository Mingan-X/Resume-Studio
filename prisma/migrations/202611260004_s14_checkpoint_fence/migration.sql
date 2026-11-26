BEGIN;
ALTER TABLE task_attempt ADD COLUMN execution_stopped_at TIMESTAMP(3);
CREATE TABLE node_artifact (
  id UUID PRIMARY KEY, owner_id UUID NOT NULL, task_type "TaskType" NOT NULL, task_id UUID NOT NULL,
  analysis_task_id UUID, job_index_task_id UUID, operation_key CHAR(64) NOT NULL,
  node VARCHAR(64) NOT NULL, input_hash CHAR(64) NOT NULL, component_version VARCHAR(64) NOT NULL,
  schema_version INTEGER NOT NULL, fence_token BIGINT NOT NULL, validated_output JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT node_artifact_owner_id_analysis_task_id_fkey FOREIGN KEY(owner_id,analysis_task_id) REFERENCES analysis_task(owner_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT node_artifact_owner_id_job_index_task_id_fkey FOREIGN KEY(owner_id,job_index_task_id) REFERENCES job_index_task(owner_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT node_artifact_task_check CHECK (
    (task_type='ANALYSIS' AND analysis_task_id IS NOT NULL AND job_index_task_id IS NULL AND task_id=analysis_task_id) OR
    (task_type='JOB_INDEX' AND job_index_task_id IS NOT NULL AND analysis_task_id IS NULL AND task_id=job_index_task_id)),
  CONSTRAINT node_artifact_values_check CHECK (operation_key ~ '^[a-f0-9]{64}$' AND input_hash ~ '^[a-f0-9]{64}$'
    AND schema_version>0 AND fence_token>=0 AND jsonb_typeof(validated_output)='object')
);
CREATE UNIQUE INDEX node_artifact_operation_key_key ON node_artifact(operation_key);
CREATE INDEX node_artifact_owner_id_task_type_task_id_idx ON node_artifact(owner_id,task_type,task_id);
CREATE TABLE synthetic_index_target (
  id UUID PRIMARY KEY, owner_id UUID NOT NULL, job_version_id UUID NOT NULL,
  embedding_version VARCHAR(64) NOT NULL, index_version VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING', completed_by_task_id UUID,
  CONSTRAINT synthetic_index_target_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES owner(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT synthetic_index_target_status_check CHECK (status IN ('PENDING','READY'))
);
CREATE UNIQUE INDEX synthetic_index_target_owner_id_id_key ON synthetic_index_target(owner_id,id);
CREATE FUNCTION analysis_task_graph_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.graph_generation < OLD.graph_generation
    OR (NEW.active_graph_thread_id IS DISTINCT FROM OLD.active_graph_thread_id AND NEW.graph_generation <= OLD.graph_generation)
    OR (NEW.graph_generation > OLD.graph_generation AND NEW.active_graph_thread_id = OLD.active_graph_thread_id)
  THEN RAISE EXCEPTION 'Graph generation/thread must advance together' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_task_graph_guard BEFORE UPDATE ON analysis_task FOR EACH ROW EXECUTE FUNCTION analysis_task_graph_guard();
COMMIT;
