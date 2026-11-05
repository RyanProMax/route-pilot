CREATE TABLE connection_buckets (
  width INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  samples INTEGER NOT NULL,
  peak INTEGER NOT NULL,
  PRIMARY KEY(width, bucket)
) WITHOUT ROWID;

CREATE TRIGGER store_connections AFTER INSERT ON reports
WHEN json_type(NEW.metrics, '$.connections') = 'integer'
  AND json_extract(NEW.metrics, '$.connections') >= 0
BEGIN
  INSERT INTO connection_buckets
    SELECT width, (NEW.ts / width) * width, 1, json_extract(NEW.metrics, '$.connections')
    FROM (SELECT 1200 AS width UNION ALL SELECT 8400 UNION ALL SELECT 36000)
    WHERE 1
    ON CONFLICT(width, bucket) DO UPDATE SET
      samples = samples + 1,
      peak = MAX(peak, excluded.peak);
END;

INSERT INTO connection_buckets
  SELECT width, (ts / width) * width, COUNT(*), MAX(json_extract(metrics, '$.connections'))
  FROM reports
  CROSS JOIN (SELECT 1200 AS width UNION ALL SELECT 8400 UNION ALL SELECT 36000)
  WHERE json_type(metrics, '$.connections') = 'integer'
    AND json_extract(metrics, '$.connections') >= 0
  GROUP BY width, (ts / width) * width
  ON CONFLICT(width, bucket) DO UPDATE SET samples = excluded.samples, peak = excluded.peak;
