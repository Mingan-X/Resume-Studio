BEGIN;
CREATE TABLE account (
 id uuid PRIMARY KEY,owner_id uuid NOT NULL UNIQUE REFERENCES owner(id),username varchar(64) NOT NULL UNIQUE,
 password_hash varchar(256) NOT NULL,enabled boolean NOT NULL DEFAULT true,failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts>=0),
 locked_until timestamptz(3),created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(username ~ '^[a-z0-9][a-z0-9._-]{2,63}$')
);
CREATE TABLE auth_session (
 token_hash char(64) PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),account_id uuid REFERENCES account(id) ON DELETE CASCADE,
 expires_at timestamptz(3) NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_session_expiry_idx ON auth_session(expires_at);
COMMIT;
