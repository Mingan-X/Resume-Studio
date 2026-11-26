BEGIN;

CREATE TABLE job (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owner(id),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id,id)
);
CREATE INDEX job_owner_id_created_at_id_idx ON job(owner_id,created_at,id);
CREATE TABLE job_version (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, job_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 title varchar(256) NOT NULL CHECK(length(btrim(title))>0), city varchar(128), level varchar(128), skills text[] NOT NULL,
 document jsonb NOT NULL, dimension_weights jsonb NOT NULL CHECK(jsonb_typeof(dimension_weights)='array'),
 hard_requirements_confirmed boolean NOT NULL DEFAULT false, weights_confirmed boolean NOT NULL DEFAULT false,
 status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED')),
 content_hash char(64), published_at timestamptz(3), index_status varchar(16) NOT NULL DEFAULT 'NOT_REQUESTED',
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(job_id,version), UNIQUE(owner_id,id), FOREIGN KEY(owner_id,job_id) REFERENCES job(owner_id,id),
 CHECK((jsonb_typeof(document)='object' AND document->>'sourceType'='JD' AND document->>'sourceVersionId'=id::text) IS TRUE),
 CHECK((status='DRAFT' AND content_hash IS NULL AND published_at IS NULL AND index_status='NOT_REQUESTED') OR
   (status='PUBLISHED' AND content_hash IS NOT NULL AND content_hash ~ '^[a-f0-9]{64}$' AND published_at IS NOT NULL
    AND hard_requirements_confirmed AND weights_confirmed AND index_status IN ('PENDING','READY','FAILED')))
);
CREATE TABLE job_requirement (
 owner_id uuid NOT NULL, job_version_id uuid NOT NULL, stable_id varchar(128) NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>=0), requirement jsonb NOT NULL,
 PRIMARY KEY(job_version_id,stable_id), UNIQUE(job_version_id,ordinal),
 FOREIGN KEY(owner_id,job_version_id) REFERENCES job_version(owner_id,id) ON DELETE CASCADE,
 CHECK((jsonb_typeof(requirement)='object' AND requirement->>'stableId'=stable_id
   AND requirement->'sourceRef'->>'sourceType'='JD'
   AND requirement->'sourceRef'->>'sourceVersionId'=job_version_id::text) IS TRUE)
);
CREATE INDEX job_requirement_owner_id_job_version_id_idx ON job_requirement(owner_id,job_version_id);
CREATE TABLE rubric_version (
 owner_id uuid NOT NULL REFERENCES owner(id), version varchar(64) NOT NULL,
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(owner_id,version), CHECK((jsonb_typeof(content)='object' AND content->>'version'=version) IS TRUE)
);

CREATE FUNCTION job_version_keep_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
   OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.version IS DISTINCT FROM OLD.version
   OR NEW.created_at IS DISTINCT FROM OLD.created_at
   OR (OLD.status='PUBLISHED' AND (to_jsonb(NEW)-'index_status') IS DISTINCT FROM (to_jsonb(OLD)-'index_status'))
 THEN RAISE EXCEPTION 'Job version identity and published content are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER job_version_keep_content BEFORE UPDATE ON job_version FOR EACH ROW EXECUTE FUNCTION job_version_keep_content();

CREATE FUNCTION job_requirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.job_version_id IS DISTINCT FROM OLD.job_version_id
   OR NEW.stable_id IS DISTINCT FROM OLD.stable_id) THEN
   RAISE EXCEPTION 'Requirement identity is immutable' USING ERRCODE='23514';
 END IF;
 -- Serialize requirement changes against publication, including concurrent INSERT.
 IF TG_OP='DELETE' THEN
   SELECT status INTO parent_status FROM job_version WHERE owner_id=OLD.owner_id AND id=OLD.job_version_id FOR UPDATE;
 ELSE
   SELECT status INTO parent_status FROM job_version WHERE owner_id=NEW.owner_id AND id=NEW.job_version_id FOR UPDATE;
 END IF;
 -- A parent DELETE cascades after removing its row; deleting one published requirement directly is forbidden.
 IF parent_status='PUBLISHED' THEN RAISE EXCEPTION 'Published requirements are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER job_requirement_guard BEFORE INSERT OR UPDATE OR DELETE ON job_requirement FOR EACH ROW EXECUTE FUNCTION job_requirement_guard();
CREATE FUNCTION rubric_keep_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Rubric version is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER rubric_keep_content BEFORE UPDATE ON rubric_version FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();

ALTER TABLE job_index_task ADD COLUMN real_job_version_id uuid;
ALTER TABLE job_index_task ADD CONSTRAINT job_index_task_real_version_fk FOREIGN KEY(owner_id,real_job_version_id) REFERENCES job_version(owner_id,id);
ALTER TABLE job_index_task DROP CONSTRAINT job_index_task_snapshot_check;
ALTER TABLE job_index_task ADD CONSTRAINT job_index_task_snapshot_check CHECK((
 jsonb_typeof(input_snapshot)='object' AND input_snapshot->>'schemaVersion'='1'
 AND input_snapshot->>'ownerId'=owner_id::text AND input_snapshot->>'jobVersionId'=job_version_id::text
 AND input_snapshot->>'embeddingVersion'=embedding_version AND input_snapshot->>'indexVersion'=index_version
 AND ((input_snapshot->>'kind'='synthetic' AND real_job_version_id IS NULL)
   OR (input_snapshot->>'kind'='job-index' AND real_job_version_id IS NOT NULL AND real_job_version_id=job_version_id))
) IS TRUE);
CREATE FUNCTION job_index_real_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.real_job_version_id IS DISTINCT FROM OLD.real_job_version_id THEN
   RAISE EXCEPTION 'Real task version identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.real_job_version_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM job_version WHERE owner_id=NEW.owner_id AND id=NEW.real_job_version_id AND status='PUBLISHED'
     AND document->>'textHash'=NEW.input_snapshot->>'contentHash'
 ) THEN RAISE EXCEPTION 'Real index task requires matching published content' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER job_index_real_version_guard BEFORE INSERT OR UPDATE ON job_index_task FOR EACH ROW EXECUTE FUNCTION job_index_real_version_guard();
COMMIT;
