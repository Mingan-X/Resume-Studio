BEGIN;

CREATE TABLE file_asset (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owner(id),
 storage_key uuid NOT NULL UNIQUE, sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 mime varchar(128) NOT NULL CHECK (mime IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 size integer NOT NULL CHECK (size > 0 AND size <= 10485760),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,id,sha256)
);
CREATE TABLE resume (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owner(id),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(owner_id,id)
);
CREATE INDEX resume_owner_id_created_at_id_idx ON resume(owner_id,created_at,id);
CREATE TABLE resume_version (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, resume_id uuid NOT NULL, version integer NOT NULL CHECK(version > 0),
 file_asset_id uuid NOT NULL, file_hash char(64) NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(resume_id,version), UNIQUE(owner_id,id), UNIQUE(owner_id,id,file_hash),
 FOREIGN KEY(owner_id,resume_id) REFERENCES resume(owner_id,id),
 FOREIGN KEY(owner_id,file_asset_id,file_hash) REFERENCES file_asset(owner_id,id,sha256)
);
CREATE TABLE evidence_block (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, source_version_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal >= 0), text text NOT NULL CHECK(length(btrim(text)) > 0),
 text_hash char(64) NOT NULL CHECK(text_hash ~ '^[a-f0-9]{64}$'), location jsonb NOT NULL CHECK(jsonb_typeof(location) = 'object'),
 UNIQUE(source_version_id,ordinal), UNIQUE(owner_id,source_version_id,id),
 FOREIGN KEY(owner_id,source_version_id) REFERENCES resume_version(owner_id,id)
);
CREATE TABLE resume_upload (
 owner_id uuid NOT NULL, idempotency_key uuid NOT NULL, file_hash char(64) NOT NULL,
 resume_version_id uuid NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(owner_id,idempotency_key),
 FOREIGN KEY(owner_id,resume_version_id,file_hash) REFERENCES resume_version(owner_id,id,file_hash)
);

CREATE FUNCTION reject_resume_content_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable resume content cannot be updated' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER file_asset_immutable BEFORE UPDATE ON file_asset FOR EACH ROW EXECUTE FUNCTION reject_resume_content_update();
CREATE TRIGGER resume_immutable BEFORE UPDATE ON resume FOR EACH ROW EXECUTE FUNCTION reject_resume_content_update();
CREATE TRIGGER resume_version_immutable BEFORE UPDATE ON resume_version FOR EACH ROW EXECUTE FUNCTION reject_resume_content_update();
CREATE TRIGGER evidence_block_immutable BEFORE UPDATE ON evidence_block FOR EACH ROW EXECUTE FUNCTION reject_resume_content_update();
CREATE TRIGGER resume_upload_immutable BEFORE UPDATE ON resume_upload FOR EACH ROW EXECUTE FUNCTION reject_resume_content_update();

-- Synthetic S1.4 tasks remain unchanged: their version UUIDs are not business FKs.
COMMIT;
