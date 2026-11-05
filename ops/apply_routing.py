#!/usr/bin/env python3
"""Prepare or apply a standalone routing repair without retaining source identity."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'skills/fixed-ip-vpn/scripts'))
import routing

def read(path):
    try:return json.loads(path.read_text())
    except json.JSONDecodeError:
        return json.loads(subprocess.run(['ruby','-ryaml','-rjson','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',str(path)],capture_output=True,text=True,check=True).stdout)

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--profile',required=True,type=Path)
    p.add_argument('--rules-from',type=Path)
    p.add_argument('--out',required=True,type=Path)
    p.add_argument('--mihomo',default='/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo')
    p.add_argument('--data-dir',required=True,type=Path)
    p.add_argument('--apply',action='store_true')
    args=p.parse_args();os.umask(0o077)
    if args.profile.resolve()==args.out.resolve() or (args.out.exists() and os.path.samefile(args.profile,args.out)):
        p.error('--out must be separate from --profile; originals are changed only after --apply and successful validation')
    old=read(args.profile)
    source=read(args.rules_from).get('rules') if args.rules_from else None
    discarded=0
    if source:
        finals=[i for i,r in enumerate(source) if r.startswith('MATCH,')]
        if len(finals)==1:
            discarded=len(source)-finals[0]-1
            source=source[:finals[0]+1]
    new=routing.apply(old,source)
    args.out.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    with tempfile.TemporaryDirectory(prefix='.routing-',dir=args.out.parent) as tmp:
        candidate=Path(tmp)/'candidate.json'
        candidate.write_text(json.dumps(new,ensure_ascii=False,indent=2)+'\n');candidate.chmod(0o600)
        test=subprocess.run([args.mihomo,'-t','-d',str(args.data_dir),'-f',str(candidate)],capture_output=True,text=True)
        if test.returncode:raise SystemExit('Candidate rejected by Mihomo; original profile unchanged')
        os.replace(candidate,args.out)
    if args.apply:
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup=args.out.parent/('routing-backup-'+stamp)
        backup.mkdir(mode=0o700)
        shutil.copy2(args.profile,backup/'profile.before.yaml')
        with tempfile.NamedTemporaryFile(dir=args.profile.parent,delete=False) as staged:
            staged.write(args.out.read_bytes())
            staged.flush();os.fsync(staged.fileno())
        try:os.replace(staged.name,args.profile)
        finally:Path(staged.name).unlink(missing_ok=True)
    print(json.dumps({'syntax_valid':True,'rules':len(new['rules']),'applied':args.apply,'rule_digest':hashlib.sha256(json.dumps(new['rules']).encode()).hexdigest(),'source_identity_retained':False,'unreachable_trailing_rules_removed':discarded}))

if __name__=='__main__':main()
