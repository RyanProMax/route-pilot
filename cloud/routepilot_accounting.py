"""Minute deltas, persisted before sending; never emit proxy credentials or client IPs."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
from tempfile import NamedTemporaryFile

COUNTER = re.compile(r'user>>>((?:rp\.[a-f0-9]{24}|legacy-\d{1,3})@routepilot\.invalid)>>>traffic>>>(uplink|downlink)')


def advance(previous, now, epoch, cpu, readings, labels):
    month = datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m')
    start = int(datetime.fromtimestamp(now, timezone.utc).replace(day=1,hour=0,minute=0,second=0,microsecond=0).timestamp())
    if previous and now <= previous['at']:
        raise ValueError('Non-increasing sample clock')
    state = {'at':now, 'epoch':epoch, 'cpu':cpu, 'month':month, 'rows':{}}
    cpu_percent = None
    if previous and previous['epoch'].split(':')[0] == epoch.split(':')[0]:
        total = cpu[0] - previous['cpu'][0]
        idle = cpu[1] - previous['cpu'][1]
        if total > 0 and 0 <= idle <= total:
            cpu_percent = round(100*(total-idle)/total,1)
    for identity in sorted(set(labels) | set((previous or {}).get('rows',{})) | set(readings)):
        old = (previous or {}).get('rows',{}).get(identity)
        label = labels.get(identity, {'label':old['label'] if old else 'Legacy shared', 'revoked':True})
        raw = readings.get(identity)
        same_month = previous and previous['month'] == month
        row = {'id':identity, **label, 'month':month, 'online':bool(raw and raw['online']),
               'since':max(start, old['since'] if old else now), 'gaps':old['gaps'] if old else 0,
               'uplink':old['uplink'] if old and same_month else 0,
               'downlink':old['downlink'] if old and same_month else 0,
               'raw':raw or (old['raw'] if old else {'uplink':0,'downlink':0,'online':False})}
        if old and raw:
            reset = previous['epoch'] != epoch or any(raw[k]<old['raw'][k] for k in ('uplink','downlink'))
            if reset: row['gaps'] += 1
            for kind in ('uplink','downlink'):
                delta = raw[kind] if reset else raw[kind]-old['raw'][kind]
                if not same_month and previous['at'] < start:
                    delta = delta * (now-start) // (now-previous['at'])
                row[kind] += delta
        state['rows'][identity] = row
    return state, cpu_percent, [{k:v for k,v in row.items() if k!='raw'} for row in state['rows'].values()]


def collect(directory, now, port, service):
    def query(command, *args):
        r = subprocess.run(['/usr/local/bin/xray','api',command,'--server=127.0.0.1:'+str(port),'-timeout','2',*args],
                           capture_output=True,timeout=4,check=True)
        return json.loads(r.stdout)
    online = query('statsgetallonlineusers').get('users',[])
    counters = query('statsquery','-pattern','user>>>').get('stat',[])
    active = {s.removeprefix('user>>>').removesuffix('>>>online') for s in online}
    labels = {}
    db = sqlite3.connect('file:/var/lib/routepilot-devices/devices.db?mode=ro', uri=True)
    try:
        for identity,label,revoked in db.execute('SELECT id,label,revoked FROM devices'):
            labels[identity] = {'label':label,'revoked':bool(revoked)}
    finally: db.close()
    readings = {}
    for entry in counters:
        match = COUNTER.fullmatch(entry.get('name',''))
        if not match: continue
        email,kind = match.groups()
        identity = email.split('@')[0].removeprefix('rp.')
        value = int(entry.get('value',0))
        if value<0: raise ValueError('Invalid counter')
        readings.setdefault(identity,{'uplink':0,'downlink':0,'online':email in active})[kind] = value
        if identity.startswith('legacy-'):
            labels[identity] = {'label':'Legacy shared '+identity.split('-')[1],'revoked':False}
    # Missing counters are not zero: retain the previous baseline until they return.
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    process = subprocess.check_output(['systemctl','show',service,'-p','ExecMainStartTimestampMonotonic','--value'],text=True,timeout=3).strip()
    values = list(map(int,Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    cpu = [sum(values),values[3]+values[4]]
    path = directory/'credential-accounting.json'
    previous = json.loads(path.read_text()) if path.exists() else None
    state, percent, usage = advance(previous,now,boot+':'+process,cpu,readings,labels)
    if len(usage)>512: raise ValueError('At most 512 retained credential identities supported per instance')
    with NamedTemporaryFile(mode='w',dir=directory,delete=False) as file:
        os.fchmod(file.fileno(),0o600)
        json.dump(state,file,separators=(',',':')); file.flush(); os.fsync(file.fileno())
    os.replace(file.name,path)
    return percent,usage
