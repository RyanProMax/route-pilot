"""Exercise the D1 schema with SQLite, including real-minute recovery and retries."""
from pathlib import Path
import sqlite3
import unittest


class CloudStorageTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        ddl = Path(__file__).resolve().parents[1] / "cloud/migrations/0001_monitor.sql"
        self.db.executescript(ddl.read_text())
        self.addCleanup(self.db.close)

    def write(self, ts, status):
        self.db.execute("INSERT INTO samples VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                        ("heartbeat", ts // 60, ts, status, None, "observation"))

    def test_retry_and_late_delivery(self):
        self.write(120, "ok")
        self.write(125, "ok")
        self.write(60, "down")
        self.assertEqual(self.db.execute("SELECT ts,status FROM latest").fetchone(), (120, "ok"))
        self.assertEqual(self.db.execute("SELECT n,ok,down FROM buckets WHERE width=1200").fetchone(),
                         (2, 1, 1))
        self.assertFalse(self.db.execute("SELECT 1 FROM events").fetchone())

    def test_missing_heartbeat_and_recovery(self):
        for ts, state in [(15, "ok"), (120, "unknown"), (180, "unknown"), (255, "ok")]:
            self.write(ts, state)
        self.assertEqual(self.db.execute("SELECT previous,status FROM events ORDER BY id").fetchall(),
                         [("ok", "unknown"), ("unknown", "ok")])
        self.assertEqual(self.db.execute("SELECT n,ok,missing FROM buckets WHERE width=1200").fetchone(),
                         (4, 2, 2))
