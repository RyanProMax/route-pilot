"""Durable observations; missing observations are never counted as success."""
import json
from contextlib import contextmanager
import math
import sqlite3
import time

STATUSES = {"ok", "degraded", "down", "unknown"}


class Store:
    def __init__(self, path, interval=60):
        self.path, self.interval = str(path), interval
        with self.connect() as db:
            db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS samples (
              id INTEGER PRIMARY KEY, ts REAL NOT NULL, check_id TEXT NOT NULL,
              status TEXT NOT NULL, latency REAL, detail TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS samples_lookup ON samples(check_id, ts);
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY, ts REAL NOT NULL, check_id TEXT NOT NULL,
              status TEXT NOT NULL, previous TEXT, detail TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def meta(self, key, value=None):
        with self.connect() as db:
            if value is not None:
                db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (key, json.dumps(value)))
                return value
            row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else None

    def add(self, check_id, status, detail, latency=None, ts=None):
        if status not in STATUSES:
            raise ValueError("Invalid sample status")
        ts = time.time() if ts is None else ts
        if latency is not None and (not math.isfinite(latency) or latency < 0):
            raise ValueError("Invalid latency")
        with self.connect() as db:
            prev = db.execute("SELECT status FROM samples WHERE check_id=? ORDER BY ts DESC,id DESC LIMIT 1", (check_id,)).fetchone()
            db.execute("INSERT INTO samples(ts,check_id,status,latency,detail) VALUES (?,?,?,?,?)", (ts, check_id, status, latency, json.dumps(detail)))
            if (prev and prev[0] != status) or (not prev and status in {"down", "degraded"}):
                db.execute("INSERT INTO events(ts,check_id,status,previous,detail) VALUES (?,?,?,?,?)", (ts, check_id, status, prev[0] if prev else None, json.dumps(detail)))

    def prune(self, now=None):
        cutoff = (now or time.time()) - 31 * 86400
        with self.connect() as db:
            db.execute("DELETE FROM samples WHERE ts<?", (cutoff,))
            db.execute("DELETE FROM events WHERE ts<?", (cutoff,))

    def summarize(self, check_id, window, now=None, buckets=72):
        now = time.time() if now is None else now
        start = now - window
        with self.connect() as db:
            rows = db.execute("SELECT * FROM samples WHERE check_id=? AND ts>=? AND ts<=? ORDER BY ts,id", (check_id, start, now)).fetchall()
            last = db.execute("SELECT * FROM samples WHERE check_id=? AND ts<=? ORDER BY ts DESC,id DESC LIMIT 1", (check_id, now)).fetchone()
        valid = [r for r in rows if r["status"] != "unknown"]
        success = [r for r in valid if r["status"] in {"ok", "degraded"}]
        latencies = sorted(r["latency"] for r in success if r["latency"] is not None)
        # A sample covers at most one interval. Gaps, startup and sleep remain missing.
        covered = 0.0
        covered_until = start
        for r in valid:
            lo, hi = max(start, r["ts"] - self.interval), r["ts"]
            covered += max(0, hi - max(lo, covered_until))
            covered_until = max(covered_until, hi)
        groups = [[] for _ in range(buckets)]
        for r in rows:
            index = min(buckets - 1, int((r["ts"] - start) / window * buckets))
            groups[index].append(r)
        priority = {"unknown": 0, "ok": 1, "degraded": 2, "down": 3}
        history = []
        for i, group in enumerate(groups):
            states = [r["status"] for r in group]
            history.append({"ts": start + i * window / buckets, "status": max(states, key=priority.get) if states else "unknown", "samples": len(group), "failures": states.count("down")})
        fresh = last is not None and now - last["ts"] <= self.interval * 2.5
        return {"id": check_id, "status": last["status"] if fresh else "unknown", "stale": not fresh,
                "last_at": last["ts"] if last else None, "detail": json.loads(last["detail"]) if last else {"message": "等待首次观测"},
                "latency": last["latency"] if fresh else None, "samples": len(valid),
                "success_rate": round(len(success) / len(valid) * 100, 2) if valid else None,
                "coverage": round(min(100, covered / window * 100), 2),
                "p50": latencies[(len(latencies)-1)//2] if latencies else None,
                "p95": latencies[max(0, math.ceil(len(latencies)*.95)-1)] if latencies else None,
                "history": history}

    def events(self, since):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM events WHERE ts>=? ORDER BY ts DESC,id DESC LIMIT 60", (since,)).fetchall()
        return [{**dict(r), "detail": json.loads(r["detail"])} for r in rows]
