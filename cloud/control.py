#!/usr/bin/python3
"""One short root-owned HTTPS polling job, with no listening port or resident process."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
sys.path.insert(0,'/opt/routepilot')
from devices.registry import Registry
from devices.control import apply,describe
from devices import private


def run():
    os.umask(0o077)
    root=Path('/etc/routepilot-control')
    settings=json.loads(private.regular(root/'config.json').read_text())
    base=settings['base_url'];url=urlsplit(base)
    if url.scheme!='https' or not url.hostname or url.username or url.port or url.path or url.query or url.fragment:raise ValueError('Invalid origin')
    header=private.regular(root/'auth-header')
    state=private.directory('/var/lib/routepilot-control')
    lock=os.open(state/'runner.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        def request(action,payload):
            r=subprocess.run(['/usr/bin/curl','--disable','--ipv4','--noproxy','*','--proto','=https','--silent','--fail',
              '--connect-timeout','4','--max-time','15','--max-filesize','65536','--header','@'+str(header),
              '--header','Content-Type: application/json','--data-binary','@-',base+'/private/control/'+action],
              input=json.dumps(payload).encode(),capture_output=True,timeout=18)
            if r.returncode or len(r.stdout)>65536:raise RuntimeError('Control request failed')
            return json.loads(r.stdout)
        registry=Registry('/var/lib/routepilot-devices')
        job=request('poll',{'credentials':[describe(d) for d in registry.devices(True)]}).get('job')
        if job:
            config=json.loads(private.regular('/etc/routepilot-devices/settings.json').read_text())
            try:result=apply(registry,config,state,job)
            except Exception:result={'ok':False,'error':'apply_failed'}
            if request('ack',{'id':job['id'],'lease':job['lease'],**result}).get('ok') is not True:raise RuntimeError('Control acknowledgement failed')
            # Keep the bounded result briefly for retries; never log profile bodies or tokens.
        import time
        for path in (state/'jobs').glob('*.json'):
            if path.stat().st_mtime<time.time()-86400:path.unlink()
    finally:os.close(lock)

if __name__=='__main__':
    try:run()
    except BlockingIOError:pass
    except Exception:raise SystemExit('route-pilot control task failed; retry on next timer') from None
