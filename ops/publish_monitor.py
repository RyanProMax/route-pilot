"""Publish the public status page and provision the private reporter credential."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
from deployment import load_config, cloud_configs

ROOT = Path(__file__).resolve().parents[1]
STATE = Path.home() / ".local/share/routepilot/cloud"


def private_key(state, name):
    path = state / name
    try:
        with path.open("x") as file:
            file.write(secrets.token_urlsafe(36) + "\n")
    except FileExistsError:
        pass
    if path.stat().st_mode & 0o077:
        raise SystemExit(f"Restrict {path} to mode 0600")
    key = path.read_text().strip()
    if len(key) < 40:
        raise SystemExit(f"Invalid credential in {path}")
    return key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="Private deployment JSON (outside the repository)")
    parser.add_argument("--wrangler", default="wrangler", help="Wrangler 4 executable")
    parser.add_argument("--site-only", action="store_true", help="Deploy only the static frontend")
    parser.add_argument("--collector-only", action="store_true", help="Deploy only the collector and cached status API")
    args = parser.parse_args()
    if args.site_only and args.collector_only:
        parser.error("Choose at most one deployment target")
    wrangler = shutil.which(args.wrangler)
    if not wrangler:
        parser.error("Install Wrangler 4 and authenticate with the target Cloudflare account")
    os.umask(0o077)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not args.collector_only:
        subprocess.run(["npm", "--prefix", str(ROOT / "web"), "run", "build:status"], check=True)
    deployment = load_config(args.config)
    config, site = cloud_configs(deployment)
    state = Path(deployment.get("private_state_dir", Path.home()/".local/share/routepilot/instances"/deployment["instance"]["id"]))
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    environment = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": config["account_id"], "WRANGLER_SEND_METRICS": "false"}
    # Stage only deployable files. Bundler subprocesses need no access to personal folders.
    with tempfile.TemporaryDirectory(prefix="routepilot-edge-") as directory:
        stage = Path(directory)
        (stage / "cloud").mkdir()
        for name in ("wrangler.json", "worker.mjs", "status-site.json", "public-status.mjs", "status-cache.mjs"):
            shutil.copyfile(ROOT / "cloud" / name, stage / "cloud" / name)
        shutil.copytree(ROOT / "cloud/migrations", stage / "cloud/migrations")
        (stage/"cloud/wrangler.json").write_text(json.dumps(config))
        (stage/"cloud/status-site.json").write_text(json.dumps(site))
        def run(*args, config_file="wrangler.json", body=None, quiet=False):
            result = subprocess.run([wrangler, *args, "--config", "cloud/"+config_file], cwd=stage,
                                    env=environment, input=body, capture_output=quiet, text=True)
            if result.returncode:
                raise SystemExit("Wrangler operation failed: "+" ".join(args[:2]))
        if not args.site_only:
            token = private_key(state,"report-token").encode()
            digest = hashlib.sha256(token).hexdigest()
            route = hmac.new(token, b"routepilot-report-route-v1", hashlib.sha256).hexdigest()
            config["routes"].append({"pattern":deployment["status_hostname"]+"/i/"+route, "zone_name":deployment["zone"]})
            (stage/"cloud/wrangler.json").write_text(json.dumps(config))
            run("d1","migrations","apply",config["d1_databases"][0]["database_name"],"--remote")
            run("deploy", quiet=True)
            run("secret","bulk",body=json.dumps({"REPORT_SHA256":digest}))
        if not args.collector_only:
            dist = stage / "web/dist-status"
            shutil.copytree(ROOT / "web/dist-status", dist)
            shutil.copyfile(ROOT / "web/status/_headers", dist / "_headers")
            instance = deployment["instance"]
            (dist/"instances.json").write_text(json.dumps([{k:instance[k] for k in ("id","name","country")}], ensure_ascii=False))
            run("deploy", config_file="status-site.json")
    print("route-pilot published")


if __name__ == "__main__":
    main()
