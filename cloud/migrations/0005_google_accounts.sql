-- Invalidate legacy key sessions. Authentication now belongs to RP accounts.
DROP TABLE admin_sessions;
CREATE TABLE rp_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  google_sub TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'admin',
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  created INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE rp_sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES rp_accounts(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX rp_sessions_expiry ON rp_sessions(expires);
CREATE INDEX rp_sessions_account ON rp_sessions(account_id);
CREATE TABLE oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX oauth_attempts_expiry ON oauth_attempts(expires);
