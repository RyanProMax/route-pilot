"""Root-only provisioning and revocation. No public administrative endpoint."""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import tempfile
from devices.registry import Registry

EMAIL_PREFIX='rp.'
EMAIL_SUFFIX='@routepilot.invalid'
MANAGED_EMAIL=re.compile(r'rp\.[a-f0-9]{24}@routepilot\.invalid')

def managed_email(device):return EMAIL_PREFIX+device+EMAIL_SUFFIX

def xray_config(original,devices,api_port):
    c=copy.deepcopy(original)
    inbounds=[i for i in c.get('inbounds',[]) if i.get('protocol')=='vless' and i.get('streamSettings',{}).get('security')=='reality']
    if len(inbounds)!=1:raise ValueError('Expected one REALITY inbound; select/migrate manually for other layouts')
    users=inbounds[0]['settings']['clients']
    legacy=[u for u in users if not MANAGED_EMAIL.fullmatch(u.get('email',''))]
    for n,u in enumerate(legacy):
        if not u.get('email'):u['email']=f'legacy-{n}@routepilot.invalid'
    users[:]=legacy+[{'id':d['credential'],'email':managed_email(d['id']),'flow':'xtls-rprx-vision','level':0} for d in devices if not d['revoked']]
    api=c.get('api')
    if api and api.get('tag')!='routepilot-stats':raise ValueError('Existing API is not managed by route-pilot')
    c['api']={'tag':'routepilot-stats','listen':f'127.0.0.1:{api_port}','services':['StatsService']}
    c.setdefault('stats',{})
    levels=c.setdefault('policy',{}).setdefault('levels',{})
    for user in users:
        level=levels.setdefault(str(user.get('level',0)),{})
        level.update(statsUserOnline=True,statsUserUplink=True,statsUserDownlink=True)
    return c

def apply_xray(c,path,service,binary='/usr/local/bin/xray',backup_dir='/var/lib/routepilot/backups'):
    path=Path(path)
    if path.is_symlink() or not re.fullmatch(r'[A-Za-z0-9_-]+',service):raise ValueError('Invalid service/config target')
    new=json.dumps(c,indent=2)+'\n';old=path.read_text();metadata=path.stat()
    if json.loads(old)==c:return
    fd,name=tempfile.mkstemp(prefix='.routepilot-',suffix='.json',dir=path.parent)
    staged=Path(name)
    with os.fdopen(fd,'w') as f:
        f.write(new)
        os.fchmod(f.fileno(),metadata.st_mode & 0o777)
        os.fchown(f.fileno(),metadata.st_uid,metadata.st_gid)
    try:
        result=subprocess.run([binary,'run','-test','-config',str(staged)],capture_output=True,timeout=15)
    except Exception:
        staged.unlink(missing_ok=True)
        raise RuntimeError('Xray candidate validation failed; configuration unchanged') from None
    if result.returncode:staged.unlink();raise RuntimeError('Xray rejected candidate configuration')
    backups=Path(backup_dir);backups.mkdir(parents=True,exist_ok=True,mode=0o700)
    backup=backups/('xray-devices-'+str(time.time_ns())+'.json')
    backup.write_text(old);backup.chmod(0o600)
    try:
        os.replace(staged,path)
        subprocess.run(['systemctl','restart',service],check=True,capture_output=True,timeout=15)
        time.sleep(1)
        subprocess.run(['systemctl','is-active','--quiet',service],check=True,timeout=5)
    except Exception:
        fd,name=tempfile.mkstemp(prefix='.routepilot-restore-',suffix='.json',dir=path.parent)
        with os.fdopen(fd,'w') as f:
            f.write(old)
            os.fchmod(f.fileno(),metadata.st_mode & 0o777)
            os.fchown(f.fileno(),metadata.st_uid,metadata.st_gid)
        os.replace(name,path)
        subprocess.run(['systemctl','restart',service],check=True,capture_output=True,timeout=15)
        raise RuntimeError('Xray change failed; previous configuration restored') from None

def build_profiles(source,device,settings):
    scripts=Path(__file__).resolve().parents[1]/'skills/fixed-ip-vpn/scripts'
    sys.path.insert(0,str(scripts))
    import render
    i=next(i for i in source['inbounds'] if i.get('protocol')=='vless' and i.get('streamSettings',{}).get('security')=='reality')
    reality=i['streamSettings']['realitySettings'];node=settings['instance']
    inv={'name':node['id'],'server_ipv4':node['ipv4'],'server_ipv6':node.get('ipv6'),'egress_ipv4':node['ipv4'],
         'port':node['port'],'reality_server_name':reality['serverNames'][0],'xray_version':settings.get('xray_version','26.10.31'),
         'preferred_family':6 if node.get('ipv6') else 4}
    if settings.get('routing_rules_file'):inv['routing_rules_file']=settings['routing_rules_file']
    creds={'uuid':device['credential'],'private_key':reality['privateKey'],
           'public_key':render.public_key(reality['privateKey']),'short_id':reality['shortIds'][0]}
    files=render.build(inv,creds)
    return {'clash.yaml':files['clash-verge.yaml'],
            'shadowrocket.txt':files['shadowrocket-nodes.txt'],
            'rules.conf':files['shadowrocket-rules.conf']}

def provision(registry,settings,label,client):
    with registry.administration():
        return _provision(registry,settings,label,client)

def _provision(registry,settings,label,client):
    config_path=Path(settings['xray_config']);source=json.loads(config_path.read_text())
    existing=registry.find(label)
    if client not in ('clash','shadowrocket'):raise ValueError('Invalid output format')
    d=existing or registry.create(label,client)
    try:
        profiles=build_profiles(source,d,settings)
        registry.write_profiles(d['id'],profiles)
        c=xray_config(source,registry.devices(),settings.get('stats_port',10085))
        apply_xray(c,config_path,settings['xray_service'])
    except Exception:
        if not existing:registry.revoke(d['id'])
        raise
    return d

def revoke(registry,settings,device):
    with registry.administration():
        all_devices=registry.devices();target=next((d for d in all_devices if d['id']==device),None)
        if not target:raise ValueError('Unknown active device')
        remaining=[d for d in all_devices if d['id']!=device]
        c=xray_config(json.loads(Path(settings['xray_config']).read_text()),remaining,settings.get('stats_port',10085))
        apply_xray(c,settings['xray_config'],settings['xray_service'])
        registry.revoke(device)

def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--settings',required=True);p.add_argument('--state',default='/var/lib/routepilot-devices')
    sub=p.add_subparsers(dest='command',required=True)
    delete=sub.add_parser('revoke');delete.add_argument('--device',required=True)
    sub.add_parser('list')
    a=p.parse_args();settings=json.loads(Path(a.settings).read_text());r=Registry(a.state)
    if a.command=='revoke':
        revoke(r,settings,a.device)
        print('Node credential revoked')
    else:
        print(json.dumps([{k:d[k] for k in ('id','label','client','created','revoked')} for d in r.devices(True)],ensure_ascii=False))
if __name__=='__main__':main()
