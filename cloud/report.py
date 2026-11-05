#!/usr/bin/python3
"""Send the root-owned snapshot via IPv4 HTTPS. The credential stays out of argv."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

snapshot = Path("/var/lib/routepilot/snapshot/latest.json")
header = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "auth-header"
token = header.read_text().strip().removeprefix("Authorization: Bearer ")
route = hmac.new(token.encode(), b"routepilot-report-route-v1", hashlib.sha256).hexdigest()
settings = json.loads((Path(os.environ["CREDENTIALS_DIRECTORY"])/"config.json").read_text())
base = settings["base_url"].rstrip("/")
parsed = urlsplit(base)
if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.query or parsed.fragment or parsed.path:
    raise SystemExit("Invalid reporting base URL")
url_option = 'url = "' + base + '/i/' + route + '"'
for attempt in range(2):
    result = subprocess.run(["/usr/bin/curl", "--disable", "--ipv4", "--noproxy", "*",
        "--proto", "=https", "--silent", "--fail", "--connect-timeout", "4", "--max-time", "9",
        "--header", "@"+str(header), "--header", "Content-Type: application/json", "--data-binary", "@"+str(snapshot),
        "--config", "-"], input=url_option.encode(), capture_output=True, timeout=12)
    if result.returncode == 0 and json.loads(result.stdout).get("accepted") is True:
        break
    if attempt == 0:
        time.sleep(2)
else:
    raise SystemExit("route-pilot HTTPS report failed")
