BEGIN;
CREATE TABLE scoring_policy (
 owner_id uuid NOT NULL REFERENCES owner(id), version varchar(64) NOT NULL,
 content jsonb NOT NULL, content_hash char(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(owner_id,version),
 CHECK((jsonb_typeof(content)='object' AND content->>'version'=version AND content->>'schemaVersion'='1') IS TRUE)
);
CREATE TRIGGER scoring_policy_immutable BEFORE UPDATE ON scoring_policy FOR EACH ROW EXECUTE FUNCTION rubric_keep_content();
COMMIT;
