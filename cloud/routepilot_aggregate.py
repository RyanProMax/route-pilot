"""Durable minute sampling, closed 20-minute summaries and bounded replay.

The database is local only. Never synthesize successful samples for absent
minutes, and never rewrite a window after it has closed. No credentials here.
"""
import json
import math
import os
from pathlib import Path
import sqlite3

WIDTH = 1200
RETENTION = 31 * 86400
MAX_WINDOWS = 16


def link_check(report):
    valid = [r['ms'] for r in report['results'] if r['outcome'] == 'ok']
    latency = math.floor(sum(valid) / len(valid) + .5) if valid else None
    status = ('degraded' if latency >= 500 else 'ok') if latency is not None else (
        'down' if any(r['outcome'] in ('timeout', 'failed') for r in report['results']) else 'unknown')
    check = {'id': 'link', 'status': status, 'latency': latency}
    if report.get('icmp'):
        check.update(packets_sent=report['icmp']['sent'], packets_received=report['icmp']['received'])
    return check


def host_checks(metrics, port):
    healthy = metrics['proxy_service'] == 'active' and port in metrics['security']['public_tcp_ports']
    return [{'id': 'heartbeat', 'status': 'ok', 'latency': None},
            {'id': 'xray', 'status': 'ok' if healthy else 'down', 'latency': None}]


def record(path, start, ts, checks, connections=None, snapshot=None):
    """Persist this actual minute once and return closed windows plus upload due.

    `start` is a deployment-controlled future UTC window boundary. Samples
    before it belong to the legacy protocol and must never be counted here.
    All storage updates, including marking a boundary attempted, are atomic.
    """
    if type(start) is not int or start % WIDTH or type(ts) is not int or ts < start:
        raise ValueError('Invalid aggregation boundary')
    path = Path(path)
    if path.is_symlink() or (path.exists() and path.stat().st_nlink != 1):
        raise ValueError('Unsafe aggregate cache')
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    db = sqlite3.connect(path, timeout=5)
    try:
        with db:
            db.executescript('''CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS minutes(minute INTEGER PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS windows(start INTEGER PRIMARY KEY,payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS last_sample(id INTEGER PRIMARY KEY CHECK(id=1),minute INTEGER,payload TEXT);''')
            db.execute('INSERT OR IGNORE INTO meta VALUES(?,?)', ('start', start))
            if db.execute("SELECT v FROM meta WHERE k='start'").fetchone()[0] != start:
                raise ValueError('Aggregation start cannot change for an existing cache')
            previous = db.execute("SELECT v FROM meta WHERE k='latest'").fetchone()
            if previous and ts < previous[0]:
                raise ValueError('Clock moved backwards')
            ids = [r['id'] for r in checks]
            if not ids or len(set(ids)) != len(ids): raise ValueError('Invalid checks')
            for row in checks:
                if row['status'] not in ('ok','degraded','down','unknown'): raise ValueError('Invalid state')
                latency = row.get('latency')
                if latency is not None and (type(latency) is not int or not 0 <= latency <= 5000):
                    raise ValueError('Invalid latency')
            minute = ts // 60
            previous_sample = db.execute('SELECT minute,payload FROM last_sample WHERE id=1').fetchone()
            previous_checks = {r['id']:r['status'] for r in json.loads(previous_sample[1])} if previous_sample and previous_sample[0] == minute-1 else {}
            events=[]
            for row in checks:
                before=previous_checks.get(row['id'])
                if (before is not None and before != row['status']) or (before is None and row['status'] in ('down','degraded')):
                    events.append({'id':row['id'],'ts':ts,'status':row['status'],'previous':before})
            inserted=db.execute('INSERT OR IGNORE INTO minutes VALUES(?,?)', (minute, json.dumps({'checks':checks,'connections':connections,'last':snapshot,'events':events}, separators=(',',':')))).rowcount
            if inserted:
                db.execute('INSERT INTO last_sample VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET minute=excluded.minute,payload=excluded.payload', (minute,json.dumps(checks)))
            boundary = ts // WIDTH * WIDTH
            # Entirely absent windows are explicitly all-missing with last=null.
            rows = db.execute('SELECT minute,payload FROM minutes WHERE minute<? ORDER BY minute', (boundary//60,)).fetchall()
            grouped = {}
            for m, payload in rows:
                grouped.setdefault(m//20*WIDTH, []).append(json.loads(payload))
            closed = db.execute("SELECT v FROM meta WHERE k='closed'").fetchone()
            first = max(start, (ts-RETENTION+WIDTH-1)//WIDTH*WIDTH, closed[0]+WIDTH if closed else start)
            for window in range(first, boundary, WIDTH):
                samples = grouped.get(window, [])
                out = {'start':window, 'checks':[], 'last':samples[-1].get('last') if samples else None,
                       'events':[event for sample in samples for event in sample.get('events',[])]}
                for id in ids:
                    values = [r for s in samples for r in s['checks'] if r['id']==id]
                    counts = {state:sum(r['status']==state for r in values) for state in ('ok','degraded','down','unknown')}
                    latencies = [r['latency'] for r in values if r.get('latency') is not None]
                    out['checks'].append({'id':id,'n':20,'ok':counts['ok'],'slow':counts['degraded'],
                        'down':counts['down'],'missing':20-counts['ok']-counts['degraded']-counts['down'],
                        'latency_sum':sum(latencies),'latency_n':len(latencies),'latency_max':max(latencies) if latencies else None})
                    sent = sum(r.get('packets_sent', 0) for r in values)
                    if id == 'link' and sent:
                        out['checks'][-1].update(packets_sent=sent,
                                                 packets_received=sum(r.get('packets_received', 0) for r in values))
                if connections is not None:
                    observed = [s['connections'] for s in samples if s['connections'] is not None]
                    devices = [c['device_peak'] for c in observed if c.get('device_peak') is not None]
                    out['connections']={'samples':len(observed),'peak':max((c['peak'] for c in observed), default=0),
                                        'device_peak':max(devices) if devices else None}
                db.execute('INSERT OR IGNORE INTO windows VALUES(?,?)', (window,json.dumps(out,separators=(',',':'))))
            if boundary > start:
                db.execute("INSERT INTO meta VALUES('closed',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (boundary-WIDTH,))
            db.execute('DELETE FROM minutes WHERE minute<?', (boundary//60,))
            db.execute('DELETE FROM windows WHERE start<?', (ts-RETENTION,))
            attempted = db.execute("SELECT v FROM meta WHERE k='attempted'").fetchone()
            due = boundary > start and (attempted is None or boundary > attempted[0])
            if due:
                db.execute("INSERT INTO meta VALUES('attempted',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (boundary,))
            db.execute("INSERT INTO meta VALUES('latest',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (ts,))
            windows = [json.loads(row[0]) for row in db.execute('SELECT payload FROM windows ORDER BY start')]
        return {'windows':windows,'upload_due':due}
    finally:
        db.close()


def pending(windows, last_window):
    if last_window is not None and (type(last_window) is not int or last_window % WIDTH):
        raise ValueError('Invalid server acknowledgement')
    result=[]
    size=0
    for window in windows:
        if last_window is not None and window['start'] <= last_window: continue
        length=len(json.dumps(window,separators=(',',':')).encode())
        if length>480000: raise ValueError('Aggregate window exceeds request limit')
        if len(result)>=MAX_WINDOWS or size+length>480000: break
        result.append(window);size+=length
    return result
