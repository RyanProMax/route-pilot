#!/usr/bin/env python3
"""Prepare private runtime data from an existing standalone Mihomo profile."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]

def daily_proxy(profile):
    for kind,scheme in [('mixed-port','http'),('port','http'),('socks-port','socks5h')]:
        port=profile.get(kind)
        if isinstance(port,int) and 1<=port<=65535:
            return f'{scheme}://127.0.0.1:{port}'
    raise ValueError('Profile needs a rule-based mixed, HTTP or SOCKS listener for daily routing checks')

def trusted_keys(path,ipv4,ipv6,port):
    for host in [f'[{ipv6}]:{port}',f'[{ipv4}]:{port}',ipv6,ipv4]:
        lookup=subprocess.run(['/usr/bin/ssh-keygen','-F',host,'-f',str(path)],capture_output=True,text=True)
        if lookup.returncode==0:
            lines=[line for line in lookup.stdout.splitlines() if line and not line.startswith('#')]
            if lines:return lines
    raise ValueError('No verified host key; verify server fingerprint before setup')

def save(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n")
    path.chmod(0o600)

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--profile',required=True,type=Path)
    p.add_argument('--ipv4',required=True)
    p.add_argument('--ipv6',required=True)
    p.add_argument('--interface',required=True)
    p.add_argument('--ssh-port',type=int,default=22222)
    p.add_argument('--state',type=Path,default=Path.home()/'.local/share/routepilot')
    p.add_argument('--mihomo',default='/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo')
    args=p.parse_args()
    assert ipaddress.ip_address(args.ipv4).version==4
    assert ipaddress.ip_address(args.ipv6).version==6
    os.umask(0o077)
    state=args.state.resolve()
    state.mkdir(parents=True,exist_ok=True,mode=0o700)
    state.chmod(0o700)
    try:profile=json.loads(args.profile.read_text())
    except json.JSONDecodeError:
        result=subprocess.run(['ruby','-ryaml','-rjson','-e','puts JSON.generate(YAML.load_file(ARGV[0]))',str(args.profile)],capture_output=True,text=True,check=True)
        profile=json.loads(result.stdout)
    nodes=[n for n in profile.get('proxies',[]) if n.get('server')==args.ipv6 and n.get('type')=='vless']
    if len(nodes)!=1:raise SystemExit('Expected exactly one VLESS node for the IPv6 address')
    node=dict(nodes[0])
    if any(k in node for k in ('dialer-proxy','underlying-proxy')):raise SystemExit('Chained nodes are not allowed')
    if not node.get('tls') or node.get('skip-cert-verify'):raise SystemExit('TLS verification is required')
    node['name']='DIRECT-NODE'
    key=state/'monitor_ed25519'
    if not key.exists():
        subprocess.run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-C','routepilot-readonly','-f',str(key)],check=True)
    previous=json.loads((state/'config.json').read_text()) if (state/'config.json').exists() else {}
    cfg={'interface':args.interface,'ipv4':args.ipv4,'ipv6':args.ipv6,'expected_ipv4':args.ipv4,'proxy_port':node['port'],
         'probe_port':1198,'web_port':8787,'gatus_port':8788,'interval':60,'daily_proxy':daily_proxy(profile),
         'mihomo_binary':args.mihomo,'gatus_token':previous.get('gatus_token') or secrets.token_urlsafe(32),
         'ssh':{'port':args.ssh_port,'monitor_user':'routepilot-monitor','monitor_key':str(key),'known_hosts':str(state/'known_hosts')}}
    # Only reuse a host key already trusted by the user's SSH configuration.
    lines=trusted_keys(Path.home()/'.ssh/known_hosts',args.ipv4,args.ipv6,args.ssh_port)
    hosts=[]
    for line in lines:
        parts=line.split()
        if parts[0].startswith('@'):raise SystemExit('Marked host keys need manual review')
        hosts.append(f'[{args.ipv6}]:{args.ssh_port} '+ ' '.join(parts[1:3]))
    (state/'known_hosts').write_text('\n'.join(hosts)+'\n')
    (state/'known_hosts').chmod(0o600)
    save(state/'config.json',cfg)
    save(state/'mihomo.json',{'mixed-port':cfg['probe_port'],'bind-address':'127.0.0.1','allow-lan':False,'mode':'rule','log-level':'warning','ipv6':True,
         'interface-name':args.interface,'tun':{'enable':False},'dns':{'enable':False},'proxies':[node],'proxy-groups':[],
         'profile':{'store-selected':False,'store-fake-ip':False},'rules':['MATCH,DIRECT-NODE']})
    sys.path.insert(0,str(ROOT))
    from routepilot.daemon import CHECKS
    save(state/'gatus.yaml',{'web':{'address':'127.0.0.1','port':cfg['gatus_port']},'storage':{'type':'sqlite','path':str(state/'gatus.db'),'maximum-number-of-results':43200,'maximum-number-of-events':100},
         'ui':{'title':'route-pilot · Gatus','header':'route-pilot','dashboard-heading':'route-pilot probes'},
         'endpoints':[{'name':'collector','group':'internal','url':f'http://127.0.0.1:{cfg["web_port"]}/health','interval':'60s','conditions':['[STATUS] == 200'],'client':{'timeout':'5s'}}],
         'external-endpoints':[{'name':c['id'],'group':'routepilot','token':cfg['gatus_token']} for c in CHECKS]})
    print(json.dumps({'prepared':str(state),'monitor_public_key_file':str(key)+'.pub','web_port':cfg['web_port'],'credentials_printed':False}))

if __name__=='__main__':main()
