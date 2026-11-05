-- Never exposed by the public status projection.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL
);
CREATE TABLE admin_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires);
CREATE TABLE credential_usage (
  id TEXT NOT NULL, month TEXT NOT NULL, label TEXT NOT NULL, revoked INTEGER NOT NULL,
  online INTEGER NOT NULL, uplink INTEGER NOT NULL, downlink INTEGER NOT NULL,
  since INTEGER NOT NULL, at INTEGER NOT NULL, gaps INTEGER NOT NULL,
  PRIMARY KEY(id,month)
);
