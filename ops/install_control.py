"""Install a bounded VPS credential executor; reuse the existing HTTPS domain."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from deployment import ROOT,load_config,cloud_configs
from publish_monitor import private_key
from subscriptions import private_read


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--config');parser.add_argument('--wrangler',default='wrangler');a=parser.parse_args();c=load_config(a.config)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',c['ssh_host']):raise ValueError('Invalid SSH alias')
    state=Path(c.get('private_state_dir',Path.home()/'.local/share/routepilot/instances'/c['instance']['id']));state.mkdir(parents=True,exist_ok=True,mode=0o700)
    token=private_key(state,'control-key');worker,_=cloud_configs(c)
    binary=shutil.which(a.wrangler)
    if not binary:raise ValueError('Wrangler required')
    with tempfile.TemporaryDirectory(prefix='route-pilot-control-') as directory:
        config=Path(directory)/'wrangler.json';config.write_text(json.dumps({'name':worker['name'],'account_id':c['account_id']}))
        result=subprocess.run([binary,'secret','bulk','--config',str(config)],input=json.dumps({'CONTROL_SHA256':hashlib.sha256(token.encode()).hexdigest()}),capture_output=True,text=True,env={**os.environ,'WRANGLER_SEND_METRICS':'false'})
        if result.returncode:raise RuntimeError('Control key deployment failed')
    parent=Path(c['xray_config']).parent
    if not parent.is_absolute() or len(parent.parts)<3 or any(x in str(parent) for x in ['\n','\r','%']):raise ValueError('Invalid Xray configuration directory')
    unit=(ROOT/'cloud/routepilot-control.service').read_text()+'ReadWritePaths='+json.dumps(str(parent))+'\n'
    files={
        '/etc/routepilot-control/auth-header':('Authorization: Bearer '+token+'\n',0o600),
        '/etc/routepilot-control/config.json':(json.dumps({'base_url':'https://'+c['status_hostname']}),0o600),
        '/usr/local/libexec/routepilot-control':((ROOT/'cloud/control.py').read_text(),0o755),
        '/etc/systemd/system/routepilot-control.service':(unit,0o644),
        '/etc/systemd/system/routepilot-control.timer':((ROOT/'cloud/routepilot-control.timer').read_text(),0o644),
    }
    tokens={}
    for manifest in state.glob('*/device.json'):
        directory=manifest.parent
        if (directory/'subscription-token').is_file():
            d=json.loads(private_read(manifest));value=private_read(directory/'subscription-token')
            if re.fullmatch(r'[a-f0-9]{24}',d['id']) and re.fullmatch(r'[A-Za-z0-9_-]{43}',value):tokens[d['id']]=value
    payload={name:[base64.b64encode(value.encode()).decode(),mode] for name,(value,mode) in files.items()}
    installer=r'''
import base64,json,os,pathlib,subprocess,sys,tempfile
sys.path.insert(0,'/opt/routepilot')
from devices import private
from devices.registry import Registry
os.umask(0o077)
for directory in ['/etc/routepilot-control','/var/lib/routepilot-control','/var/lib/routepilot-control/jobs','/var/lib/routepilot-control/tokens']:private.directory(directory)
for name,(data,mode) in files.items():
 path=pathlib.Path(name)
 if path.is_symlink():raise ValueError('Refuse symlink')
 if name.endswith('routepilot-control'):compile(base64.b64decode(data),name,'exec')
 # Installer paths are fixed and not accepted from remote control jobs.
 with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as f:
  f.write(base64.b64decode(data));os.fchmod(f.fileno(),mode);f.flush();os.fsync(f.fileno())
 os.replace(f.name,path)
registry=Registry('/var/lib/routepilot-devices');active={d['id'] for d in registry.devices()}
for identity,token in tokens.items():
 path=pathlib.Path('/var/lib/routepilot-control/tokens')/(identity+'.json')
 if identity in active and not path.exists():private.write(path,json.dumps({'token':token,'job':'imported'}))
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','routepilot-control.timer'],check=True,capture_output=True)
subprocess.run(['systemctl','start','routepilot-control.service'],check=True,capture_output=True)
print('Credential executor installed; root-only secrets, 30-second timer, no inbound port')
'''
    result=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',c['ssh_host'],'sudo -n python3 -'],input='files='+repr(payload)+'\ntokens='+repr(tokens)+'\n'+installer,capture_output=True,text=True,timeout=100)
    if result.returncode:raise RuntimeError('VPS control installation failed; inspect service status without printing credentials')
    print(result.stdout.strip())

if __name__=='__main__':main()
