"""Apply the runtime security baseline through an existing verified SSH alias."""
import argparse
import re
import subprocess
from deployment import load_config

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config');a=p.parse_args();c=load_config(a.config)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',c['ssh_host']):raise ValueError('Invalid SSH alias')
    script='''import json,sys
from pathlib import Path
sys.path.insert(0,'/opt/routepilot')
from devices.security import apply
print(json.dumps(apply(json.loads(Path('/etc/routepilot-devices/settings.json').read_text()))))
'''
    r=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',c['ssh_host'],'sudo -n python3 -'],input=script,text=True,capture_output=True,timeout=90)
    if r.returncode:raise SystemExit('Runtime hardening failed; inspect the private target-side recovery backup. No credentials logged.')
    print(r.stdout.strip())
if __name__=='__main__':main()
