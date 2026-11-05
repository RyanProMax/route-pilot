CREATE TABLE samples (
  check_id TEXT NOT NULL, minute INTEGER NOT NULL, ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','degraded','down','unknown')), latency INTEGER,
  message TEXT NOT NULL, PRIMARY KEY(check_id,minute)
) WITHOUT ROWID;
CREATE INDEX samples_age ON samples(ts);
CREATE TABLE latest (
  check_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, status TEXT NOT NULL,
  latency INTEGER, message TEXT NOT NULL
);
CREATE TABLE reports (
  minute INTEGER PRIMARY KEY, ts INTEGER NOT NULL, metrics TEXT NOT NULL, egress TEXT NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, check_id TEXT NOT NULL,
  status TEXT NOT NULL, previous TEXT, message TEXT NOT NULL
);
CREATE INDEX events_age ON events(ts);
CREATE TABLE buckets (
  width INTEGER NOT NULL, bucket INTEGER NOT NULL, check_id TEXT NOT NULL,
  n INTEGER NOT NULL, ok INTEGER NOT NULL, slow INTEGER NOT NULL,
  down INTEGER NOT NULL, missing INTEGER NOT NULL, latency_sum INTEGER NOT NULL, latency_n INTEGER NOT NULL,
  PRIMARY KEY(width,bucket,check_id)
) WITHOUT ROWID;
CREATE TRIGGER store_sample AFTER INSERT ON samples BEGIN
  INSERT INTO events(ts,check_id,status,previous,message)
    SELECT NEW.ts, NEW.check_id, NEW.status, status, NEW.message FROM latest
    WHERE check_id=NEW.check_id AND ts<=NEW.ts AND status<>NEW.status;
  INSERT INTO events(ts,check_id,status,previous,message)
    SELECT NEW.ts, NEW.check_id, NEW.status, NULL, NEW.message
    WHERE NEW.status IN ('down','degraded') AND NOT EXISTS(SELECT 1 FROM latest WHERE check_id=NEW.check_id);
  INSERT INTO latest VALUES(NEW.check_id,NEW.ts,NEW.status,NEW.latency,NEW.message)
    ON CONFLICT(check_id) DO UPDATE SET ts=excluded.ts,status=excluded.status,
      latency=excluded.latency,message=excluded.message WHERE latest.ts<=excluded.ts;
  INSERT INTO buckets
    SELECT width, (NEW.ts/width)*width, NEW.check_id, 1, NEW.status='ok', NEW.status='degraded',
      NEW.status='down',NEW.status='unknown',COALESCE(NEW.latency,0),NEW.latency IS NOT NULL
    FROM (SELECT 1200 AS width UNION ALL SELECT 8400 UNION ALL SELECT 36000) WHERE 1
    ON CONFLICT(width,bucket,check_id) DO UPDATE SET n=n+1,ok=ok+excluded.ok,
      slow=slow+excluded.slow,down=down+excluded.down,missing=missing+excluded.missing,
      latency_sum=latency_sum+excluded.latency_sum,latency_n=latency_n+excluded.latency_n;
END;
