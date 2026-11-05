"""Estimate monthly outbound bytes on the public interface, using the existing reporter timer."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
from tempfile import NamedTemporaryFile


def month_start(ts):
    return int(datetime.fromtimestamp(ts, timezone.utc).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())


def archived_usage(interface, start, boot):
    """Recover completed boots or find the month-opening counter on a long-running boot."""
    total = 0
    for day in range(1, datetime.now(timezone.utc).day + 1):
        archive = Path(f"/var/log/sysstat/sa{day:02}")
        if not archive.is_file():
            continue
        data = subprocess.run(["/usr/bin/sadf", "-r", "-U", str(archive), "--", "-n", "DEV"],
                              env={**os.environ, "LC_ALL": "C"}, capture_output=True, text=True,
                              check=True, timeout=3).stdout
        for line in data.splitlines():
            fields = [field.strip() for field in line.split(";")]
            if not fields[0].isdigit() or int(fields[0]) < start:
                continue
            ts = int(fields[0])
            if boot >= start and ts >= boot:
                return total, None
            if len(fields) < 4 or fields[1:3] != ["IFACE", interface] or "txkB/s" not in fields:
                continue
            index = fields.index("txkB/s")
            before, after = map(int, fields[index + 1:index + 3])
            if boot < start:
                # The prior counter of the first interval is the nearest available baseline.
                return (0, before) if ts < start + 3600 else (0, None)
            total += max(0, after - before)
    return total, None


def update(previous, now, boot, boot_id, interface, counter):
    start = month_start(now)
    delta = counter
    since = boot
    if previous["boot_id"] == boot_id:
        if previous["interface"] != interface:
            delta = 0
        elif counter >= previous["counter"]:
            delta -= previous["counter"]
        since = previous["at"]
    if previous["month"] == start:
        return previous["used"] + delta
    if since >= start:
        return delta
    # Split the single sample interval spanning UTC midnight.
    return delta * (now - start) // max(1, now - since)


def record(directory, now):
    routes = json.loads(subprocess.check_output(["/usr/sbin/ip", "-j", "-4", "route", "show", "default"], timeout=3))
    interface = min(routes, key=lambda r: r.get("metric", 0))["dev"]
    counter = int((Path("/sys/class/net") / interface / "statistics/tx_bytes").read_text())
    boot = int(next(s.split()[1] for s in Path("/proc/stat").read_text().splitlines() if s.startswith("btime ")))
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    path = directory / "monthly-traffic.json"
    start = month_start(now)
    if path.exists():
        previous = json.loads(path.read_text())
        if now < previous["at"]:
            return None
        used = update(previous, now, boot, boot_id, interface, counter)
    else:
        past, baseline = archived_usage(interface, start, boot)
        if boot < start and baseline is None:
            return None
        used = past + max(0, counter - (baseline or 0))
    with NamedTemporaryFile(mode="w", dir=directory, delete=False) as temp:
        json.dump({"month": start, "at": now, "boot_id": boot_id, "interface": interface,
                   "counter": counter, "used": used}, temp)
        temp.flush()
        os.fsync(temp.fileno())
    os.replace(temp.name, path)
    return used
