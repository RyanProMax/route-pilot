---
name: fixed-ip-vpn
description: Deploy or repair fixed IPv4 egress on an existing Linux VPS, diagnose IPv4/IPv6 reachability, and generate, register, import, and verify standalone per-device Clash Verge and Shadowrocket profiles. Use for self-hosted direct VPN and API IP allowlist connectivity; not trading or purchasing servers.
---

# route-pilot · 固定 IP VPN

将已有 VPS 变成固定 IPv4 出口，程序仍运行在本机。默认 VLESS + REALITY；先确定可达路径，再部署和导入。IPv6 入口和 IPv4 出口可以属于同一台服务器。

用户说“一键部署”时，执行整个技能流程，而不是只输出命令。这是由 Codex 编排的部署，不是保证任何网络都能直连的安装器。

此技能随 route-pilot 项目维护；监控安装与运行参见项目根目录 README.md。

## 输入与边界

从已授权的 SSH 配置、交接记录和现有配置取得目标、用户、密钥路径、固定 IPv4、可选 IPv6、端口、客户端版本。缺少必要目标或权限才询问。参考 [inventory.example.json](references/inventory.example.json)；运行数据放在用户私有工作目录，不能写回技能目录。

- 独立配置；不向机场订阅注入节点、规则或脚本。直连任务不自动添加机场、购买中转或改用共享出口。
- 不在技能、聊天、命令行参数或普通日志中保存 UUID、REALITY 私钥、SSH 私钥和 API Secret。输出文件 600、目录 700；重复执行重用凭据，不自动轮换。
- 只有本机修改获准时，共享 WAN/LAN、RA/DHCPv6、DNS 和路由器重启均不在范围内。
- 部署不涉及交易账户操作；公开探活与签名权限验收分开。只有用户另行授权才做后者。
- 技能本身不是对未来服务器的操作授权。目标明确且部署已获授权时，备份、验证、应用和回滚属于同一任务，不重复索要确认。

## 执行路径

1. **盘点和诊断。** 读取 [diagnostics.md](references/diagnostics.md)。查版本、端口占用、云/系统防火墙、地址和路由，用 `scripts/probe.py` 绑定物理接口测试。已有代理下的 curl 成功不能证明直连。两种 IP 家族都不可达时停止协议轮换，报告证据和缺少的条件。
2. **部署服务。** 读取 [server.md](references/server.md)。核对出口 IPv4 直接分配给该服务器，确认版本支持，再安装官方 Xray。用 `scripts/render.py` 生成配置，语法测试后用 `scripts/apply_server.py` 事务式应用。不要覆盖未知的已有 Xray 服务。
3. **分流与安全。** 读取 [routing.md](references/routing.md) 处理国内直连、固定出口优先与 DNS；读取 [security.md](references/security.md) 处理 SSH 端口、fail2ban、只读监控和确认闲置后的软件清理。已完成的安全改造只核验，不重复覆盖。
4. **设备与客户端。** 读取 [devices.md](references/devices.md) 和 [clients.md](references/clients.md)。由 Agent 经已验证 SSH 按用户需要分配独立或共享凭据，交付私有原生配置并完成可操作客户端的导入；需要 URL 订阅时按 [subscriptions.md](references/subscriptions.md) 发布 CF 加密副本；不向 VPS 增加 HTTP 服务或隧道。重复执行同一活动凭据名称复用 UUID，跨客户端格式也可共用，Agent 更新副本后客户端刷新订阅。迁移完成前保留旧凭据，手机不可操作时保留待验收标记。
5. **验收。** 用 `scripts/verify.py` 检查两个出口站。分别记录隔离物理接口、Clash 日常 TUN、显式代理、手机实机状态。只把实际通过的项目标记完成。
6. **交付。** 返回启用的配置、入口家族、实测出口、私有设备配置位置、验收及回滚记录。节点凭据不进入聊天或公开文档。清理本次临时监听、防火墙规则和测试进程，不清除其他服务。

## 工具

```sh
python3 scripts/render.py --inventory /private/work/inventory.json --out /private/work/bundle
python3 scripts/probe.py --inventory /private/work/inventory.json --interface en1
python3 scripts/verify.py --expected-ip 203.0.113.10 --proxy socks5h://127.0.0.1:1088 --report /private/work/proxy-check.json
python3 scripts/verify.py --expected-ip 203.0.113.10 --tun --report /private/work/tun-check.json
```

文档地址必须替换。生成器使用 Python 标准库和支持 X25519 的 OpenSSL；`.yaml` 输出采用 JSON 语法（合法 YAML），Mihomo 可直接读取。服务应用脚本只管理独立 `fixed-ip-vpn.service`，有计划、备份及回滚；二进制安装、云设置和客户端 UI 由技能流程按实际环境完成。

## 监控与公开仓库

用户要求完整 route-pilot 部署时，使用项目 `examples/deploy.example.json` 创建仓库外的私有配置，执行 `ops/publish_monitor.py` 和 `ops/install_reporter.py`；数据库迁移先于读取新字段的代码。VPS 自检与 Cloudflare 外部探测独立于 Mac。公开版本只保存模板，密钥、实际账号/主机标识、数据库和私有配置留在运行目录。

## 必须保留的经验

- 分别验证入口真正直连、外网出口固定、实际使用配置已切换。
- 固定 IPv4 需要服务端绑定 IPv4、强制 IPv4 解析，并阻止字面 IPv6 目的地址绕过约束。客户端 IPv6 与出口地址是两回事。
- Clash Verge 2.5.8 首页过滤 `fallback`；用 `url-test` 或 `select` 并验证首页。首页空白不等于内核断线。
- 语法通过、端口可连接、二维码生成都不等于端到端验收。保留失败阶段和原因。

## 维护

参考文档包含已知实测组合及官方来源。部署其他版本前复查字段，不把某次网络失败写成永久结论。

运行 `python3 scripts/test_workflow.py`，可加 `--mihomo /path/to/mihomo --xray /path/to/xray` 做真实内核语法验证，不连接生产 VPS。服务事务测试使用临时目录和模拟 systemd，不冒充真实 Linux 实机部署。
