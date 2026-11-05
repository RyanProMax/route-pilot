#!/usr/bin/env python3
"""Install the pinned official Gatus Go module using a compatible local toolchain."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

VERSION='v5.38.0'

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--state',type=Path,default=Path.home()/'.local/share/routepilot')
    p.add_argument('--go',help='Go executable, version 1.26.3 or newer')
    a=p.parse_args();os.umask(0o077)
    candidate=a.state/'toolchain/go/bin/go'
    go=a.go or (str(candidate) if candidate.is_file() else shutil.which('go'))
    if not go:raise SystemExit('Install Go 1.26.3+ from https://go.dev/dl/ and verify its official SHA256 first')
    env=os.environ.copy();env['GOTOOLCHAIN']='local';env['GOBIN']=str(a.state/'bin')
    version=subprocess.check_output([go,'version'],env=env,text=True).strip()
    match=re.search(r'go(\d+)\.(\d+)(?:\.(\d+))?',version)
    if not match or tuple(int(n or 0) for n in match.groups())<(1,26,3):raise SystemExit('Go >=1.26.3 is required; install an official verified toolchain before retrying')
    (a.state/'bin').mkdir(parents=True,exist_ok=True,mode=0o700)
    subprocess.run([go,'install','github.com/TwiN/gatus/v5@'+VERSION],env=env,check=True)
    binary=a.state/'bin/gatus'
    data={'module':'github.com/TwiN/gatus/v5','version':VERSION,'toolchain':version,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
          'build_metadata':subprocess.check_output([go,'version','-m',str(binary)],env=env,text=True)}
    (a.state/'gatus-build.json').write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps({k:v for k,v in data.items() if k!='build_metadata'}))

if __name__=='__main__':main()
