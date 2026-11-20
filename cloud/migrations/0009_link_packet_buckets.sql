-- ICMP counts from minute-mode probes. Schema 2 keeps these counts in aggregate_windows.
CREATE TABLE link_packet_buckets (
  width INTEGER NOT NULL, bucket INTEGER NOT NULL,
  sent INTEGER NOT NULL CHECK(sent > 0),
  received INTEGER NOT NULL CHECK(received BETWEEN 0 AND sent),
  PRIMARY KEY(width,bucket)
) WITHOUT ROWID;
