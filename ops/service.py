#!/usr/bin/env python3
"""Install or remove the local user's route-pilot LaunchAgent."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
LABEL='dev.routepilot.monitor'

def unload(target):
    subprocess.run(['launchctl','bootout',target],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    deadline=time.monotonic()+50
    while subprocess.run(['launchctl','print',target],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
        if time.monotonic()>deadline:raise SystemExit('Old monitor is still exiting; no replacement service started')
        time.sleep(.2)

def bootstrap(path):
    # launchd can briefly report EIO while a just-unloaded label is being reaped.
    for attempt in range(10):
        result=subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(path)],capture_output=True,text=True)
        if result.returncode==0:return
        if attempt<9 and 'Bootstrap failed: 5:' in result.stderr:time.sleep(.5)
        else:raise RuntimeError(result.stderr.strip())

def main():
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['install','stop','status','uninstall'])
    p.add_argument('--state',type=Path,default=Path.home()/'.local/share/routepilot')
    a=p.parse_args()
    path=Path.home()/'Library/LaunchAgents'/f'{LABEL}.plist'
    target=f'gui/{os.getuid()}/{LABEL}'
    if a.action=='status':
        raise SystemExit(subprocess.run(['launchctl','print',target]).returncode)
    if a.action=='uninstall':
        unload(target)
        path.unlink(missing_ok=True);print('Service removed; private data retained.');return
    if a.action=='stop':
        unload(target)
        print('Service stopped; private data retained.');return
    if not (ROOT/'web/dist/index.html').is_file():raise SystemExit('Build WebUI before installation')
    # LaunchAgents must not depend on interactive access to protected Documents.
    release=a.state/'releases'/str(time.time_ns())
    release.mkdir(parents=True,mode=0o700)
    shutil.copytree(ROOT/'routepilot',release/'routepilot',ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(ROOT/'web/dist',release/'web')
    subprocess.run([sys.executable,'-m','compileall','-q',str(release/'routepilot')],check=True)
    # Prepare the full release before interrupting the running service.
    unload(target)
    path.parent.mkdir(exist_ok=True)
    data={'Label':LABEL,'ProgramArguments':[sys.executable,'-m','routepilot.daemon','--state',str(a.state),'--web',str(release/'web')],
          'WorkingDirectory':str(release),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'ProcessType':'Background','ExitTimeOut':45,
          'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin','PYTHONUNBUFFERED':'1'},
          'StandardOutPath':str(a.state/'launchd.stdout.log'),'StandardErrorPath':str(a.state/'launchd.stderr.log'),
          'Umask':63}
    path.write_bytes(plistlib.dumps(data));path.chmod(0o600)
    subprocess.run(['launchctl','enable',target],check=True)
    bootstrap(path)
    print('route-pilot installed: http://127.0.0.1:8787')

if __name__=='__main__':main()
