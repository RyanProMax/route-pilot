"""Explicitly install a user-level Mac probe; never changes network or power settings.

Requires a pre-provisioned, narrowly scoped probe token. Does not publish Workers.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from deployment import load_config
from mac_probe import load_config as validate_probe_config


def install(deployment, token_file, root=None):
    if sys.platform != 'darwin': raise ValueError('macOS required')
    if token_file.stat().st_mode & 0o077: raise ValueError('Token file must be private')
    token = token_file.read_text().strip()
    home = Path.home() if root is None else root
    target = home/'Library/Application Support/routepilot/mac-probe'
    target.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(target,0o700)
    config = target/'config.json'
    i=deployment['instance']
    data={'ipv4':i['ipv4'],'ipv6':i.get('ipv6'),'port':i['port'],
          'endpoint':'https://'+deployment['status_hostname']+'/private/mac-probe-ingest','token':token}
    if 'aggregate_start' in deployment: data['aggregate_start']=deployment['aggregate_start']
    fd, name=tempfile.mkstemp(prefix='.config-',dir=target)
    temporary=Path(name)
    try:
        with os.fdopen(fd,'w') as output:json.dump(data,output)
        validate_probe_config(temporary)
        os.replace(temporary,config)
    finally:
        temporary.unlink(missing_ok=True)
    script=target/'mac_probe.py';shutil.copyfile(Path(__file__).with_name('mac_probe.py'),script)
    shutil.copyfile(Path(__file__).resolve().parents[1]/'cloud/routepilot_aggregate.py',target/'routepilot_aggregate.py')
    agent=home/'Library/LaunchAgents/com.routepilot.mac-probe.plist'
    agent.parent.mkdir(parents=True,exist_ok=True)
    label='com.routepilot.mac-probe'
    plist={'Label':label,'ProgramArguments':[sys.executable,str(script),'--config',str(config)],
           'StartCalendarInterval':{},'RunAtLoad':True,'ProcessType':'Background',
           'StandardOutPath':str(target/'probe.log'),'StandardErrorPath':str(target/'error.log')}
    agent.write_bytes(plistlib.dumps(plist));os.chmod(agent,0o600)
    domain=f'gui/{os.getuid()}'
    subprocess.run(['/bin/launchctl','bootout',domain+'/'+label],check=False,capture_output=True)
    subprocess.run(['/bin/launchctl','bootstrap',domain,str(agent)],check=True)
    print('Mac probe installed; verify ingestion before claiming live monitoring')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config');p.add_argument('--token-file',type=Path,required=True)
    a=p.parse_args();install(load_config(a.config),a.token_file)
