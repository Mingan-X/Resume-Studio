BEGIN;
ALTER TABLE node_artifact ADD COLUMN branch_key varchar(512), ADD COLUMN prompt_version varchar(64), ADD COLUMN model_config_version varchar(64);
ALTER TABLE node_artifact ADD CONSTRAINT analysis_node_identity_check CHECK ((
 (branch_key IS NULL AND prompt_version IS NULL AND model_config_version IS NULL)
 OR (task_type='ANALYSIS' AND branch_key IS NOT NULL AND length(branch_key)>0 AND prompt_version IS NOT NULL AND model_config_version IS NOT NULL
  AND validated_output->>'kind'='analysis-node'
  AND validated_output->'identity'->>'branchKey'=branch_key AND validated_output->'identity'->>'node'=node
  AND validated_output->'identity'->>'inputHash'=input_hash
  AND validated_output->'identity'->>'promptVersion'=prompt_version
  AND validated_output->'identity'->>'modelConfigVersion'=model_config_version)
) IS TRUE);
CREATE FUNCTION analysis_node_keep_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.branch_key IS NOT NULL THEN RAISE EXCEPTION 'Analysis node artifact is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER analysis_node_keep_content BEFORE UPDATE ON node_artifact FOR EACH ROW EXECUTE FUNCTION analysis_node_keep_content();
COMMIT;
