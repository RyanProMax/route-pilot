"""Publish encrypted HTTPS subscriptions or revoke both download and node access."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile
import urllib.request
from deployment import load_config

ROOT = Path(__file__).resolve().parents[1]


def private_read(path):
    metadata=path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_uid!=os.getuid() or metadata.st_mode & 0o077:
        raise ValueError('Private file permissions required')
    return path.read_text().strip()


def write(path, value):
    with tempfile.NamedTemporaryFile(mode='w',dir=path.parent,delete=False) as file:
        os.fchmod(file.fileno(),0o600); file.write(value+'\n'); file.flush(); os.fsync(file.fileno())
    os.replace(file.name,path)


def request(c, state, action, payload):
    key = private_read(state/'provision-key')
    req = urllib.request.Request('https://'+c['status_hostname']+'/private/manage/'+action,
        data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','User-Agent':'route-pilot/0.2'})
    # Never follow a redirect carrying an administrative credential.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    try:
        with urllib.request.build_opener(NoRedirect).open(req,timeout=20) as response:
            if json.load(response).get('ok') is not True: raise ValueError('Rejected')
    except Exception: raise RuntimeError('Private CF operation failed; no credentials logged') from None


def publish(c, state, directory, rotate=False):
    manifest = json.loads(private_read(directory/'device.json'))
    identity = manifest['id']
    if not re.fullmatch(r'[a-f0-9]{24}',identity): raise ValueError('Invalid credential ID')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',c['ssh_host']): raise ValueError('Invalid SSH alias')
    managed=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',c['ssh_host'],
        'sudo -n test -f /etc/routepilot-control/auth-header'],capture_output=True,timeout=20)
    if managed.returncode==0:raise RuntimeError('Web management is enabled; publish or rotate from /admin/ to preserve the authoritative subscription token')
    if managed.returncode!=1:raise RuntimeError('Could not verify subscription authority over SSH')
    # Re-export from the authoritative registry; never re-publish stale local credentials.
    result = subprocess.run(['python3',str(ROOT/'ops/register_device.py'),'--config',str(c['_config_path']),
        '--name',manifest['label'],'--client',manifest['client'],'--existing-id',identity,'--out',str(directory)],capture_output=True,text=True,timeout=65)
    if result.returncode: raise RuntimeError('Fresh credential export failed')
    fresh = json.loads(private_read(directory/'device.json'))
    if fresh['id'] != identity: raise RuntimeError('Credential identity changed; rerun publish for the newly exported identity')
    token_file = directory/'subscription-token'
    # A pending rotation is durable before upload, so a dropped response is safely retried.
    pending = directory/'subscription-token.pending'
    if pending.exists(): token = private_read(pending)
    elif rotate or not token_file.exists():
        token = secrets.token_urlsafe(32); write(pending,token)
    else: token = private_read(token_file)
    files = {name:private_read(directory/name)+'\n' for name in ('clash.yaml','shadowrocket.txt','rules.conf') if (directory/name).exists()}
    if 'shadowrocket.txt' in files: files['shadowrocket.txt'] = base64.b64encode(files['shadowrocket.txt'].encode()).decode()+'\n'
    body = {'id':identity,'instance':c['instance']['id'],'token':token,'key':private_read(state/'subscription-key'),'files':files}
    result = subprocess.run(['node',str(ROOT/'ops/encrypt_subscription.mjs')],input=json.dumps(body),capture_output=True,text=True,timeout=10)
    if result.returncode: raise RuntimeError('Encryption failed')
    request(c,state,'publish',json.loads(result.stdout))
    if pending.exists(): os.replace(pending,token_file)
    links = {name:'https://'+c['status_hostname']+'/sub/'+token+'/'+name for name in files}
    write(directory/'subscription-urls.json',json.dumps(links,indent=2))
    print('Subscription published; private URLs written to '+str(directory/'subscription-urls.json'))


def revoke(c,state,identity,download_only=False):
    request(c,state,'revoke',{'id':identity})
    if download_only:
        print('Subscription downloads revoked; imported node configuration still works'); return
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',c['ssh_host']): raise ValueError('Invalid SSH alias')
    script = "import sys,json; from pathlib import Path; sys.path.insert(0,'/opt/routepilot'); from devices.registry import Registry; from devices.provision import revoke; r=Registry('/var/lib/routepilot-devices'); s=json.loads(Path('/etc/routepilot-devices/settings.json').read_text()); d="+repr(identity)+"; active={x['id'] for x in r.devices()}; revoke(r,s,d) if d in active else None"
    result = subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',c['ssh_host'],'sudo -n python3 -'],input=script,text=True,capture_output=True,timeout=50)
    if result.returncode: raise RuntimeError('Downloads revoked; VPS revocation incomplete. Retry this command to finish.')
    print('Subscription and node credential revoked; existing node sessions closed by Xray restart')


def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--config')
    sub=p.add_subparsers(dest='command',required=True)
    pub=sub.add_parser('publish'); pub.add_argument('--directory',type=Path,required=True); pub.add_argument('--rotate-token',action='store_true')
    rev=sub.add_parser('revoke'); rev.add_argument('--id',required=True); rev.add_argument('--download-only',action='store_true')
    a=p.parse_args(); c=load_config(a.config)
    from deployment import DEFAULT_CONFIG
    c['_config_path']=str(Path(a.config or os.environ.get('ROUTEPILOT_DEPLOY_CONFIG',DEFAULT_CONFIG)).expanduser())
    state=Path(c.get('private_state_dir',Path.home()/'.local/share/routepilot/instances'/c['instance']['id']))
    if a.command=='publish':
        if a.directory.is_symlink() or a.directory.stat().st_mode & 0o077: raise ValueError('Private directory required')
        publish(c,state,a.directory,a.rotate_token)
    else:
        if not re.fullmatch(r'[a-f0-9]{24}',a.id): raise ValueError('Invalid credential ID')
        revoke(c,state,a.id,a.download_only)

if __name__=='__main__': main()
