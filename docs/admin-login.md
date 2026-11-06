# Google 登录

Google 验证身份，RP 在 D1 管理账号、权限与会话。Worker 直接完成 OAuth 回调；不依赖外部登录网关、VPS 服务或 Mac 常驻。

## Google 控制台

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，新建或选择项目，例如 `route-pilot`。
2. 进入 **Google Auth Platform**（旧界面为 APIs & Services → OAuth consent screen）。首次使用点 **Get started**，应用名填 `route-pilot`，支持邮箱和联系邮箱填自己的邮箱。
3. **Audience** 选择 **External**。首轮保持 **Testing**，在 **Test users** 加入自己的 Google 邮箱。此列表控制 Google 测试资格；RP 的管理权限另由 D1 决定。
4. **Data Access** 仅需 `openid` 和 `.../auth/userinfo.email`，不申请 Gmail、Drive 或离线访问。代码登录请求会自动携带 `openid email`。
5. **Clients → Create client → Web application**。在 **Authorized redirect URIs** 添加：

   `https://YOUR_STATUS_HOST/private/auth/google/callback`

   必须与部署域名完全一致，不加尾部斜杠。当前服务端跳转方案无需填写 Authorized JavaScript origins。
6. 创建后下载 OAuth 客户端 JSON，存到仓库外，将权限设为 `600`。密钥不发到聊天，不提交 Git。已有客户端修改回调后，重新下载 JSON。

## 保存到 Worker

推荐由 Agent 导入私有 JSON：

```sh
python3 ops/configure_google.py --config /private/routepilot/deploy.json \
  --credentials-file /private/routepilot/google-oauth.json
```

脚本核对 Web 客户端类型及精确回调地址，使用原有 Wrangler 发布权限，把 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 写入 Worker Secrets，不打印其值。两项统一使用 Secret，后续发布代码不会清除它们。无需新的 CF API Token。

也可直接在 **CF → Workers & Pages → 后端 Worker → Settings → Variables and Secrets** 添加这两个同名 **Secret** 并部署。不要填到静态页面 Worker。

`APP_ORIGIN` 由部署脚本按状态域名生成；回调地址由后端固定计算，不接受客户端自定义返回地址。

## RP 账号策略

首次部署在仓库外的部署 JSON 设置 `bootstrap_admin_email`，运行 `ops/publish_monitor.py`。只有账号表为空时才创建初始管理员；之后重复部署不会重新启用已禁用账号，也不会覆盖 Google 身份绑定。首版只允许管理员，无公开注册。

```sh
python3 ops/accounts.py list
python3 ops/accounts.py allow --email admin@example.com
python3 ops/accounts.py disable --email admin@example.com
python3 ops/accounts.py enable --email admin@example.com
python3 ops/accounts.py revoke-sessions --email admin@example.com
```

这些命令使用操作者已有 D1 发布权限，可加 `--config`、`--wrangler`。首次登录用经过验证的邮箱匹配预先允许的账号，然后绑定 Google `sub`；后续按稳定身份识别，不允许其他 Google 身份接管同一邮箱。禁用账号会撤销现有会话，重新启用必须重新登录。

## 登录与验收

浏览器发起同源登录请求 → Google 登录 → RP 回调核验 → D1 检查账号 → 设置本站 Cookie → 返回 `/admin/`。OAuth 使用浏览器绑定的一次性 state、nonce 和 PKCE S256；回调原子消费后不能重放。Google ID token 的签名、签发者、受众、时效、nonce 与邮箱验证状态均需通过。

会话最长八小时，Cookie 为 Secure、HttpOnly、SameSite=Lax；D1 仅存会话摘要。每次管理请求重新检查账号启用状态和角色。退出删除服务器会话；浏览器脚本不接触 OAuth 密钥或 Google token，localStorage/sessionStorage 不存登录凭证。

缺少 Google 参数时，管理页显示“Google 登录尚未配置”，旧管理密钥不可登录。迁移会清除旧登录会话，不修改监控历史、订阅或节点凭据。

验收必须包括真实 Google 登录、退出、非允许账号拒绝、禁用后旧会话失效，以及匿名状态页、现有订阅和下一次 VPS 上报。模拟测试不能代替真实 Google 回调。公开状态页与采集、订阅、发放凭证保持各自权限，不要求 Google 登录。

参考：[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)、[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
