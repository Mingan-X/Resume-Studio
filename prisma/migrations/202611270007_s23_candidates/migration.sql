BEGIN;
CREATE TABLE candidate_set (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, task_id uuid NOT NULL UNIQUE,
 corpus_version varchar(64) NOT NULL, status varchar(16) NOT NULL DEFAULT 'BUILDING' CHECK(status IN ('BUILDING','FROZEN')),
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,id), UNIQUE(owner_id,task_id),
 FOREIGN KEY(owner_id,task_id) REFERENCES analysis_task(owner_id,id),
 FOREIGN KEY(owner_id,corpus_version) REFERENCES job_corpus_version(owner_id,version),
 CHECK((jsonb_typeof(content)='object' AND content->>'schemaVersion'='1' AND content->>'ownerId'=owner_id::text
  AND content->>'taskId'=task_id::text AND content->'recall'->>'corpusVersion'=corpus_version) IS TRUE)
);
CREATE TABLE candidate (
 owner_id uuid NOT NULL, set_id uuid NOT NULL, job_version_id uuid NOT NULL,
 rank integer NOT NULL CHECK(rank BETWEEN 1 AND 20), content jsonb NOT NULL,
 PRIMARY KEY(set_id,job_version_id), UNIQUE(set_id,rank),
 FOREIGN KEY(owner_id,set_id) REFERENCES candidate_set(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,job_version_id) REFERENCES job_version(owner_id,id),
 CHECK((content->>'jobVersionId'=job_version_id::text AND content->>'rank'=rank::text) IS TRUE)
);
CREATE FUNCTION candidate_set_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.status<>'BUILDING' THEN RAISE EXCEPTION 'Candidate set starts building' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status<>'BUILDING' OR NEW.status<>'FROZEN' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')
  THEN RAISE EXCEPTION 'Candidate set is immutable' USING ERRCODE='23514'; END IF;
  IF (SELECT COALESCE(jsonb_agg(content ORDER BY rank),'[]'::jsonb) FROM candidate WHERE set_id=NEW.id AND owner_id=NEW.owner_id)
    IS DISTINCT FROM NEW.content->'recall'->'candidates'
  THEN RAISE EXCEPTION 'Candidate set members do not match snapshot' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER candidate_set_guard BEFORE INSERT OR UPDATE ON candidate_set FOR EACH ROW EXECUTE FUNCTION candidate_set_guard();
CREATE FUNCTION candidate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
 IF TG_OP='DELETE' THEN
  SELECT status INTO parent_status FROM candidate_set WHERE owner_id=OLD.owner_id AND id=OLD.set_id FOR UPDATE;
 ELSE
  SELECT status INTO parent_status FROM candidate_set WHERE owner_id=NEW.owner_id AND id=NEW.set_id FOR UPDATE;
 END IF;
 IF TG_OP='UPDATE' OR parent_status='FROZEN' THEN RAISE EXCEPTION 'Frozen candidate is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER candidate_guard BEFORE INSERT OR UPDATE OR DELETE ON candidate FOR EACH ROW EXECUTE FUNCTION candidate_guard();
COMMIT;
