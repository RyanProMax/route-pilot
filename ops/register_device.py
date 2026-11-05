"""Provision a device over trusted SSH and deliver private native client files."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from deployment import load_config


def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config');p.add_argument('--name',required=True);p.add_argument('--client',choices=['clash','shadowrocket'],required=True)
    p.add_argument('--out',required=True,type=Path,help='Private output directory; reused for the same registered device')
    a=p.parse_args();c=load_config(a.config)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',c['ssh_host']):raise ValueError('Invalid SSH alias')
    out=a.out.expanduser()
    if out.is_symlink() or (out.exists() and not out.is_dir()):raise ValueError('Output must be a private directory')
    out.mkdir(parents=True,exist_ok=True,mode=0o700)
    if out.stat().st_mode&0o077:raise ValueError('Output directory must have mode 700')
    manifest=out/'device.json'
    if list(out.iterdir()):
        previous=json.loads(manifest.read_text()) if manifest.is_file() else {}
        if previous.get('label')!=a.name or previous.get('client')!=a.client:
            raise ValueError('Output directory belongs to another device or contains unmanaged files')
    q={'label':a.name,'client':a.client}
    script=r'''
import base64,json,os,sys
from pathlib import Path
os.umask(0o077);sys.path.insert(0,'/opt/routepilot')
from devices.registry import Registry
from devices.provision import provision
settings=json.loads(Path('/etc/routepilot-devices/settings.json').read_text())
r=Registry('/var/lib/routepilot-devices')
d=provision(r,settings,q['label'],q['client'])
formats=['clash.yaml'] if q['client']=='clash' else ['shadowrocket.txt','rules.conf']
result={'device':{k:d[k] for k in ('id','label','client','created')},'files':{}}
result['device']['client']=q['client']
for name in formats:result['files'][name]=base64.b64encode((r.root/'profiles'/d['id']/name).read_bytes()).decode()
print(json.dumps(result))
'''
    result=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',c['ssh_host'],'sudo -n python3 -'],
        input='q='+repr(q)+'\n'+script,text=True,capture_output=True,timeout=50)
    if result.returncode:raise RuntimeError('Device provisioning failed; existing device names are reused on retry. No credentials logged.')
    payload=json.loads(result.stdout)
    expected={'clash.yaml'} if a.client=='clash' else {'shadowrocket.txt','rules.conf'}
    if set(payload['files'])!=expected:raise RuntimeError('Unexpected client files; nothing written')
    files={name:base64.b64decode(body,validate=True) for name,body in payload['files'].items()}
    files['device.json']=(json.dumps(payload['device'],indent=2)+'\n').encode()
    for name,body in files.items():
        with tempfile.NamedTemporaryFile(dir=out,delete=False) as f:f.write(body);os.fchmod(f.fileno(),0o600)
        os.replace(f.name,out/name)
    print('Private device files written to '+str(out))
if __name__=='__main__':main()
