ALTER TABLE connection_buckets ADD COLUMN device_peak INTEGER;
DROP TRIGGER store_connections;
CREATE TRIGGER store_connections AFTER INSERT ON reports
WHEN json_type(NEW.metrics, '$.connections') = 'integer'
  AND json_extract(NEW.metrics, '$.connections') >= 0
BEGIN
  INSERT INTO connection_buckets
    SELECT width, (NEW.ts / width) * width, 1, json_extract(NEW.metrics, '$.connections'),
      CASE WHEN json_type(NEW.metrics, '$.devices') = 'integer' AND json_extract(NEW.metrics, '$.devices') >= 0
           THEN json_extract(NEW.metrics, '$.devices') ELSE NULL END
    FROM (SELECT 1200 AS width UNION ALL SELECT 8400 UNION ALL SELECT 36000)
    WHERE 1
    ON CONFLICT(width, bucket) DO UPDATE SET samples = samples + 1, peak = MAX(peak, excluded.peak),
      device_peak = CASE WHEN excluded.device_peak IS NULL THEN device_peak
        WHEN device_peak IS NULL THEN excluded.device_peak ELSE MAX(device_peak, excluded.device_peak) END;
END;
