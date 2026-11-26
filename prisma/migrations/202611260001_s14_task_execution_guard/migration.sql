BEGIN;

CREATE FUNCTION "analysis_task_execution_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fence_token < OLD.fence_token OR NEW.generation < OLD.generation
    OR (OLD.status::text IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status)
  THEN
    RAISE EXCEPTION 'Task execution generation/fence/terminal state cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "analysis_task_execution_guard" BEFORE UPDATE ON "analysis_task"
  FOR EACH ROW EXECUTE FUNCTION "analysis_task_execution_guard"();

CREATE FUNCTION "job_index_task_execution_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fence_token < OLD.fence_token OR NEW.generation < OLD.generation
    OR (OLD.status::text IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status)
  THEN
    RAISE EXCEPTION 'Task execution generation/fence/terminal state cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "job_index_task_execution_guard" BEFORE UPDATE ON "job_index_task"
  FOR EACH ROW EXECUTE FUNCTION "job_index_task_execution_guard"();

COMMIT;
