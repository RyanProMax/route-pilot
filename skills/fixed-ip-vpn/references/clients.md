# 客户端导入、验收和回滚

## Clash Verge

1. 记录客户端/内核版本、当前订阅 UID、模式、TUN、监听端口、系统代理及选择；备份 registry、旧配置和相关扩展脚本。不要打印订阅 URL、节点 UUID 或令牌。
2. 用独立本地配置导入 `clash-verge.yaml`，名称用目标地区/用途；不把节点写入机场扩展脚本。导入与激活是两步，确认当前 UID 和实际 runtime 都已切换。使用原生 UI 或该版本明确支持的导入接口；不要猜 registry schema。
3. 规则模式、TUN 开启。按 routing.md 让固定出口业务优先到 VPS，国内与局域网服务 DIRECT；保留经核验规则的原有最终策略，未指定规则时默认其余流量到 VPS。DNS、两端地址家族与端口逐项检查；系统代理是否开启不是 TUN 是否接管的唯一指标。
4. 生成器使用 `url-test`。已验证 [Clash Verge 2.5.8 首页代码](https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.8/src/components/home/current-proxy-card.tsx) 只列出 Selector/URLTest，过滤 Fallback。新版本再确认，不把显示问题误判为断网。
5. 检查首页节点、代理页延迟、实际连接链。旧代理长连接若仍存在，只清理受切换影响的连接以重建，不动其他应用设置。独立配置不得出现 `dialer-proxy`、外部 provider 或共享节点；固定出口组不能加入 DIRECT 作为故障回退。普通国内服务的 DIRECT 分流仍然保留。
6. 如果用户要求撤销先前机场注入：对比修改前备份，仅移除本任务添加的组/规则/脚本，保留原订阅和用户选择；清理失效的 saved selection，再切回独立配置。不要清空整个机场订阅。

显式代理验收和日常 TUN 验收都跑 `verify.py`。找到实际 Mihomo controller（例如 Clash Verge 服务的 Unix socket），读取 `/configs`、`/proxies` 和 `/connections`，只输出模式、组名及本次测试连接的链。不要输出其他应用的访问记录。确认测试请求的 inbound type 为 Tun，并且链中只有本 VPS。

外部站点返回期望 IP 只能证明出口；“无需机场”还需要独立配置无上游链、物理绑定测试、当前连接链作为依据。UI 重载一次后仍应保持当前配置。

回滚使用先前 UID 和备份配置，通过客户端正常切换；保留新配置以供诊断。未解决前不要把所有流量 DIRECT 当作固定出口的回退。

## Shadowrocket

首选已验证可移植的 VLESS URI + 原生规则 `.conf`，不把尚未实机验证的完整 YAML 当成保证一键可用的结果。

- 导入 `shadowrocket-nodes.txt` 中可达家族的链接；需要二维码时在本机生成，每张只含一个节点。不要上传凭据到在线二维码或订阅转换服务。
- IPv6 URI 地址必须用方括号；SNI、公钥、short ID、flow 与服务器完全一致。
- 直连任务将“代理通过”设为无。先临时用“代理”模式验证地址，再导入并启用 `shadowrocket-rules.conf`，使用“配置”模式复测。此规则先固定出口业务 PROXY，再局域网、通讯/媒体和国内 IP DIRECT，其余 `FINAL,PROXY`；无需一直全局代理。
- 记录 Shadowrocket 版本、Wi-Fi/5G、选中节点、Proxy Via、路由模式、实测出口。不能把 Mac 模拟协议成功当成手机已成功。
- 没有手机控制能力时，让用户完成扫码/导入和 IP 检查；只请求结果，不要求发凭据。完成自动化准备后再提出这一必要交接。

## 固定出口及验收记录

服务端绑定固定 IPv4并 ForceIPv4，客户端抑制目的 DNS AAAA，但使用字面 IPv6 连接 VPS。入口 IPv6 不意味着出口也是 IPv6。只支持 IPv6 的目的服务在严格固定 IPv4 模式下可能不可用，应如实报告。

验收记录至少包含：时间、配置名称/UID、软件版本、物理接口/入口家族、两个出口检查、连接链、手机实机状态、回滚目录。分别标记 generated / syntax-valid / service-active / isolated-direct-pass / daily-TUN-pass / phone-pass，不能混写。

CLI 使用 loopback 专用代理（默认 1088）。需要防止程序漏走代理时，可为指定进程设置代理环境并先检查出口，但要核对程序是否遵循代理变量；不要将这个包装器描述为通用网络隔离。
