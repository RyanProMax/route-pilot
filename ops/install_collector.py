#!/usr/bin/env python3
"""Install a root-owned, forced-command-only telemetry identity over trusted SSH."""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--ssh-host',required=True,help='Existing verified SSH alias')
    p.add_argument('--state',type=Path,default=Path.home()/'.local/share/routepilot')
    p.add_argument('--apply',action='store_true')
    args=p.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+',args.ssh_host):raise SystemExit('Use a configured SSH alias')
    metrics=(Path(__file__).parent/'metrics.py').read_bytes()
    public=(args.state/'monitor_ed25519.pub').read_text().strip().split()
    if len(public)<2 or public[0]!='ssh-ed25519' or not re.fullmatch(r'[A-Za-z0-9+/=]+',public[1]):raise SystemExit('Invalid public key')
    if not args.apply:
        print(json.dumps({'target':args.ssh_host,'account':'routepilot-monitor','forced_command':'sudo -n /usr/local/libexec/routepilot-metrics','sudo_scope':'one root-owned read-only helper, no arguments','ports_added':[]}));return
    payload={'metrics':base64.b64encode(metrics).decode(),'public':' '.join(public[:2])+' routepilot-readonly'}
    script='''import base64, json, os, pathlib, pwd, shutil, subprocess, time
os.umask(0o077)
data=json.loads(PAYLOAD)
user='routepilot-monitor'
try: account=pwd.getpwnam(user)
except KeyError:
 subprocess.run(['useradd','--create-home','--shell','/bin/sh',user],check=True)
 account=pwd.getpwnam(user)
home=pathlib.Path(account.pw_dir)
if home!=pathlib.Path('/home/routepilot-monitor'):raise SystemExit('Unexpected account home')
backup=pathlib.Path('/var/lib/routepilot/backups')/time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
backup.mkdir(parents=True,mode=0o700)
helper=pathlib.Path('/usr/local/libexec/routepilot-metrics')
sudoers=pathlib.Path('/etc/sudoers.d/routepilot-monitor')
keys=home/'.ssh/authorized_keys'
for label,path in [('metrics',helper),('sudoers',sudoers),('authorized_keys',keys)]:
 if path.exists():shutil.copy2(path,backup/label)
helper.parent.mkdir(exist_ok=True)
helper.write_bytes(base64.b64decode(data['metrics']))
os.chown(helper,0,0);helper.chmod(0o755)
sudoers.write_text('routepilot-monitor ALL=(root) NOPASSWD: /usr/local/libexec/routepilot-metrics ""\\n')
sudoers.chmod(0o440);os.chown(sudoers,0,0)
subprocess.run(['/usr/sbin/visudo','-cf',str(sudoers)],check=True,stdout=subprocess.DEVNULL)
keys.parent.mkdir(exist_ok=True,mode=0o700)
keys.write_text('restrict,command="/usr/bin/sudo -n /usr/local/libexec/routepilot-metrics" '+data['public']+'\\n')
os.chown(home,0,0);home.chmod(0o755)
os.chown(keys.parent,0,0);keys.parent.chmod(0o755)
os.chown(keys,0,0);keys.chmod(0o644)
subprocess.run(['/usr/sbin/sshd','-t'],check=True)
print(json.dumps({'installed':True,'backup':str(backup),'account':user,'shell_access':False,'forwarding':False,'root_owned_key_authorization':True}))
'''.replace('PAYLOAD',repr(json.dumps(payload)))
    command=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',args.ssh_host,'sudo -n python3 -']
    subprocess.run(command,input=script,text=True,check=True,timeout=40)

if __name__=='__main__':main()
