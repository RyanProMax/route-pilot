-- One immutable row per source and completed 20-minute window.
-- Existing minute samples, latest, events and three-resolution buckets are retained.
CREATE TABLE aggregate_windows (
  source TEXT NOT NULL CHECK(source IN ('vps','mac')),
  start INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(source,start)
) WITHOUT ROWID;
