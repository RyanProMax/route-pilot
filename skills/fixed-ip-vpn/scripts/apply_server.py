#!/usr/bin/env python3
"""Plan/apply a dedicated Xray service on systemd Linux; transactional rollback."""
import argparse, datetime, ipaddress, json, os, platform, re, secrets, subprocess, time
from pathlib import Path
from render import write_private
MARKER='# Managed by fixed-ip-vpn skill\n'
SERVICE='fixed-ip-vpn.service'

def run(args,check=True):
    return subprocess.run(args,capture_output=True,text=True,check=check)

def unit(binary):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',str(binary)): raise ValueError('Use a simple absolute binary path')
    return MARKER+f'''[Unit]
Description=Fixed IPv4 egress VPN
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
LoadCredential=config.json:/etc/fixed-ip-vpn/config.json
ExecStart={binary} run -config %d/config.json
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LimitCORE=0
CoredumpFilter=0x0
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
'''

class Host:
    def state(self):
        return {'active':run(['systemctl','is-active','--quiet',SERVICE],False).returncode==0,
                'enabled':run(['systemctl','is-enabled','--quiet',SERVICE],False).returncode==0}
    def activate(self):
        run(['systemctl','daemon-reload']); run(['systemctl','enable',SERVICE]); run(['systemctl','restart',SERVICE])
        time.sleep(1)
        if not self.state()['active']: raise RuntimeError('Service did not remain active')
    def restore(self,state):
        run(['systemctl','stop',SERVICE],False)
        if not state['enabled']: run(['systemctl','disable',SERVICE],False)
        run(['systemctl','daemon-reload'])
        if state['enabled']: run(['systemctl','enable',SERVICE])
        if state['active']: run(['systemctl','restart',SERVICE])

def paths(root):
    return root/'etc/fixed-ip-vpn/config.json',root/'etc/systemd/system'/SERVICE,root/'var/lib/fixed-ip-vpn/backups'

def restore(root,backup,host):
    config,service,_=paths(root); state=json.loads((backup/'state.json').read_text())
    # Stop before changing credential/unit files. This service alone is owned here.
    if isinstance(host,Host): run(['systemctl','stop',SERVICE],False)
    for dest,source in [(config,backup/'config.json'),(service,backup/'service.unit')]:
        if source.exists(): write_private(dest,source.read_text()); dest.chmod(0o644 if dest==service else 0o600)
        elif dest.exists(): dest.unlink()
    host.restore(state)

def transact(root,config_text,unit_text,host):
    config,service,backups=paths(root)
    if service.exists() and not service.read_text().startswith(MARKER): raise ValueError('Unmanaged service exists')
    if config.exists() and not service.exists(): raise ValueError('Unmanaged configuration exists')
    state=host.state()
    if config.exists() and service.exists() and config.read_text()==config_text and service.read_text()==unit_text and state['active'] and state['enabled']:
        return {'changed':False,'status':'already current'}
    backup=backups/(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(3))
    backup.mkdir(parents=True,mode=0o700)
    for source,name in [(config,'config.json'),(service,'service.unit')]:
        if source.exists(): write_private(backup/name,source.read_text())
    write_private(backup/'state.json',json.dumps(state))
    config.parent.mkdir(parents=True,exist_ok=True,mode=0o700); service.parent.mkdir(parents=True,exist_ok=True)
    try:
        write_private(config,config_text); write_private(service,unit_text); service.chmod(0o644)
        host.activate()
    except Exception:
        try: restore(root,backup,host)
        except Exception: raise RuntimeError('Apply AND rollback failed; inspect backup '+str(backup)) from None
        raise RuntimeError('Apply failed; automatic rollback completed. Backup: '+str(backup)) from None
    return {'changed':True,'backup':str(backup),'status':'service active; client egress still requires verification'}

def validate_config(text):
    c=json.loads(text); out=next(o for o in c['outbounds'] if o['protocol']=='freedom')
    ip=str(ipaddress.IPv4Address(out['sendThrough']))
    if out.get('streamSettings',{}).get('sockopt',{}).get('domainStrategy')!='ForceIPv4': raise ValueError('Missing ForceIPv4')
    blocked={o['tag'] for o in c['outbounds'] if o['protocol']=='blackhole'}
    if not any('::/0' in r.get('ip',[]) and r.get('outboundTag') in blocked for r in c.get('routing',{}).get('rules',[])):
        raise ValueError('IPv6 destination guard missing')
    port=c['inbounds'][0]['port']
    if type(port) is not int or not 1<=port<=65535: raise ValueError('Invalid port')
    return ip,port

def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--config'); p.add_argument('--xray',default='/usr/local/bin/xray'); p.add_argument('--version');p.add_argument('--apply',action='store_true');p.add_argument('--rollback');a=p.parse_args()
    if platform.system()!='Linux': raise ValueError('Run on the intended systemd Linux VPS')
    root=Path('/');host=Host()
    if a.rollback:
        if not a.apply or os.geteuid()!=0: raise ValueError('Rollback requires root and --apply')
        b=Path(a.rollback).resolve();base=paths(root)[2].resolve()
        if b.parent!=base or b.is_symlink(): raise ValueError('Rollback must be a direct child of the managed backup directory')
        restore(root,b,host); print(json.dumps({'rolled_back':str(b)}));return
    if not a.config or not a.version: raise ValueError('--config and --version are required')
    if not re.fullmatch(r'\d+\.\d+\.\d+',a.version): raise ValueError('Pin explicit Xray version')
    source=Path(a.config).resolve(); binary=Path(a.xray).resolve(); text=source.read_text();ip,port=validate_config(text)
    version=run([str(binary),'version']).stdout
    if not re.search(r'(?<![\d.])'+re.escape(a.version)+r'(?![\d.])',version): raise ValueError('Xray version mismatch')
    # Capture validator output: it may include sensitive configuration on failure.
    if run([str(binary),'run','-test','-config',str(source)],False).returncode: raise ValueError('Xray configuration test failed')
    addrs=json.loads(run(['ip','-j','address','show']).stdout)
    if not any(ip==v.get('local') for dev in addrs for v in dev.get('addr_info',[])):
        raise ValueError('Egress IPv4 is not assigned to this host; NAT/VIP needs a separate design')
    config,service,_=paths(root);bound=bool(run(['ss','-H','-ltn',f'sport = :{port}']).stdout.strip())
    managed=service.exists() and service.read_text().startswith(MARKER)
    if bound and not (managed and config.exists() and validate_config(config.read_text())[1]==port and host.state()['active']):
        raise ValueError('Target port occupied; do not replace another service')
    content=unit(binary)
    print(json.dumps({'plan':{'service':SERVICE,'port':port,'egress_ipv4':ip,'config_test':'passed','firewall_changed':False,'ssh_changed':False}}))
    if a.apply:
        if os.geteuid()!=0: raise ValueError('Apply requires root')
        print(json.dumps(transact(root,text,content,host)))

if __name__=='__main__':
    os.umask(0o077)
    try: main()
    except (ValueError,KeyError,OSError,subprocess.SubprocessError,RuntimeError) as e:
        # Avoid echoing subprocess output or commands containing credentials.
        raise SystemExit(str(e) if isinstance(e,(ValueError,RuntimeError)) else 'Operation failed; inspect host prerequisites. No secret values logged.')
