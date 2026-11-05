#!/usr/bin/env python3
"""Render private server/client artifacts; reuse credentials and never print them."""
import argparse, base64, hashlib, ipaddress, json, os, re, secrets, subprocess, uuid
from pathlib import Path
from urllib.parse import urlencode, quote
import routing
PRIVATE4 = ['0.0.0.0/8','100.64.0.0/10','127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','169.254.0.0/16']
PRIVATE6 = ['::1/128','fc00::/7','fe80::/10']

def write_private(path, text):
    path = Path(path)
    if path.is_symlink(): raise ValueError('Refusing symlink output')
    tmp = path.with_name(path.name + '.' + secrets.token_hex(4) + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f: f.write(text)
    os.replace(tmp, path)

def encoded(raw): return base64.urlsafe_b64encode(raw).decode().rstrip('=')

def public_key(private):
    raw = base64.urlsafe_b64decode(private + '=')
    if len(raw) != 32: raise ValueError('Invalid key length')
    der = bytes.fromhex('302e020100300506032b656e04220420') + raw
    r = subprocess.run(['openssl','pkey','-inform','DER','-pubout','-outform','DER'],input=der,capture_output=True,check=True)
    if len(r.stdout) != 44 or not r.stdout.startswith(bytes.fromhex('302a300506032b656e032100')):
        raise ValueError('Unexpected X25519 public key encoding')
    return encoded(r.stdout[-32:])

def credentials(path):
    if path.is_symlink(): raise ValueError('Refusing symlink credential file')
    if path.exists():
        if path.stat().st_mode & 0o077: raise ValueError('Credential file must have mode 600')
        c = json.loads(path.read_text()); uuid.UUID(c['uuid'])
        if not re.fullmatch('[a-f0-9]{16}',c['short_id']): raise ValueError('Invalid short ID')
        if public_key(c['private_key']) != c['public_key']: raise ValueError('Public/private key mismatch')
        return c
    private = encoded(secrets.token_bytes(32))
    c = dict(uuid=str(uuid.uuid4()),private_key=private,public_key=public_key(private),short_id=secrets.token_hex(8))
    write_private(path,json.dumps(c,indent=2)+'\n'); return c

def validate_inventory(i):
    if not re.fullmatch('[A-Za-z0-9_-]{1,40}',i['name']): raise ValueError('Name must be simple ASCII, 1–40 characters')
    for k in ['server_ipv4','egress_ipv4']: ipaddress.IPv4Address(i[k])
    if i.get('server_ipv6'): ipaddress.IPv6Address(i['server_ipv6'])
    if not re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}',i['reality_server_name']):
        raise ValueError('SNI must be a DNS hostname')
    if not re.fullmatch(r'\d+\.\d+\.\d+',i['xray_version']): raise ValueError('Pin explicit Xray version')
    for k,d in [('port',443),('mixed_port',7897),('cli_port',1088)]:
        i.setdefault(k,d)
        if type(i[k]) is not int or not 1 <= i[k] <= 65535: raise ValueError('Invalid TCP port')
    if i['mixed_port'] == i['cli_port']: raise ValueError('Client listen ports must differ')
    if i.get('preferred_family',6) not in [4,6]: raise ValueError('Preferred family must be 4 or 6')

def build(i,c):
    validate_inventory(i)
    prefix,port,sni = i['name'],i['port'],i['reality_server_name']
    nodes=[]
    for family in ([6,4] if i.get('preferred_family',6)==6 else [4,6]):
        host=i.get('server_ipv'+str(family))
        if host:
            nodes.append({'name':f'{prefix}-Direct-IPv{family}','server':host,'port':port,'type':'vless','uuid':c['uuid'],
                'network':'tcp','tls':True,'udp':True,'flow':'xtls-rprx-vision','servername':sni,'client-fingerprint':'chrome',
                'reality-opts':{'public-key':c['public_key'],'short-id':c['short_id'],
                                'support-x25519mlkem768':bool(i.get('support_x25519mlkem768',True))}})
    group=prefix+'-Fixed-IP'
    rules=[f'IP-CIDR,{ip},DIRECT,no-resolve' for ip in PRIVATE4]+[f'IP-CIDR6,{ip},DIRECT,no-resolve' for ip in PRIVATE6]
    client={'mode':'rule','ipv6':True,'log-level':'warning','mixed-port':i['mixed_port'],'allow-lan':False,'bind-address':'127.0.0.1',
        'profile':{'store-selected':True},'proxies':nodes,
        'proxy-groups':[{'name':group,'type':'url-test','proxies':[n['name'] for n in nodes],
                         'url':'https://www.gstatic.com/generate_204','interval':300,'timeout':5000,'lazy':True}],
        'rules':rules+['MATCH,'+group],
        'listeners':[{'name':'fixed-ip-cli','type':'mixed','listen':'127.0.0.1','port':i['cli_port'],'proxy':group}],
        'tun':{'enable':True,'stack':'gvisor','auto-route':True,'auto-detect-interface':True,'dns-hijack':['any:53']},
        'dns':{'enable':True,'listen':'127.0.0.1:0','ipv6':False,'enhanced-mode':'fake-ip','fake-ip-range':'198.18.0.1/16',
               'respect-rules':True,'default-nameserver':['223.5.5.5','119.29.29.29'],
               'proxy-server-nameserver':['https://dns.alidns.com/dns-query'],
               'nameserver':['https://1.1.1.1/dns-query','https://8.8.8.8/dns-query']}}
    imported=json.loads(Path(i['routing_rules_file']).read_text()) if i.get('routing_rules_file') else None
    client=routing.apply(client,imported)
    server={'log':{'loglevel':'warning','access':'none'},'dns':{'servers':['1.1.1.1','8.8.8.8'],'queryStrategy':'UseIPv4'},
        'inbounds':[{'tag':'direct-vless','listen':'::' if i.get('server_ipv6') else '0.0.0.0','port':port,'protocol':'vless',
            'settings':{'clients':[{'id':c['uuid'],'flow':'xtls-rprx-vision'}],'decryption':'none'},
            'streamSettings':{'network':'tcp','security':'reality',
                'realitySettings':{'show':False,'dest':sni+':443','xver':0,'serverNames':[sni],
                                   'privateKey':c['private_key'],'shortIds':[c['short_id']]}},
            'sniffing':{'enabled':True,'destOverride':['http','tls','quic']}}],
        'outbounds':[{'tag':'fixed-ipv4','protocol':'freedom','sendThrough':i['egress_ipv4'],
                       'streamSettings':{'sockopt':{'domainStrategy':'ForceIPv4'}}},{'tag':'block','protocol':'blackhole'}],
        'routing':{'domainStrategy':'IPOnDemand','rules':[{'type':'field','ip':['::/0']+PRIVATE4,'outboundTag':'block'}]}}
    links=[]
    for n in nodes:
        host='['+n['server']+']' if ':' in n['server'] else n['server']
        query=urlencode({'encryption':'none','security':'reality','sni':sni,'fp':'chrome','pbk':c['public_key'],
                         'sid':c['short_id'],'type':'tcp','flow':'xtls-rprx-vision'})
        links.append(f'vless://{c["uuid"]}@{host}:{port}?{query}#{quote(n["name"])}')
    return {'xray-server.json':json.dumps(server,indent=2)+'\n','clash-verge.yaml':json.dumps(client,indent=2)+'\n',
        'shadowrocket-nodes.txt':'\n'.join(links)+'\n',
        'shadowrocket-rules.conf':routing.shadowrocket()}

def render(inventory,out):
    os.umask(0o077); out=Path(out)
    if out.is_symlink(): raise ValueError('Refusing symlink output directory')
    out.mkdir(mode=0o700,parents=True,exist_ok=True); out.chmod(0o700)
    i=json.loads(Path(inventory).read_text()); validate_inventory(i)
    c=credentials(out/'credentials.json'); artifacts=build(i,c)
    for name,data in artifacts.items(): write_private(out/name,data)
    manifest={'name':i['name'],'egress_ipv4':i['egress_ipv4'],'port':i['port'],'xray_version':i['xray_version'],
        'files_sha256':{name:hashlib.sha256(data.encode()).hexdigest() for name,data in artifacts.items()},
        'status':'generated; not deployed or connectivity-verified'}
    write_private(out/'manifest.json',json.dumps(manifest,indent=2)+'\n')
    return {'directory':str(out.resolve()),'files':list(artifacts)+['manifest.json'],'credentials_reused_on_rerun':True}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--inventory',required=True); p.add_argument('--out',required=True); a=p.parse_args()
    try: print(json.dumps(render(a.inventory,a.out)))
    except (ValueError,KeyError,OSError,subprocess.SubprocessError): raise SystemExit('Generation failed; check inventory, credential permissions and OpenSSL support. No secret values logged.')
