-- Keep the IPv4 minute buckets readable during rollout and rollback.
CREATE TABLE link_ipv6_packet_buckets (
  width INTEGER NOT NULL, bucket INTEGER NOT NULL,
  sent INTEGER NOT NULL CHECK(sent > 0),
  received INTEGER NOT NULL CHECK(received BETWEEN 0 AND sent),
  PRIMARY KEY(width,bucket)
) WITHOUT ROWID;
