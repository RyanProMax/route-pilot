"""Bounded macOS physical-interface TCP timing and IPv6 ICMP echo sampling.

Run once/minute using launchd. Reads a mode-0600 JSON config with ipv6,
port, endpoint and token. Minute observations persist locally; closed 20-minute
summaries are uploaded at boundaries. Sleeping/offline periods stay missing.
"""
from concurrent.futures import ThreadPoolExecutor
import argparse
import errno
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time
import urllib.request

TIMEOUT = 5


def physical_interfaces(text):
    """scutil --nwi lists reachable interfaces by family; never select a TUN."""
    family = None
    result = {}
    for line in text.splitlines():
        if line.startswith('IPv4 network interface information'): family = 4
        elif line.startswith('IPv6 network interface information'): family = 6
        elif line.startswith('Network interfaces:'): family = None
        match = re.match(r'\s+(en\d+)\s+: flags', line)
        if match and family is not None:
            result.setdefault(family, match.group(1))
    return result


def discover():
    output = subprocess.check_output(['/usr/sbin/scutil', '--nwi'], text=True, timeout=3)
    return physical_interfaces(output)


def measure(address, interface):
    result = {'family': 6, 'outcome': 'unavailable', 'ms': None}
    if not interface or not address: return result
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
            sock.settimeout(TIMEOUT)
            sock.setsockopt(socket.IPPROTO_IPV6, 125, socket.if_nametoindex(interface))  # Darwin IPV6_BOUND_IF
            started = time.monotonic()
            sock.connect(address)
            elapsed = (time.monotonic() - started) * 1000
            if elapsed < TIMEOUT * 1000:
                result.update(outcome='ok', ms=round(elapsed, 3))
    except (TimeoutError, socket.timeout): result['outcome'] = 'timeout'
    except OSError as exc:
        if exc.errno == errno.ECONNREFUSED: result['outcome'] = 'failed'
        # Missing interface, no route, sandbox denial: no valid measurement.
    return result


def echo_counts(address, interface):
    """Read IPv6 echo counters on the physical interface, including zero replies."""
    if not address or not interface:
        return None
    try:
        ping = subprocess.run(
            ['/sbin/ping6', '-n', '-q', '-B', interface, '-c', '3', address],
            capture_output=True, text=True, timeout=16, env={**os.environ, 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired):
        return None
    counts = re.search(r'(\d+) packets transmitted, (\d+) packets received', ping.stdout)
    if ping.returncode not in (0, 2) or ping.stderr.strip() or not counts:
        return None
    sent, received = map(int, counts.groups())
    return {'sent': sent, 'received': received} if 0 < sent <= 3 and 0 <= received <= sent else None


def collect(config):
    started = time.monotonic()
    wall_started = time.time()
    interface = discover().get(6)
    target = config.get('ipv6')
    with ThreadPoolExecutor(max_workers=1) as pool:
        echo = pool.submit(echo_counts, target, interface)
        row = measure((target, config['port']) if target else None, interface)
        packets = echo.result()
    after = discover().get(6)
    # A wake/network switch during sampling must not become a misleading result.
    if time.monotonic() - started > 18 or time.time() - wall_started > 18 or interface != after:
        packets = None
        row = {'family': 6, 'outcome': 'unavailable', 'ms': None}
    return {'schema': 1, 'ts': int(time.time()), 'protocol': 'tcp-connect',
            'path': 'physical-interface', 'results': [row], **({'icmp6': packets} if packets else {})}


def load_config(path):
    info = path.stat()
    if stat.S_IMODE(info.st_mode) & 0o077 or info.st_uid != os.getuid():
        raise ValueError('Config must be owned by this user with mode 0600')
    c = json.loads(path.read_text())
    for family in (4, 6):
        if c.get(f'ipv{family}') and ipaddress.ip_address(c[f'ipv{family}']).version != family:
            raise ValueError('IP family mismatch')
    if type(c.get('port')) is not int or not 1 <= c['port'] <= 65535: raise ValueError('Invalid port')
    from urllib.parse import urlparse
    url = urlparse(c['endpoint'])
    if url.scheme != 'https' or url.path != '/private/mac-probe-ingest' or url.username or url.password or url.query or url.fragment:
        raise ValueError('Expected HTTPS probe endpoint')
    if 'aggregate_start' in c and (type(c['aggregate_start']) is not int or c['aggregate_start'] % 1200):
        raise ValueError('Invalid aggregation boundary')
    if not isinstance(c.get('token'), str) or not 32 <= len(c['token']) <= 200: raise ValueError('Invalid probe token')
    return c


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Probe endpoint must not redirect credentials')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin': raise ValueError('macOS only')
    config = load_config(args.config)
    report = collect(config)
    if args.dry_run:
        print(json.dumps(report)); return
    def send_request(body):
        request = urllib.request.Request(config['endpoint'], data=json.dumps(body).encode(),
                                    headers={'Authorization': 'Bearer '+config['token'], 'Content-Type': 'application/json', 'User-Agent': 'routepilot-mac-probe/1.0'})
        # HTTPS upload uses the normal proxy; it is outside the timed probe.
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            if response.status != 200: raise ValueError('Report rejected')
            result = json.load(response)
            if result.get('accepted') is not True: raise ValueError('Report rejected')
            return result
    start = config.get('aggregate_start')
    if start is None or report['ts'] < start:
        send_request(report)
    else:
        from routepilot_aggregate import record, link_check, pending
        aggregated = record(args.config.parent/'aggregate.sqlite3', start, report['ts'],
                            [link_check(report)], snapshot=report)
        if not aggregated['upload_due']:
            print('Mac TCP sample cached'); return
        base = {'schema':2,'ts':report['ts']}
        ack = send_request({**base,'ackOnly':True})
        cursor = ack.get('last_window')
        deadline = time.monotonic()+30
        for _ in range(4):
            if time.monotonic() >= deadline: break
            windows = pending(aggregated['windows'],cursor)
            if not windows: break
            result = send_request({**base,'windows':windows})
            received = result.get('last_window')
            if type(received) is not int or received < windows[-1]['start']:
                raise ValueError('Incomplete history acknowledgement')
            cursor = received
    print('Mac TCP summary submitted')


if __name__ == '__main__':
    try: main()
    except Exception as exc:
        # Do not log credential-bearing requests/configuration or home network addresses.
        print('Mac probe failed: '+type(exc).__name__, file=sys.stderr)
        sys.exit(1)
