# Google 登录

管理页通过 Cloudflare Access 登录 Google 账号。公开状态页、节点订阅、VPS 上报和 CLI 发放使用各自原有权限；无需在 VPS 安装服务或新建隧道。

## 一次性配置

1. 在 Cloudflare Zero Trust 创建团队；已有团队直接复用。
2. 按 [Cloudflare Google 接入文档](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/) 创建 Google OAuth **Web application**，在 CF 添加 Google 身份提供商。已有 Google 提供商可复用。回调为 `https://TEAM.cloudflareaccess.com/cdn-cgi/access/callback`；不要填状态页域名。OAuth Secret 只填 CF 控制台，不进入仓库或聊天。Google consent screen 若处于测试状态，添加允许登录的测试用户。
3. 创建仅限目标 CF 账户的 API Token，权限为 **Access: Apps and Policies / Edit**、**Access: Organizations, Identity Providers, and Groups / Read**。保存至仓库外、当前用户所有的 mode-600 文件。Worker 发布继续使用 Wrangler；无需 DNS 或 VPS 权限。
4. 生成私有计划并检查保护路径与邮箱：

```sh
python3 ops/configure_access.py --config /private/routepilot/deploy.json \
  --token-file /private/routepilot/cf-access-token --email admin@example.com
# 多个 Google 身份提供商时加 --idp-id GOOGLE_PROVIDER_ID。
# 检查同目录 access-plan.json 后，执行相同命令加 --apply。
python3 ops/publish_monitor.py --config /private/routepilot/deploy.json
```

`--apply` 创建专属允许策略和同一个 Access 应用，精确覆盖 `/admin`、`/admin/*`、`/private/overview`。只允许指定 Google 提供商和明确邮箱，默认拒绝其他人。不能保护整个域名或 `/private/*`，否则订阅、上报或 CLI 会被登录页拦截。

脚本保存资源检查点，部分失败后可重试；已存在但未登记或配置不一致的资源需要先检查，不自动覆盖。部署配置切换至 `admin_auth: "access"`，保留 `before-access.json` 私有备份。团队、应用 AUD、资源 ID 和邮箱都不进入公开源码。

## 运行与验收

- Chrome、Safari 均可：打开 `/admin/` → Google 登录 → 查看负载和凭证用量。会话最长八小时；过期后用登录按钮重新进入，退出走 CF Access logout。
- Worker 使用 `jose` 校验 CF JWT 的签名、固定签发者、应用 AUD、时效和邮箱摘要白名单。只提供邮箱请求头无效；配置不完整时拒绝访问。
- Access 模式关闭旧密钥登录和旧会话；部署同时禁用旧管理密钥摘要并删除旧会话。上报与发放密钥继续独立生效。不能依赖隐藏管理入口保护接口。
- 切换后必须实测允许账号登录、退出、非白名单拒绝，以及匿名状态页、现有订阅下载、下一次 VPS 上报。单元测试和登录按钮截图不能替代真实 Google 回调验收。
- 收回账号权限：同时移除 Access 策略和部署邮箱白名单，重新发布 Worker，并在 CF 撤销已有 Access 会话。仅退出浏览器不等于全局撤销已经复制的 JWT；离线签名校验不会实时查询全局撤销列表。保持 Access 网关保护、关闭 Worker 预览与 `workers.dev` 入口。

未配置 Access 的自托管部署仍可显式使用 `admin_auth: "key"`；这是独立部署模式，不是 Google 登录失败后的自动降级。回滚需操作者恢复私有配置并重新发布，不能向访客提供绕过入口。
