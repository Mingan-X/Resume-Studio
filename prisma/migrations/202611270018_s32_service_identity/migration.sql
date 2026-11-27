BEGIN;
-- Dedicated quarantine/dead-event principal; never an account or HTTP identity.
INSERT INTO owner(id) VALUES ('00000000-0000-4000-8000-000000000002');
ALTER TABLE account ADD CONSTRAINT account_business_owner CHECK(owner_id NOT IN
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'));
COMMIT;
