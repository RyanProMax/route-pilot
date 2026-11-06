# CF 私有订阅

用户需要 HTTPS 订阅地址、自动更新、凭证用量或撤销时读取。完整命令见项目 `docs/subscriptions.md`。

- 复用状态域名 `/sub/` 和 `/private/` 路由。VPS 仅运行 Xray、SSH、安全服务和原有分钟采集任务；不为订阅安装 HTTP 服务、隧道或申请新域名。
- `ops/register_device.py` 发放身份；`ops/subscriptions.py publish --directory …` 经 SSH 刷新活动身份，在本机加密后上传 CF。URL 存在私有目录 `subscription-urls.json`；同一身份更新复用 URL、UUID，轮换令牌需要显式 `--rotate-token`。
- 订阅令牌和 VLESS UUID 独立随机生成，禁止从名称、ID 或另一个凭据推导。数据库只存令牌摘要和 AES-GCM 密文，密钥在 Worker Secret 与操作者私有目录；URL、原生配置、密钥不进入 Git、公开页面、应用日志或第三方转换网站。
- 用户明确要求地址时私下交付对应 URL 或本机生成的二维码，不把本地文件冒称订阅。Clash 以远程配置导入；Shadowrocket 节点订阅和分流配置分别导入，确认实际开启配置模式、国内直连、固定出口及无中转。
- 完整撤销用 `ops/subscriptions.py revoke --id …`：先禁止下载，再移除 VPS UUID 并重启 Xray 关闭旧会话。其他客户端短暂重连。两个系统不是原子事务，发生部分失败必须明确说明并补完。`--download-only` 不会使已导入节点失效。
- Google 管理登录按项目 `docs/admin-login.md` 直接接入 Worker，账号、角色、禁用和会话由 RP 的 D1 管理。用户指定初始管理员邮箱；首次绑定经过验证的 Google 身份后按稳定 `sub` 识别，不允许同邮箱的另一个身份接管。部署不得重新启用禁用账号或覆盖现有绑定；使用 `ops/accounts.py` 管理账号及撤销会话。
- Google Web OAuth 客户端必须登记精确回调 `/private/auth/google/callback`。用 `ops/configure_google.py` 将仓库外 mode-600 JSON 导入 Worker Secrets；不索取密钥聊天文本，不申请额外登录网关权限。缺少配置时明确显示待配置，不恢复旧管理密钥。上报、订阅和发放凭证保持独立。
- 只有真实 Google 登录、退出、非允许账号拒绝、禁用后旧会话失效，以及匿名状态、订阅和后续上报都通过，才能宣布接入完成。先验证 state、浏览器绑定、PKCE、nonce、签名及回调重放拒绝；不把按钮或模拟测试当成真实 OAuth 验收。
- 仅私有管理页显示凭据名称、在线状态及上下行流量。公开页仅显示健康和主机负载。不得以隐藏前端入口代替接口鉴权。
- 用量从首次基线开始累计，不补造历史；同一凭据共享设备合并计数。重启前未采样区间可能丢失，跨 UTC 月份的单次间隔按比例拆分。VPS 保存原始基线和累计值，重试上报不能重复计费。
- 验收不同令牌隔离、加密篡改拒绝、旧令牌撤销、未登录拒绝、管理页退出、报告重试及服务重启累计，再验证真实客户端。默认保留尚未完成迁移验收的旧共享凭据。

隔离 Mihomo 探活时，若现有 TUN 正在工作，给临时进程指定实际物理接口再验证。未绑定接口的临时内核失败不能直接归因于新凭据；同样要对比旧凭据、实际运行内核与真实日常出口。URL Scheme 导入使用文档支持的 `clash://install-config?url=<编码后的完整地址>`；不要添加未经客户端版本验证的额外参数。
