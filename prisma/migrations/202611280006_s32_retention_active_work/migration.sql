BEGIN;
CREATE OR REPLACE FUNCTION lifecycle_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resume_id uuid; linked_task uuid;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.owner_id::text,7325));
 IF EXISTS(SELECT 1 FROM deletion_request WHERE owner_id=NEW.owner_id AND scope='ALL' AND status<>'DONE') THEN
  RAISE EXCEPTION 'DATA_DELETION_PENDING' USING ERRCODE='P7325';
 END IF;
 IF TG_TABLE_NAME='analysis_task' THEN resume_id=NEW.real_resume_version_id;
 ELSIF TG_TABLE_NAME IN ('analysis_report','score_set') THEN
  SELECT real_resume_version_id INTO resume_id FROM analysis_task WHERE owner_id=NEW.owner_id AND id=NEW.task_id;
 ELSIF TG_TABLE_NAME='ranking_snapshot' THEN
  SELECT task_id INTO linked_task FROM score_set WHERE owner_id=NEW.owner_id AND id=NEW.score_set_id;
  SELECT real_resume_version_id INTO resume_id FROM analysis_task WHERE owner_id=NEW.owner_id AND id=linked_task;
 END IF;
 IF resume_id IS NOT NULL AND EXISTS(SELECT 1 FROM deletion_request WHERE owner_id=NEW.owner_id AND scope='RESUME' AND resume_version_id=resume_id
  AND (TG_TABLE_NAME='analysis_task' AND status<>'DONE' OR TG_TABLE_NAME<>'analysis_task' AND status='RUNNING')) THEN
  RAISE EXCEPTION 'DATA_DELETION_PENDING' USING ERRCODE='P7325';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
