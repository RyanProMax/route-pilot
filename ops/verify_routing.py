#!/usr/bin/env python3
"""Verify real Mihomo rule matches using public, non-authenticated requests."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from routepilot.probes import clean_env, http

def control(sock,endpoint):
    r=subprocess.run(['/usr/bin/curl','-fsS','--max-time','2','--unix-socket',str(sock),'http://localhost'+endpoint],capture_output=True,text=True,timeout=3,env=clean_env())
    return json.loads(r.stdout) if r.returncode==0 else {}

def check(proxy,sock,host,direct):
    from urllib.parse import urlsplit
    import ssl
    parsed=urlsplit(proxy)
    evidence=None
    try:
        with socket.create_connection((parsed.hostname,parsed.port),timeout=8) as transport:
            transport.sendall(f'CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n'.encode())
            response=b''
            while not response.endswith(b'\r\n\r\n') and len(response)<4096:
                chunk=transport.recv(1)
                if not chunk:break
                response+=chunk
            if not response.startswith(b'HTTP/1.1 200'):raise OSError('HTTP CONNECT rejected')
            with ssl.create_default_context().wrap_socket(transport,server_hostname=host):
                for c in (control(sock,'/connections').get('connections') or []):
                    if c.get('metadata',{}).get('host')==host:
                        evidence={'host':host,'chains':c.get('chains',[]),'rule':c.get('rule'),'payload':c.get('rulePayload'),'tls_verified':True}
                        break
    except (OSError,ssl.SSLError) as e:
        return {'host':host,'passed':False,'message':str(e)[:160]}
    if evidence:
        evidence['passed']=('DIRECT' in evidence['chains']) if direct else ('DIRECT' not in evidence['chains'] and any('IPv6' in x for x in evidence['chains']))
    return evidence or {'host':host,'passed':False,'message':'No matching connection observed'}

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--candidate',required=True,type=Path)
    p.add_argument('--data-dir',required=True,type=Path)
    p.add_argument('--interface',default='en1')
    p.add_argument('--expected-ip',required=True)
    p.add_argument('--report',required=True,type=Path)
    p.add_argument('--live-socket',type=Path)
    p.add_argument('--live-proxy',default='http://127.0.0.1:7897')
    a=p.parse_args();os.umask(0o077)
    proc=None;log=None
    with tempfile.TemporaryDirectory(prefix='routepilot-routing-') as tmp:
        root=Path(tmp)
        if a.live_socket:proxy,sock=a.live_proxy,a.live_socket
        else:
            cfg=json.loads(a.candidate.read_text())
            node=next(n for n in cfg['proxies'] if ':' in n['server'])
            cfg['proxies']=[node]
            cfg['proxy-groups'][0].update({'type':'select','proxies':[node['name']]})
            for key in ['url','interval','timeout','lazy']:cfg['proxy-groups'][0].pop(key,None)
            sock=root/'control.sock';port=1199
            with socket.socket() as s:s.bind(('127.0.0.1',port))
            cfg.update({'mixed-port':port,'listeners':[],'tun':{'enable':False},'interface-name':a.interface,'external-controller-unix':str(sock),'secret':''})
            cfg['dns']['listen']='127.0.0.1:0'
            (root/'config.json').write_text(json.dumps(cfg))
            shutil.copy2(a.data_dir/'Country.mmdb',root/'Country.mmdb')
            log=(root/'client.log').open('w')
            proc=subprocess.Popen(['/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo','-d',str(root),'-f',str(root/'config.json')],stdout=log,stderr=log,env=clean_env())
            for _ in range(50):
                if sock.exists():break
                if proc.poll() is not None:raise SystemExit('Routing test client failed')
                time.sleep(.1)
            proxy=f'http://127.0.0.1:{port}'
        try:
            checks=[check(proxy,sock,'weixin.qq.com',True),check(proxy,sock,'mmbiz.qpic.cn',True),check(proxy,sock,'api.ipify.org',False)]
            egress=http('https://api.ipify.org',proxy,a.expected_ip)
            domestic=http('https://weixin.qq.com/',proxy)
            result={'scope':'active client' if a.live_socket else 'isolated candidate','at':time.time(),'checks':checks,'egress':egress,'domestic_http':domestic,'passed':all(c['passed'] for c in checks) and egress[0] in ('ok','degraded') and domestic[0] in ('ok','degraded'),'image_in_app_verified':False}
            a.report.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');a.report.chmod(0o600)
            print(json.dumps(result,ensure_ascii=False))
            if not result['passed']:raise SystemExit(1)
        finally:
            if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=5)
            if log:log.close()

if __name__=='__main__':main()
