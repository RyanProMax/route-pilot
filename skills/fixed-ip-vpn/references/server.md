# VPS 部署与回滚

## 适用条件

已有、获准管理的 Ubuntu/Debian + systemd 服务器；固定公网 IPv4 直接分配到本机接口。NAT VPS、浮动 IP、容器宿主和多租户路由需要先适配绑定方式，不能直接照用 `sendThrough`。首次运行 SSH 取得主机指纹时核对厂商控制台，不用 `StrictHostKeyChecking=no`。

已知验证组合：Xray 26.10.31、Mihomo 1.19.32、Clash Verge 2.5.8、Shadowrocket 2.2.93 (3488)。这不是永久兼容性保证。版本升级先复核 [Xray Release](https://github.com/XTLS/Xray-core/releases)、[Freedom](https://xtls.github.io/en/config/outbounds/freedom.html)、[Sockopt](https://xtls.github.io/en/config/transport.html#sockoptobject) 及 [Mihomo TLS](https://wiki.metacubex.one/en/config/proxies/tls/)。

## 盘点

并行读取 OS/架构、`ip -j address`、`ip -6 route`、`ss -lntup`、Xray 版本/服务、UFW/nftables 状态；配置含凭据，只输出协议、监听、标签、SNI、出站策略。检查云防火墙是否绑定实例及 IPv6 规则，不能只看 UFW。

如果已有 Xray，先选择复用现有服务还是有备份的迁移。附带脚本只管理 `fixed-ip-vpn.service`，不会停止已有 `xray.service` 或抢占其端口。当前工作实例若服务已健康，沉淀技能时不要重装它。

## 安装及参数

1. 云控制台确认固定 IPv4、IPv6 分配和网关。实例 IPv6 在云端开启不代表 OS 已有地址；需要时按厂商官方说明配置 Netplan，并验证默认路由。涉及重启或云网络变更时先保留 SSH/控制台恢复通道，遵守用户范围。
2. 安装 Python 3、CA 证书、curl、unzip 等缺失依赖。若 SSH 尚未加固：只有在用户授权范围内创建密钥管理用户、测试第二个登录会话、运行 `sshd -t` 后 reload。核对 `sshd -T` 和 cloud-init drop-in；不要盲目覆盖 SSH 配置或自动关掉当前唯一登录方式。
3. 安装固定版本的官方 Xray：从 `XTLS/Xray-core` Release API 取得与 OS/架构匹配的 ZIP 及官方 SHA256/asset digest，下载到私有暂存目录并校验。只解压需要的 `xray`，安装到 root 管理的可执行目录，确认 `xray version`。**下载 URL、版本、架构、SHA256 写入部署记录；不执行未固定版本的 curl-pipe-shell。** [官方安装器](https://github.com/XTLS/Xray-install) 可作为目录/权限参考，不默认运行其会覆盖已有服务的安装流程。
4. 在用户私有目录准备 inventory。示例的 `203.0.113.10`、`2001:db8::10`、`www.example.com` 不是可用部署参数。SNI 需由 VPS 实测可达且支持所需 TLS；服务端 dest/SNI 与所有客户端一致。不要把上一次可用域名当成永远可用。
5. 生成 bundle。重复生成使用同一 `credentials.json`；将已批准复用的既有凭据写入该私有文件时，不输出内容。服务器仅需 `xray-server.json`；不要把 SSH 私钥、API Secret 或客户端订阅上传 VPS。

## 应用

把 `apply_server.py`、它依赖的 `render.py`、`routing.py` 和 `xray-server.json` 上传到目标 VPS 用户私有暂存目录。以下命令在目标 VPS 执行，先计划，再在当前部署授权内应用：

```sh
sudo python3 apply_server.py --config ./xray-server.json --xray /usr/local/bin/xray --version 26.10.31
sudo python3 apply_server.py --config ./xray-server.json --xray /usr/local/bin/xray --version 26.10.31 --apply
```

脚本核对版本、绑定 IPv4、端口占用和 `xray run -test`；管理独立服务，使用 systemd DynamicUser、LoadCredential 和绑定低端口所需 capability。配置 root:root 600，systemd 读取后供服务使用。失败自动恢复此前配置/单元/启用状态；无变化的重复应用不重启。

脚本不改防火墙或 SSH。按实际防火墙工具，仅添加指定 TCP 服务端口和需要的 IP 家族；保留当前 SSH 放行，不 flush 规则、不自动启用一个原本关闭的防火墙。VLESS TCP 入口承载客户端 UDP 时也不需要开放服务器同端口 UDP。云防火墙同步检查。逐项记录新建规则，回滚只撤本次规则。

启动后检查服务 active、实际双栈监听、warning 日志。`ss` 中的 `[::]:443` 不足以证明外部 IPv6 可达。生成器设置 ForceIPv4 + sendThrough，并阻止字面 IPv6 目的地址；用 IPv4/双栈出口站实际验证。

## 回滚

脚本返回 `/var/lib/fixed-ip-vpn/backups/<id>`。必要时在同一服务器：

```sh
sudo python3 apply_server.py --rollback /var/lib/fixed-ip-vpn/backups/<id> --apply
```

恢复前检查该备份属于当前目标。首次安装的回滚删除本工具创建的配置和单元；既有安装恢复旧版本。备份保留。脚本不回滚云网络、二进制安装、SSH 和防火墙；这些操作必须在部署记录中另列恢复方式。远程暂存凭据在上传/应用成功后清理。

## “完成”的证据

服务正常、物理入口可达、协议握手成功、至少两个 HTTPS 站点显示期望 IPv4、实际客户端已切换，缺一就明确列为待验收。不要因服务器 active 就宣布手机和 Mac 可用。
