"""Bound physical probes, isolated VLESS client, restricted SSH telemetry."""
import concurrent.futures
import ipaddress
import json
import os
import platform
import re
import socket
import subprocess
import time
from pathlib import Path


def clean_env():
    return {k: v for k, v in os.environ.items() if k.lower() not in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}}


def tcp(host, port, interface, timeout=5):
    family = socket.AF_INET6 if ipaddress.ip_address(host).version == 6 else socket.AF_INET
    started = time.monotonic()
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            index = socket.if_nametoindex(interface)
            if platform.system() == "Darwin":
                s.setsockopt(socket.IPPROTO_IPV6 if family == socket.AF_INET6 else socket.IPPROTO_IP, 125 if family == socket.AF_INET6 else 25, index)
            elif platform.system() == "Linux":
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, interface.encode() + b"\0")
            else:
                raise OSError("Interface binding unsupported")
            s.connect((host, port))
        return "ok", {"message": "物理接口 TCP 连接成功", "interface": interface, "port": port, "target": host}, round((time.monotonic()-started)*1000)
    except OSError as e:
        return "down", {"message": "入口连接失败", "reason": str(e)[:160], "interface": interface, "port": port}, None


def local_network(interface):
    try:
        socket.if_nametoindex(interface)
        if platform.system() == "Darwin":
            out = subprocess.run(["/sbin/ifconfig", interface], capture_output=True, text=True, timeout=5, check=True).stdout
            addresses = re.findall(r"inet6 ([^ %\n]+)", out)
            global_v6 = any(ipaddress.ip_address(a).is_global for a in addresses)
            active = "status: active" in out or ("RUNNING" in out and "status:" not in out)
        else:
            data = json.loads(subprocess.run(["ip", "-j", "addr", "show", "dev", interface], capture_output=True, text=True, timeout=5, check=True).stdout)
            active = data[0].get("operstate") == "UP"
            global_v6 = any(a["family"] == "inet6" and a["scope"] == "global" for a in data[0]["addr_info"])
        return active and global_v6, {"message": "物理接口具备公网 IPv6" if active and global_v6 else "本地接口离线或缺少公网 IPv6", "interface": interface, "global_ipv6": global_v6}
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        return False, {"message": "无法读取本地网络状态", "reason": str(e)[:160], "interface": interface}


def http(url, proxy, expected=None):
    started = time.monotonic()
    command = ["/usr/bin/curl", "--silent", "--show-error", "--fail", "--connect-timeout", "8", "--max-time", "18", "--max-filesize", "4096" if expected else "1048576", "--noproxy", "", "--proxy", proxy, "--write-out", "\n%{http_code}", url]
    try:
        result = subprocess.run(command, env=clean_env(), capture_output=True, text=True, timeout=20)
        elapsed = round((time.monotonic()-started)*1000)
        if result.returncode:
            return "down", {"message": "代理请求失败", "curl_code": result.returncode, "reason": result.stderr.strip()[:180]}, None
        body, code = result.stdout.strip().rsplit("\n", 1)
        detail = {"message": "请求成功", "http_status": int(code), "target": url}
        if expected:
            try:
                actual = str(ipaddress.ip_address(body.strip()))
            except ValueError:
                return "unknown", {"message": "出口查询响应不是有效 IP", "target": url}, None
            detail.update({"egress": actual, "expected": expected, "message": "固定出口匹配" if actual == expected else "出口与预期不符"})
            if actual != expected:
                return "down", detail, elapsed
        return ("degraded" if elapsed > 5000 else "ok"), detail, elapsed
    except (ValueError, subprocess.SubprocessError, OSError) as e:
        return "down", {"message": "代理请求未完成", "reason": str(e)[:160]}, None


def host_metrics(config):
    ssh = config["ssh"]
    command = ["/usr/bin/ssh", "-F", "/dev/null", "-6", "-B", config["interface"], "-p", str(ssh["port"]), "-i", ssh["monitor_key"], "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", "-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "UserKnownHostsFile=" + ssh["known_hosts"], ssh["monitor_user"] + "@" + config["ipv6"]]
    started = time.monotonic()
    try:
        p = subprocess.run(command, capture_output=True, text=True, timeout=18, env=clean_env())
        if p.returncode:
            return "unknown", {"message": "VPS 采集不可达，尚不能断言主机宕机", "reason": p.stderr.strip()[-180:]}, None
        data = json.loads(p.stdout)
        if data.get("schema") != 1:
            raise ValueError("Unsupported telemetry schema")
        services = data.get("services", {})
        good = services.get("proxy", services.get("fixed-ip-vpn", services.get("xray"))) == "active"
        return "ok" if good else "down", {"message": "VPS 与 Xray 正常" if good else "Xray 服务异常", "metrics": data}, round((time.monotonic()-started)*1000)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        return "unknown", {"message": "VPS 采集不可用", "reason": str(e)[:160]}, None


class IsolatedClient:
    def __init__(self, config, state):
        self.config, self.state = config, Path(state)
        self.process = None
        self.log = None

    def start(self):
        if self.process and self.process.poll() is None:
            return
        if self.log:
            self.log.close()
        port = self.config["probe_port"]
        # Fail closed on conflicts; never probe an unrelated listener.
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", port))
        cfg = json.loads((self.state / "mihomo.json").read_text())
        assert cfg.get("interface-name") == self.config["interface"]
        assert cfg.get("bind-address") == "127.0.0.1" and cfg.get("tun", {}).get("enable") is False
        assert len(cfg["proxies"]) == 1 and cfg["proxies"][0]["server"] == self.config["ipv6"]
        assert not any(k in cfg["proxies"][0] for k in ("dialer-proxy", "underlying-proxy"))
        assert not cfg.get("proxy-providers") and cfg["rules"] == ["MATCH,DIRECT-NODE"]
        client_dir = self.state / "mihomo"
        client_dir.mkdir(mode=0o700, exist_ok=True)
        self.log = (self.state / "mihomo.log").open("w")
        self.process = subprocess.Popen([self.config["mihomo_binary"], "-d", str(client_dir), "-f", str(self.state / "mihomo.json")], stdout=self.log, stderr=self.log, env=clean_env())
        for _ in range(50):
            if self.process.poll() is not None:
                raise RuntimeError("隔离代理进程退出")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=.1):
                    return
            except OSError:
                time.sleep(.1)
        self.stop()
        raise RuntimeError("隔离代理未就绪")

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log:
            self.log.close()
