-- Private control plane. No node secrets or subscription URLs in these tables.
CREATE TABLE managed_credentials (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, client TEXT NOT NULL,
 created INTEGER NOT NULL, updated INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE control_jobs (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, action TEXT NOT NULL,
 device_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
 lease TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 created INTEGER NOT NULL, finished INTEGER, error TEXT
);
CREATE UNIQUE INDEX control_pending_device ON control_jobs(device_id) WHERE state IN ('queued','running');
CREATE INDEX control_jobs_created ON control_jobs(created);
CREATE TABLE control_agent (id INTEGER PRIMARY KEY CHECK(id=1), seen INTEGER NOT NULL);
CREATE TABLE admin_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_id TEXT NOT NULL,
 action TEXT NOT NULL, device_id TEXT NOT NULL, outcome TEXT NOT NULL
);
CREATE INDEX admin_events_at ON admin_events(at);
