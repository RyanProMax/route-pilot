"""Runtime confinement for an existing non-root Xray service on systemd/nftables."""
import copy
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile
import time
from devices import private
from devices.provision import xray_config
from devices.registry import Registry

PRIVATE4 = ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16',
            '172.16.0.0/12','192.168.0.0/16','198.18.0.0/15','224.0.0.0/4','240.0.0.0/4']


def protected_config(original):
    c=copy.deepcopy(original)
    blocks=[o['tag'] for o in c.get('outbounds',[]) if o.get('protocol')=='blackhole']
    if not blocks:raise ValueError('A blackhole outbound is required')
    routing=c.setdefault('routing',{})
    routing['domainStrategy']='IPOnDemand'
    guard={'type':'field','ip':['::/0',*PRIVATE4],'outboundTag':blocks[0]}
    rules=routing.get('rules',[])
    routing['rules']=[guard]+[r for r in rules if r!=guard]
    c['log']={'loglevel':'warning','access':'none'}
    return c


def nft_policy(uid,port):
    if type(uid) is not int or uid<=0 or type(port) is not int or not 1024<=port<=65535:
        raise ValueError('Static non-root Xray UID and unprivileged statistics port required')
    return f'''# route-pilot-owned table only; never flush the host ruleset.
add table inet routepilot_guard
flush table inet routepilot_guard
table inet routepilot_guard {{
 chain output {{
  type filter hook output priority -5; policy accept;
  meta skuid != 0 ip daddr 127.0.0.1 tcp dport {port} counter reject
  meta skuid {uid} ct state established,related accept
  meta skuid {uid} ip daddr {{ 127.0.0.53, 127.0.0.54 }} meta l4proto {{ tcp, udp }} th dport 53 accept
  meta skuid {uid} ip6 daddr ::1 meta l4proto {{ tcp, udp }} th dport 53 accept
  meta skuid {uid} ip daddr {{ {', '.join(PRIVATE4)} }} counter reject
  meta skuid {uid} ip6 daddr {{ ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8 }} counter reject
 }}
}}
'''


def dropin(config_path):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',str(config_path)):
        raise ValueError('Use a simple absolute Xray configuration path')
    return '''# Managed by route-pilot
[Unit]
Requires=routepilot-xray-guard.service
After=routepilot-xray-guard.service

[Service]
LoadCredential=routepilot-xray.json:CONFIG_PATH
ExecStart=
ExecStart=/usr/local/bin/xray run -config %d/routepilot-xray.json
CapabilityBoundingSet=
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
LockPersonality=yes
LimitCORE=0
CoredumpFilter=0x0
UMask=0077
InaccessiblePaths=-/var/lib/routepilot-devices -/etc/routepilot-devices -/etc/routepilot-report -/var/lib/routepilot/backups
'''.replace('CONFIG_PATH',str(config_path))


def run(*args,check=True):
    r=subprocess.run(args,capture_output=True,text=True,timeout=25)
    if check and r.returncode:raise RuntimeError('Runtime security operation failed; captured output is private')
    return r


def apply(settings):
    if os.geteuid()!=0:raise ValueError('Run the security workflow as root on the target VPS')
    service=settings['xray_service']
    if not re.fullmatch('[A-Za-z0-9_-]+',service):raise ValueError('Invalid service')
    user=run('systemctl','show',service,'-p','User','--value').stdout.strip()
    if run('systemctl','show',service,'-p','DynamicUser','--value').stdout.strip()=='yes':
        raise ValueError('A DynamicUser service needs an explicit firewall identity design')
    uid=pwd.getpwnam(user).pw_uid
    port=int(settings.get('stats_port',10085))
    policy=nft_policy(uid,port)
    path=Path(settings['xray_config'])
    if path.is_symlink():raise ValueError('Refusing symlink Xray configuration')
    r=Registry('/var/lib/routepilot-devices')
    with r.administration():
        old=path.read_text();metadata=path.stat()
        new=protected_config(xray_config(json.loads(old),r.devices(),port))
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json',dir=path.parent) as candidate:
            json.dump(new,candidate);candidate.flush()
            run('/usr/local/bin/xray','run','-test','-config',candidate.name)
        backup=private.directory(Path('/var/lib/routepilot/backups')/('runtime-security-'+str(time.time_ns())))
        private.write(backup/'config.json',old)
        prior=run('/usr/sbin/nft','list','table','inet','routepilot_guard',check=False)
        if prior.returncode==0:private.write(backup/'guard.nft',prior.stdout)
        guard_unit='''[Unit]
Description=route-pilot proxy egress isolation
Before='''+service+'''.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/routepilot-security/egress.nft
ExecReload=/usr/sbin/nft -f /etc/routepilot-security/egress.nft
ExecStop=-/usr/sbin/nft delete table inet routepilot_guard

[Install]
WantedBy=multi-user.target
'''
        files={Path('/etc/routepilot-security/egress.nft'):(policy,0o600),
               Path('/etc/systemd/system/routepilot-xray-guard.service'):(guard_unit,0o644),
               Path('/etc/systemd/system')/(service+'.service.d/90-routepilot-security.conf'):(dropin(path),0o644)}
        originals={p:(p.read_bytes(),p.stat().st_mode&0o777) if p.exists() else None for p in files}
        for n,(p,value) in enumerate(originals.items()):
            if value:private.write(backup/(str(n)+'.before'),value[0])
        def replace(p,body,mode,owner=None):
            p.parent.mkdir(parents=True,exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=p.parent,delete=False) as f:
                f.write(body.encode() if isinstance(body,str) else body);os.fchmod(f.fileno(),mode)
                if owner:os.fchown(f.fileno(),*owner)
            os.replace(f.name,p)
        try:
            private.directory('/etc/routepilot-security')
            for p,(body,mode) in files.items():replace(p,body,mode)
            run('/usr/sbin/nft','-c','-f','/etc/routepilot-security/egress.nft')
            run('systemd-analyze','verify',service+'.service','routepilot-xray-guard.service')
            run('systemctl','daemon-reload')
            run('systemctl','enable','routepilot-xray-guard.service')
            run('systemctl','reload-or-restart','routepilot-xray-guard.service')
            replace(path,json.dumps(new,indent=2)+'\n',0o600,(0,0))
            run('systemctl','restart',service);time.sleep(1)
            run('systemctl','is-active','--quiet',service)
            run('/usr/local/bin/xray','api','statsgetallonlineusers','--server=127.0.0.1:'+str(port),'-timeout','2')
        except Exception:
            for p,value in originals.items():
                if value:replace(p,value[0],value[1])
                else:p.unlink(missing_ok=True)
            replace(path,old,metadata.st_mode&0o777,(metadata.st_uid,metadata.st_gid))
            run('systemctl','daemon-reload')
            if prior.returncode:
                run('systemctl','disable','--now','routepilot-xray-guard.service',check=False)
                run('/usr/sbin/nft','delete','table','inet','routepilot_guard',check=False)
            else:
                recovery=backup/'restore-guard.nft'
                private.write(recovery,'add table inet routepilot_guard\nflush table inet routepilot_guard\n'+prior.stdout)
                run('/usr/sbin/nft','-f',str(recovery))
            run('systemctl','restart',service)
            raise RuntimeError('Runtime hardening failed; prior configuration restored') from None
        return {'runtime_hardened':True,'stats_root_only':True,'private_egress_blocked':True}
