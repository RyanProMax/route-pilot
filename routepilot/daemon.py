"""Local-only route-pilot API, sampler and Gatus bridge."""
import argparse
import concurrent.futures
import fcntl
import functools
import ipaddress
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from . import __version__
from .probes import IsolatedClient, clean_env, host_metrics, http, local_network, tcp
from .store import Store

CHECKS = [
    {"id":"observer", "name":"Mac 观测端", "description":"物理接口与采集心跳", "required":True},
    {"id":"host", "name":"东京 VPS", "description":"只读 SSH · 主机与 Xray", "required":True},
    {"id":"ipv6", "name":"IPv6 直连入口", "description":"物理接口绑定 · TCP", "required":True},
    {"id":"tunnel", "name":"VLESS 端到端", "description":"隔离客户端 · REALITY · HTTPS", "required":True},
    {"id":"egress", "name":"固定 IPv4 出口", "description":"两个独立查询站交叉验证", "required":True},
    {"id":"daily", "name":"Clash 日常代理", "description":"现有本地代理 · 出口校验", "required":True},
    {"id":"ipv4", "name":"IPv4 备用入口", "description":"旁路观测 · 不计入主路径状态", "required":False},
]
WINDOWS = {"24h":86400, "7d":604800, "30d":2592000}


class Monitor:
    def __init__(self, config, state):
        self.config, self.state = config, Path(state)
        self.store = Store(self.state/"observations.db", config["interval"])
        self.client = IsolatedClient(config, self.state)
        self.stop_event = threading.Event()
        self.gatus = None
        self.gatus_log = None
        self.local_http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def start_gatus(self):
        if self.gatus and self.gatus.poll() is None:
            return
        if self.gatus_log:
            self.gatus_log.close()
        binary = self.state/"bin/gatus"
        if not binary.is_file():
            self.store.meta("engine", {"status":"unknown", "message":"Gatus 二进制未安装"})
            return
        try:
            with socket.socket() as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1",self.config["gatus_port"]))
            env = clean_env()
            env["GATUS_CONFIG_PATH"] = str(self.state/"gatus.yaml")
            self.gatus_log = (self.state/"gatus.log").open("w")
            self.gatus = subprocess.Popen([str(binary)], cwd=self.state, env=env, stdout=self.gatus_log, stderr=self.gatus_log)
        except OSError:
            logging.exception("Gatus could not start")
            self.store.meta("engine", {"status":"unknown", "message":"Gatus 启动失败，请检查本地日志"})

    def bridge(self, check_id, result):
        if result[0] == "unknown":
            return
        params = {"success":str(result[0] in {"ok","degraded"}).lower(), "duration":str(int(result[2] or 0))+"ms"}
        if result[0] == "down":
            params["error"] = result[1].get("message", "Probe failed")
        url = f'http://127.0.0.1:{self.config["gatus_port"]}/api/v1/endpoints/routepilot_{check_id}/external?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, data=b"", method="POST", headers={"Authorization":"Bearer " + self.config["gatus_token"]})
        try:
            with self.local_http.open(req, timeout=3) as response:
                if response.status != 200:
                    raise OSError("Push rejected")
            self.store.meta("engine", {"status":"ok", "message":"Gatus 已接收真实探测结果", "last_push":time.time(), "version":"5.38.0"})
        except Exception:
            self.store.meta("engine", {"status":"unknown", "message":"Gatus 推送暂不可用，本地历史仍在记录"})

    def record(self, check_id, result):
        self.store.add(check_id, *result)
        self.bridge(check_id,result)

    def cycle(self):
        self.start_gatus()
        connected, detail = local_network(self.config["interface"])
        self.record("observer", ("ok" if connected else "unknown",detail,None))
        if not connected:
            for c in CHECKS[1:]:
                self.record(c["id"], ("unknown", {"message":"本地网络不可用，暂停目标判定"}, None))
            return
        proxy = f'http://127.0.0.1:{self.config["probe_port"]}'
        expected = self.config["expected_ipv4"]
        jobs = {
            "ipv6":lambda:tcp(self.config["ipv6"],self.config["proxy_port"],self.config["interface"]),
            "ipv4":lambda:tcp(self.config["ipv4"],self.config["proxy_port"],self.config["interface"]),
            "host":lambda:host_metrics(self.config),
            "daily":lambda:http("https://api.ipify.org", self.config["daily_proxy"], expected),
        }
        try:
            self.client.start()
            jobs.update({"ip1":lambda:http("https://api.ipify.org",proxy,expected), "ip2":lambda:http("https://ifconfig.me/ip",proxy,expected)})
        except Exception as e:
            logging.error("Isolated client unavailable: %s",type(e).__name__)
            self.record("tunnel", ("unknown", {"message":"隔离探针不可用；未借用其他代理", "reason":str(e)[:100]}, None))
            self.record("egress", ("unknown", {"message":"探针不可用，无法核验出口"}, None))
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            futures = {key:pool.submit(fn) for key,fn in jobs.items()}
            results = {}
            for key, future in futures.items():
                try:
                    results[key] = future.result()
                except Exception:
                    logging.exception("Probe failed: %s",key)
                    results[key] = ("unknown", {"message":"探针内部错误，等待下一次检查"}, None)
                if key not in {"ip1","ip2"}:
                    self.record(key, results[key])
        if "ip1" in results:
            endpoints = [results["ip1"],results["ip2"]]
            matched = [r for r in endpoints if r[1].get("egress") == expected]
            mismatch = [r for r in endpoints if r[1].get("egress") and r[1]["egress"] != expected]
            if mismatch:
                result = ("down", {"message":"检测到出口不符", "expected":expected, "targets":[r[1] for r in endpoints]}, mismatch[0][2])
            elif len(matched) == 2:
                result = ("ok", {"message":"两个站点均确认固定出口", "egress":expected,"targets":[r[1] for r in endpoints]},max(r[2] for r in matched))
            elif matched:
                result = ("degraded", {"message":"单站确认出口，另一查询站暂不可用", "egress":expected,"targets":[r[1] for r in endpoints]},matched[0][2])
            else:
                result = ("unknown", {"message":"出口暂未得到确认", "targets":[r[1] for r in endpoints]},None)
            self.record("egress", result)
            reachable = [r for r in endpoints if r[1].get("http_status") == 200]
            if reachable:
                latency = min(r[2] for r in reachable)
                self.record("tunnel", ("degraded" if latency>5000 else "ok", {"message":"已通过独立 VLESS 客户端完成 HTTPS 请求", "interface":self.config["interface"],"entry_family":"IPv6","chain_proxy":False},latency))
            else:
                self.record("tunnel", ("down", {"message":"端到端请求失败", "reason":"两个目标均未返回有效成功响应；需结合入口状态定位", "targets":[r[1] for r in endpoints]},None))

    def run(self):
        while not self.stop_event.is_set():
            began = time.monotonic()
            try:
                self.store.meta("cycle_started",time.time())
                self.cycle()
                self.store.meta("cycle_finished",time.time())
                self.store.prune()
            except Exception:
                logging.exception("Sampling cycle failed")
            self.stop_event.wait(max(1,self.config["interval"]-(time.monotonic()-began)))

    def summary(self, window):
        now=time.time()
        checks=[{**c, **self.store.summarize(c["id"],window,now)} for c in CHECKS]
        primary=[c["status"] for c in checks if c["required"]]
        overall="down" if "down" in primary else "unknown" if "unknown" in primary else "degraded" if "degraded" in primary else "ok"
        metrics=next(c for c in checks if c["id"]=="host")
        return {"product":"route-pilot", "version":__version__, "now":now,"status":overall,"interval":self.config["interval"],
                "node":{"name":"Tokyo VPS", "region":"Tokyo, JP", "ipv4":self.config["ipv4"],"ipv6":self.config["ipv6"],"expected_egress":self.config["expected_ipv4"],"proxy_port":self.config["proxy_port"],"ssh_port":self.config["ssh"]["port"]},
                "observer":{"name":"Mac Mini", "interface":self.config["interface"],"scope":"当前 Mac 网络；不代表手机 5G", "last_cycle":self.store.meta("cycle_finished")},
                "checks":checks, "events":self.store.events(now-window), "metrics":metrics["detail"].get("metrics"), "metrics_stale":metrics["stale"] or metrics["status"]=="unknown",
                "engine":self.store.meta("engine"), "deployment":self.store.meta("deployment")}

    def stop(self):
        self.stop_event.set()
        self.client.stop()
        if self.gatus and self.gatus.poll() is None:
            self.gatus.terminate()
            try:self.gatus.wait(timeout=5)
            except subprocess.TimeoutExpired:self.gatus.kill();self.gatus.wait(timeout=5)
        if self.gatus_log:self.gatus_log.close()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,monitor=None,**kwargs):
        self.monitor=monitor
        super().__init__(*args,**kwargs)

    def end_headers(self):
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("Referrer-Policy","no-referrer")
        self.send_header("X-Frame-Options","DENY")
        self.send_header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        super().end_headers()

    def log_message(self,*args):
        return

    def json(self,value,status=200):
        body=json.dumps(value,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        port=self.server.server_port
        if self.headers.get("Host","") not in {f"127.0.0.1:{port}",f"localhost:{port}"}:
            return self.json({"error":"Host rejected"},403)
        origin=self.headers.get("Origin")
        if origin and origin not in {f"http://127.0.0.1:{port}",f"http://localhost:{port}"}:
            return self.json({"error":"Origin rejected"},403)
        parsed=urllib.parse.urlsplit(self.path)
        if parsed.path=="/api/summary":
            window=urllib.parse.parse_qs(parsed.query).get("window",["24h"])[0]
            if window not in WINDOWS:return self.json({"error":"Invalid window"},400)
            return self.json(self.monitor.summary(WINDOWS[window]))
        if parsed.path=="/health":
            last=self.monitor.store.meta("cycle_finished")
            fresh=last is not None and time.time()-last<self.monitor.config["interval"]*2.5
            return self.json({"status":"ok" if fresh else "unknown","last_cycle":last},200 if fresh else 503)
        if parsed.path.startswith("/api/"):return self.json({"error":"Not found"},404)
        path=Path(self.translate_path(parsed.path)).resolve()
        root=Path(self.directory).resolve()
        if not path.is_relative_to(root) or path.is_symlink():return self.json({"error":"Not found"},404)
        if path.is_dir() and not (path/"index.html").is_file():return self.json({"error":"Not found"},404)
        return super().do_GET()


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--state",type=Path,default=Path.home()/".local/share/routepilot")
    p.add_argument("--web",type=Path,default=Path(__file__).resolve().parents[1]/"web/dist")
    p.add_argument("--once",action="store_true")
    args=p.parse_args()
    os.umask(0o077)
    args.state.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=(args.state/"daemon.lock").open("a")
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit("route-pilot is already running")
    logging.basicConfig(level=logging.INFO,handlers=[RotatingFileHandler(args.state/"routepilot.log",maxBytes=2_000_000,backupCount=2)],format="%(asctime)s %(levelname)s %(message)s")
    cfg=json.loads((args.state/"config.json").read_text())
    monitor=Monitor(cfg,args.state)
    if args.once:
        try:monitor.cycle();monitor.store.meta("cycle_finished",time.time());print(json.dumps({c["id"]:c["status"] for c in monitor.summary(86400)["checks"]}))
        finally:monitor.stop()
        return
    handler=functools.partial(Handler,directory=str(args.web),monitor=monitor)
    server=ThreadingHTTPServer(("127.0.0.1",cfg["web_port"]),handler)
    server.daemon_threads=True
    worker=threading.Thread(target=monitor.run,name="sampler",daemon=True)
    worker.start()
    def shutdown(*_):
        monitor.stop_event.set()
        threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,shutdown)
    signal.signal(signal.SIGINT,shutdown)
    try:server.serve_forever()
    finally:
        worker.join(timeout=35)
        monitor.stop()
        server.server_close()


if __name__=="__main__":main()
