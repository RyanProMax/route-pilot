CREATE TABLE IF NOT EXISTS rp_cloudflare_usage (
  scope TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  sampled_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT
);
