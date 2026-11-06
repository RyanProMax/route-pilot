# route-pilot

自建固定 IPv4 出口，从 VPS 部署、安全加固到客户端配置与状态监控。

- **部署 Skill**：由 Agent 编排 VLESS / REALITY 部署、IPv4 / IPv6 直连诊断、SSH 端口迁移、fail2ban 和回滚。
- **私有订阅**：Clash Verge、Shadowrocket 通过 HTTPS 更新配置；独立随机令牌、加密存储、按凭证撤销。
- **独立监控**：VPS 每分钟自检上报，Cloudflare 外部探测，D1 保存历史，无需 Mac 常驻。
- **状态页**：React + TypeScript + Ant Design，支持 PWA、多实例切换、流量余额及 24 小时 / 7 天 / 30 天记录。
- **管理后台**：Google 登录、主机负载、凭证创建/撤销、订阅地址重置、月度用量和操作记录。公开首页与后台共用一个前端项目。

```text
Agent + Skill ── SSH ── VPS ── 固定 IPv4 出口
                    └─ 加密配置 ── CF 私有订阅 ── Clash Verge / Shadowrocket

VPS 自检 + Cloudflare 探测 ── Worker + D1 ── 缓存 API ── 公开状态页
管理员后台 ── 私有任务队列 ── VPS 定时领取并执行
```

## 开始使用

需要 Ubuntu 24.04 VPS、密钥 SSH、Python 3.11+、Node.js 24+，以及 Cloudflare 域名、Workers / D1 和已登录的 Wrangler 4。

```sh
git clone https://github.com/RyanProMax/route-pilot.git
cd route-pilot
npm --prefix cloud ci --ignore-scripts
npm --prefix web ci --include=optional
```

让 Agent 读取 [部署 Skill](skills/fixed-ip-vpn/SKILL.md)，提供已授权的 VPS 和目标出口。部署参数使用 [示例配置](examples/deploy.example.json)，真实配置、密钥与导出文件放在仓库外。监控发布和客户端交付命令见 [部署文档](docs/deployment.md)。

公开页面仅展示聚合状态，不含节点凭证、客户端 IP 或设备名称。Cloudflare 探测代表其所在网络的连通性；直连仍需在实际客户端验收。

## 开发验证

```sh
python3 -m unittest discover -s tests -v
python3 skills/fixed-ip-vpn/scripts/test_workflow.py
node --test tests/*.test.mjs
npm --prefix web run build:status
```

[后台管理](docs/admin-console.md) · [订阅与管理](docs/subscriptions.md) · [Google 登录](docs/admin-login.md) · [运维](docs/operations.md) · [安全](SECURITY.md)

MIT License。内置 Manrope 字体遵循 SIL OFL。
