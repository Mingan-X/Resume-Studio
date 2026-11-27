BEGIN;
ALTER TABLE resource_trace ADD COLUMN observed_at timestamptz(3),ADD COLUMN delete_requested_at timestamptz(3);
-- Confirmation metadata must remain writable while the owner deletion barrier holds.
DROP TRIGGER lifecycle_write_guard ON resource_trace;
CREATE TRIGGER lifecycle_write_guard BEFORE INSERT ON resource_trace FOR EACH ROW EXECUTE FUNCTION lifecycle_write_guard();
COMMIT;
