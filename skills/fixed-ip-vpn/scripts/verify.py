#!/usr/bin/env python3
"""Public egress checks; neither trade nor signed account requests."""
import argparse, concurrent.futures, datetime, ipaddress, json, os, subprocess
from pathlib import Path
from render import write_private
SITES=['https://ifconfig.me/ip','https://api64.ipify.org']

def check(url,expected,proxy=None):
    env={k:v for k,v in os.environ.items() if k.lower() not in ['http_proxy','https_proxy','all_proxy','no_proxy']}
    r=subprocess.run(['curl','-sS','--connect-timeout','8','--max-time','18','--proxy',proxy or '',
        '--noproxy','' if proxy else '*','-w','\n%{http_code}\n%{time_total}',url],env=env,capture_output=True,text=True)
    parts=r.stdout.rsplit('\n',2); body=parts[0].strip()
    try: observed=str(ipaddress.ip_address(body))
    except ValueError: observed=None
    return {'url':url,'curl_exit':r.returncode,'http_status':parts[1] if len(parts)==3 else None,
            'seconds':parts[2] if len(parts)==3 else None,'egress':observed,
            'passed':r.returncode==0 and len(parts)==3 and parts[1]=='200' and observed==expected,
            'error':r.stderr[:160] if r.returncode else None}

def verify(expected,proxy=None):
    ipaddress.IPv4Address(expected)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        checks=list(pool.map(lambda url:check(url,expected,proxy),SITES))
    return {'at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'expected_ipv4':expected,
        'mode':'explicit-proxy' if proxy else 'ordinary-traffic-no-explicit-proxy',
        'checks':checks,'passed':all(c['passed'] for c in checks),
        'direct_entry_verified':False,'scope':'Egress only. Verify physical ingress and runtime chains separately.'}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--expected-ip',required=True); p.add_argument('--report',required=True)
    g=p.add_mutually_exclusive_group(required=True); g.add_argument('--proxy'); g.add_argument('--tun',action='store_true'); a=p.parse_args()
    result=verify(a.expected_ip,a.proxy); report=Path(a.report); report.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    write_private(report,json.dumps(result,indent=2)+'\n'); print(json.dumps(result,indent=2)); raise SystemExit(0 if result['passed'] else 1)
