"""Private online/traffic view by credential; counters cover the current Xray process."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from devices.registry import Registry
from devices.provision import managed_email

EMAIL=re.compile(r'(?:rp\.[a-f0-9]{24}|legacy-\d+)@routepilot\.invalid')
COUNTER=re.compile(r'user>>>(.+)>>>traffic>>>(uplink|downlink)')


def summarize(online,counters,labels):
    # These are authenticated identities, never physical devices or IP counts.
    users=online.get('users',[])
    if not isinstance(users,list) or any(not isinstance(x,str) for x in users):raise ValueError('Invalid online response')
    active=set()
    for name in users:
        name=name.removeprefix('user>>>').removesuffix('>>>online')
        if not EMAIL.fullmatch(name):raise ValueError('Unmanaged identity needs an explicit display mapping')
        active.add(name)
    values={}
    for row in counters.get('stat',[]):
        match=COUNTER.fullmatch(row.get('name',''))
        if not match:continue
        email,kind=match.groups()
        if not EMAIL.fullmatch(email):continue
        value=row.get('value',0)
        if isinstance(value,str) and value.isdecimal():value=int(value)
        if type(value) is not int or value<0:raise ValueError('Invalid traffic counter')
        values.setdefault(email,{})[kind]=value
    result=[]
    for email in sorted(set(labels)|active|set(values)):
        amount=values.get(email,{})
        result.append({'credential':labels.get(email,'Legacy shared credential'), 'online':email in active,
                       'uplink_bytes':amount.get('uplink',0),'downlink_bytes':amount.get('downlink',0)})
    return {'window':'current_xray_process','credentials':result}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--settings',default='/etc/routepilot-devices/settings.json')
    a=p.parse_args()
    if os.geteuid()!=0:raise SystemExit('Credential usage is available only to the VPS administrator')
    settings=json.loads(Path(a.settings).read_text());port=int(settings.get('stats_port',10085))
    if not 1024<=port<=65535:raise ValueError('Invalid statistics port')
    def query(command,*args):
        r=subprocess.run(['/usr/local/bin/xray','api',command,'--server=127.0.0.1:'+str(port),'-timeout','2',*args],capture_output=True,timeout=4)
        if r.returncode:raise RuntimeError('Statistics unavailable')
        return json.loads(r.stdout)
    registry=Registry('/var/lib/routepilot-devices')
    labels={managed_email(d['id']):d['label'] for d in registry.devices()}
    print(json.dumps(summarize(query('statsgetallonlineusers'),query('statsquery','-pattern','user>>>'),labels),ensure_ascii=False,indent=2))
if __name__=='__main__':main()
