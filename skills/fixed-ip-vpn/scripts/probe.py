#!/usr/bin/env python3
"""Bound TCP reachability probe. Never labels a TCP success as a VPN success."""
import argparse, concurrent.futures, ipaddress, json, platform, socket, time
from pathlib import Path

def probe(host,port,interface,timeout=4):
    ip=ipaddress.ip_address(host); family=socket.AF_INET6 if ip.version==6 else socket.AF_INET
    start=time.monotonic()
    result={'target':host,'port':port,'interface':interface,'family':ip.version,'tcp_connected':False}
    try:
        with socket.socket(family,socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            if interface:
                index=socket.if_nametoindex(interface)
                if platform.system()=='Darwin':
                    # Darwin SDK netinet/in.h: IP_BOUND_IF=25, IPV6_BOUND_IF=125.
                    s.setsockopt(socket.IPPROTO_IPV6 if ip.version==6 else socket.IPPROTO_IP,125 if ip.version==6 else 25,index)
                elif platform.system()=='Linux': s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,interface.encode()+b'\0')
                else: raise OSError('Physical-interface binding unsupported on this OS')
            s.connect((host,port)); result['tcp_connected']=True
    except OSError as e: result['error']=str(e)
    result['seconds']=round(time.monotonic()-start,3)
    result['scope']='physical interface bound; TCP only' if interface else 'route-dependent TCP only; may traverse TUN'
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--inventory',required=True); p.add_argument('--interface'); p.add_argument('--port',type=int); a=p.parse_args()
    i=json.loads(Path(a.inventory).read_text()); jobs=[i[k] for k in ['server_ipv4','server_ipv6'] if i.get(k)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        results=list(ex.map(lambda h:probe(h,a.port or i.get('port',443),a.interface),jobs))
    print(json.dumps({'checks':results,'vpn_verified':False},indent=2))
    raise SystemExit(0 if any(r['tcp_connected'] for r in results) else 1)
