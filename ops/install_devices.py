"""Install administrator-only device provisioning helpers; no daemon or HTTP endpoint."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
from deployment import ROOT, load_config


def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config');a=p.parse_args();c=load_config(a.config)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',c['ssh_host']): raise ValueError('Invalid SSH alias')
    files={}
    for source in [*list((ROOT/'devices').glob('*.py')), *[(ROOT/'skills/fixed-ip-vpn/scripts')/n for n in ('render.py','routing.py')]]:
        files['/opt/routepilot/'+str(source.relative_to(ROOT))]=[base64.b64encode(source.read_bytes()).decode(),0o644]
    settings={k:c[k] for k in ('instance','xray_config','xray_service')}
    settings['stats_port']=c.get('stats_port',10085)
    if c.get('routing_rules_file'):
        settings['routing_rules_file']='/etc/routepilot-devices/routing-rules.json'
        files[settings['routing_rules_file']]=[base64.b64encode(Path(c['routing_rules_file']).expanduser().read_bytes()).decode(),0o600]
    files['/etc/routepilot-devices/settings.json']=[base64.b64encode(json.dumps(settings).encode()).decode(),0o600]
    script=r'''
import base64,hashlib,os,pathlib,shutil,subprocess,tempfile,time
os.umask(0o077)
private=pathlib.Path('/etc/routepilot-devices');private.mkdir(exist_ok=True,mode=0o700)
base=pathlib.Path('/opt/routepilot');base.mkdir(parents=True,exist_ok=True,mode=0o755);base.chmod(0o755)
backup=pathlib.Path('/var/lib/routepilot/backups')/('device-tools-'+str(time.time_ns()));backup.mkdir(parents=True,mode=0o700)
for name,(data,mode) in files.items():
 path=pathlib.Path(name);path.parent.mkdir(parents=True,exist_ok=True)
 if str(path).startswith('/opt/routepilot/'):
  parent=path.parent
  while parent!=base:parent.chmod(0o755);parent=parent.parent
 body=base64.b64decode(data)
 if path.suffix=='.py':compile(body,str(path),'exec')
 if path.exists():shutil.copy2(path,backup/(path.name+'.'+hashlib.sha256(name.encode()).hexdigest()[:8]))
 with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as f:f.write(body);os.fchmod(f.fileno(),mode)
 os.replace(f.name,path)
print('Administrator-only device tools installed; no background service created')
'''
    subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',c['ssh_host'],'sudo -n python3 -'],
                   input='files='+repr(files)+'\n'+script,text=True,check=True,timeout=40)
if __name__=='__main__':main()
