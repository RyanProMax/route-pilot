"""Count authenticated online credentials; never report identity strings or source IPs."""
import json
import re
import subprocess

PATTERN=re.compile(r'(?:user>>>|user<<<)?((?:rp\.[a-f0-9]{24}|legacy-\d+)@routepilot\.invalid)(?:>>>online|<<<online)?')

def summarize(payload):
    users=payload.get('users',[])
    if not isinstance(users,list) or any(not isinstance(u,str) for u in users):raise ValueError('Invalid online response')
    # Shared clients are intentionally counted once per authenticated credential.
    matches=[PATTERN.fullmatch(u) for u in users]
    if any(m is None for m in matches):return None
    return len({m[1] for m in matches})

def collect(port=10085,binary='/usr/local/bin/xray'):
    result=subprocess.run([binary,'api','statsgetallonlineusers','--server=127.0.0.1:'+str(port),'-timeout','2'],
        capture_output=True,timeout=4)
    if result.returncode:return None
    return summarize(json.loads(result.stdout))
