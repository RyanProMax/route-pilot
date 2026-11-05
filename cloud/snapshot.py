#!/usr/bin/python3
"""Capture allowed host metrics before the unprivileged HTTPS sender runs."""
import grp
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import sys
import sqlite3
from routepilot_traffic import record
from routepilot_devices import collect
from routepilot_accounting import collect as account

directory = Path("/var/lib/routepilot/snapshot")
settings = json.loads(Path("/etc/routepilot-report/config.json").read_text())
proxy_port = int(settings["proxy_port"])
host = json.loads(subprocess.check_output(["/usr/local/libexec/routepilot-metrics"], timeout=18))
metrics = {key: host[key] for key in ("load1", "cpu_count", "memory_total", "memory_used",
          "disk_total", "disk_used", "uptime_seconds", "xray_restarts")}
metrics["proxy_service"] = host["services"]["proxy"]
connections = subprocess.check_output(
    ["/usr/bin/ss", "-Htn", "state", "established", f"( sport = :{proxy_port} )"], timeout=4)
metrics["connections"] = len(connections.splitlines())
try:
    metrics["devices"] = collect(int(settings.get("stats_port", 10085)))
except (OSError, ValueError, subprocess.SubprocessError):
    metrics["devices"] = None
now = int(time.time())
usage = None
try:
    metrics['cpu_percent'], usage = account(directory, now, int(settings.get('stats_port',10085)), settings.get('xray_service','xray'))
except (OSError, ValueError, KeyError, sqlite3.Error, subprocess.SubprocessError):
    print('Credential accounting unavailable', file=sys.stderr)
try:
    used = record(directory, now)
    if used is not None:
        metrics["month_tx_bytes"] = used
except (OSError, ValueError, KeyError, IndexError, StopIteration, subprocess.SubprocessError):
    print("Monthly outbound counter unavailable", file=sys.stderr)
security = dict(host["security"])
security.pop("monitor_restricted", None)
unit = subprocess.check_output(["/usr/bin/systemctl", "show", "routepilot-report.service",
    "-p", "User", "-p", "NoNewPrivileges", "-p", "ProtectSystem", "-p", "CapabilityBoundingSet"], text=True, timeout=4)
properties = dict(line.split("=", 1) for line in unit.splitlines() if "=" in line)
security["reporter_sandboxed"] = all(properties.get(key) == value for key, value in {
    "User": "routepilot-report", "NoNewPrivileges": "yes", "ProtectSystem": "strict", "CapabilityBoundingSet": ""}.items())
metrics["security"] = security
with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as file:
    payload = {"schema": 1, "ts": now, "metrics": metrics}
    if usage is not None: payload['usage'] = usage
    json.dump(payload, file, separators=(",", ":"))
    os.fchown(file.fileno(), 0, grp.getgrnam("routepilot-report").gr_gid)
    os.fchmod(file.fileno(), 0o640)
os.replace(file.name, directory/"latest.json")
