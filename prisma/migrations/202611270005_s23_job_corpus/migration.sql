BEGIN;
CREATE TABLE job_corpus_version (
 owner_id uuid NOT NULL REFERENCES owner(id), version varchar(64) NOT NULL,
 visibility varchar(16) NOT NULL CHECK(visibility='private'),
 content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), manifest jsonb NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(owner_id,version),
 CHECK((jsonb_typeof(manifest)='object' AND manifest->>'schemaVersion'='1'
   AND manifest->>'ownerId'=owner_id::text AND manifest->>'version'=version
   AND manifest->>'visibility'=visibility AND jsonb_typeof(manifest->'members')='array') IS TRUE)
);
CREATE FUNCTION job_corpus_keep_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Job corpus version is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER job_corpus_keep_content BEFORE UPDATE ON job_corpus_version FOR EACH ROW EXECUTE FUNCTION job_corpus_keep_content();
COMMIT;
