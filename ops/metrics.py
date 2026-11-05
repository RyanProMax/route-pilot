#!/usr/bin/python3
"""Root-owned forced-command collector. No parameters; read-only output only."""
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess
import sys
import time

if len(sys.argv) != 1:
    raise SystemExit("Arguments are not accepted")

def run(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=5, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}).stdout.strip()

memory = {}
for line in open('/proc/meminfo'):
    fields = line.split()
    if fields[0] in ('MemTotal:', 'MemAvailable:'):
        memory[fields[0][:-1]] = int(fields[1])*1024
total = memory['MemTotal']
disk = shutil.disk_usage('/')
ssh = run('/usr/sbin/sshd', '-T')
ports = [int(x) for x in re.findall(r'^port (\d+)$', ssh, re.M)]
f2b = run('/usr/bin/fail2ban-client', 'status', 'sshd')
banned = re.search(r'Currently banned:\s*(\d+)', f2b)
config = {}
for line in ssh.splitlines():
    parts = line.split(None, 1)
    if len(parts) == 2 and parts[0] in ('permitrootlogin','passwordauthentication','kbdinteractiveauthentication','pubkeyauthentication'):
        config[parts[0]] = parts[1]
services = {name: run('/usr/bin/systemctl', 'is-active', name) for name in ('xray', 'fixed-ip-vpn', 'ssh', 'fail2ban')}
proxy_service = 'fixed-ip-vpn' if services['fixed-ip-vpn']=='active' else 'xray'
services['proxy'] = services[proxy_service]
listeners = run('/usr/bin/ss', '-H', '-lnt')
public_ports = set()
for line in listeners.splitlines():
    fields = line.split()
    if len(fields) < 4: continue
    address = fields[3]
    if address.startswith(('127.', '[::1]:')): continue
    try: public_ports.add(int(address.rsplit(':', 1)[1]))
    except ValueError: pass
legacy = {}
for package in ('wireguard', 'wireguard-tools', 'tinyproxy', 'tinyproxy-bin', 'shadowsocks-libev'):
    legacy[package] = run('/usr/bin/dpkg-query', '-W', '-f=${db:Status-Status}', package) == 'installed'
ufw_active = run('/usr/sbin/ufw', 'status').startswith('Status: active')
restarts = run('/usr/bin/systemctl', 'show', proxy_service, '--property=NRestarts', '--value')
restricted = False
try:
    account=pwd.getpwnam('routepilot-monitor')
    home=pathlib.Path(account.pw_dir)
    auth=home/'.ssh/authorized_keys'
    helper=pathlib.Path('/usr/local/libexec/routepilot-metrics')
    sudoers=pathlib.Path('/etc/sudoers.d/routepilot-monitor')
    paths=[home,auth.parent,auth,helper,sudoers]
    owned=all(p.stat().st_uid==0 and not p.stat().st_mode&0o022 for p in paths)
    keys=[line for line in auth.read_text().splitlines() if line.strip() and not line.startswith('#')]
    fixed='restrict,command="/usr/bin/sudo -n /usr/local/libexec/routepilot-metrics" ssh-ed25519 '
    restricted=owned and bool(keys) and all(line.startswith(fixed) for line in keys) and sudoers.read_text().strip()=='routepilot-monitor ALL=(root) NOPASSWD: /usr/local/libexec/routepilot-metrics ""' and set(os.getgrouplist(account.pw_name,account.pw_gid))=={account.pw_gid}
except (KeyError,OSError): pass
out = {'schema': 1, 'sampled_at': time.time(), 'hostname': os.uname().nodename,
       'load1': os.getloadavg()[0], 'cpu_count': os.cpu_count(),
       'memory_total': total, 'memory_used': total-memory['MemAvailable'],
       'disk_total': disk.total, 'disk_used': disk.used, 'uptime_seconds': float(open('/proc/uptime').read().split()[0]),
       'services': services, 'proxy_service': proxy_service, 'xray_restarts': int(restarts or 0),
       'security': {'ssh_ports': ports, **config, 'fail2ban_active': services['fail2ban']=='active', 'sshd_jail_active': 'Status for the jail: sshd' in f2b, 'banned_count': int(banned[1]) if banned else None,
                    'public_tcp_ports': sorted(public_ports), 'legacy_packages': legacy, 'ufw_active': ufw_active, 'monitor_restricted': restricted}}
print(json.dumps(out, separators=(',', ':')))
