BEGIN;
CREATE TABLE extracted_document (
 source_version_id uuid PRIMARY KEY, owner_id uuid NOT NULL, file_hash char(64) NOT NULL,
 document jsonb NOT NULL CHECK(jsonb_typeof(document) = 'object'),
 created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,source_version_id,file_hash),
 FOREIGN KEY(owner_id,source_version_id,file_hash) REFERENCES resume_version(owner_id,id,file_hash),
 CHECK(document->>'sourceVersionId' = source_version_id::text AND document->>'fileHash' = file_hash
   AND document->>'sourceType' = 'RESUME' AND document->>'schemaVersion' = '1')
);
CREATE TRIGGER extracted_document_immutable BEFORE UPDATE ON extracted_document FOR EACH ROW EXECUTE FUNCTION reject_resume_content_update();
CREATE FUNCTION reject_sealed_block_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM resume_version WHERE id=NEW.source_version_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM extracted_document WHERE source_version_id=NEW.source_version_id) THEN
   RAISE EXCEPTION 'Parsed version is sealed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_block_sealed BEFORE INSERT ON evidence_block FOR EACH ROW EXECUTE FUNCTION reject_sealed_block_insert();
COMMIT;
