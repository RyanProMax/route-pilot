"""Install only route-pilot-owned files over an existing trusted SSH alias."""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
from deployment import load_config

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--config")
parser.add_argument("--ssh-host", required=True)
parser.add_argument("--token-file", type=Path, required=True)
args = parser.parse_args()
deployment = load_config(args.config)
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.ssh_host):
    parser.error("Invalid SSH alias")
if args.token_file.stat().st_mode & 0o077:
    parser.error("Token file must be private")
token = args.token_file.read_text().strip()
if not re.fullmatch(r"[A-Za-z0-9_-]{40,100}",token):
    parser.error("Invalid report credential")
files = {
    "/usr/local/libexec/routepilot_accounting.py": ((ROOT/"cloud/routepilot_accounting.py").read_bytes(), 0o644),
    "/usr/local/libexec/routepilot_devices.py": ((ROOT/"cloud/routepilot_devices.py").read_bytes(), 0o644),
    "/etc/routepilot-report/config.json": (json.dumps({"base_url":"https://"+deployment["status_hostname"],"proxy_port":deployment["instance"]["port"],"stats_port":deployment.get("stats_port",10085),"xray_service":deployment.get("xray_service","xray")}).encode(), 0o600),
    "/usr/local/libexec/routepilot-metrics": ((ROOT/"ops/metrics.py").read_bytes(), 0o755),
    "/usr/local/libexec/routepilot-snapshot": ((ROOT/"cloud/snapshot.py").read_bytes(), 0o755),
    "/usr/local/libexec/routepilot_traffic.py": ((ROOT/"cloud/routepilot_traffic.py").read_bytes(), 0o644),
    "/usr/local/libexec/routepilot-report": ((ROOT/"cloud/report.py").read_bytes(), 0o755),
    "/etc/systemd/system/routepilot-report.service": ((ROOT/"cloud/routepilot-report.service").read_bytes(), 0o644),
    "/etc/systemd/system/routepilot-report.timer": ((ROOT/"cloud/routepilot-report.timer").read_bytes(), 0o644),
    "/etc/routepilot-report/auth-header": (("Authorization: Bearer "+token+"\n").encode(), 0o600)
}
payload = {key:[base64.b64encode(data).decode(), mode] for key,(data,mode) in files.items()}
installer = r"""
import base64,os,json,pwd,pathlib,subprocess,sys,tempfile,shutil,time
os.umask(0o077)
try:
    user=pwd.getpwnam('routepilot-report')
    if not user.pw_uid or user.pw_shell!='/usr/sbin/nologin':raise SystemExit('Existing account does not match reporter')
except KeyError:
    subprocess.run(['useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin','routepilot-report'],check=True)
    user=pwd.getpwnam('routepilot-report')
private=pathlib.Path('/var/lib/routepilot/snapshot')
private.mkdir(parents=True,exist_ok=True)
private.parent.chmod(0o711)
os.chown(private,0,user.pw_gid);private.chmod(0o750)
secrets=pathlib.Path('/etc/routepilot-report')
secrets.mkdir(exist_ok=True,mode=0o700)
backup=pathlib.Path('/var/lib/routepilot/backups')/('reporter-'+str(time.time_ns()))
backup.mkdir(parents=True,mode=0o700)
for name,(data,mode) in files.items():
    path=pathlib.Path(name)
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():shutil.copy2(path,backup/path.name)
    with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as f:
        f.write(base64.b64decode(data));os.fchmod(f.fileno(),mode)
    os.replace(f.name,path)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','start','routepilot-report.service'],check=True)
subprocess.run(['systemctl','enable','--now','routepilot-report.timer'],check=True)
"""
subprocess.run(["ssh","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes",args.ssh_host,"sudo -n python3 -"],
               input="files="+repr(payload)+"\n"+installer,text=True,check=True,timeout=90)
