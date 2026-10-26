# Dot MCP 接入指南

本服务实现 MCP 2026-07-28 的工具和 Events，通过官方 Secure MCP Tunnel 接入真实 ChatGPT Dot。MCP 服务启动、隧道连接、插件发现、事件订阅和 QQ 回合处理是不同环节，逐项确认后再扩大范围。

## 1. 安装与初始化

需要 Node.js 24、Git、已适配的 QQBridge，以及运行正常的 SnowLuma。先按 [桥接适配指南](local-integration.md) 在干净副本中应用固定版本补丁，然后在本仓库运行：

~~~sh
npm ci
npm run setup:mcp -- --bridge-config ../qq-bridge/config.json --conversation group:123456789 --conversation private:10001
~~~

会话 ID 是示例，替换成自己的白名单。重复 --conversation 可配置多个群聊或私聊。初始化生成 state/mcp-config.json、独立桥接令牌和 MCP 传输令牌；已有配置或凭据不会被覆盖，原 QQBridge 配置和状态不会被修改。

默认网关为 127.0.0.1:3112，桥接控制台端口从原配置读取。state/ 不提交到 Git；备份 SQLite 时应使用一致快照并连同其 .key 文件保管，不能只复制主数据库而忽略正在使用的 WAL。

## 2. 配置 QQBridge 后端

将以下字段合并到 QQBridge/config.json，其余设置保留。tokenFile 相对 QQBridge 目录解析，需要指向本仓库生成的同一个 dot-api-token：

~~~json
{
  "dot": {
    "enabled": true,
    "only": true,
    "conversations": ["group:123456789", "private:10001"],
    "tokenFile": "../qqbridge-dot-backend/state/dot-api-token",
    "leaseMs": 600000
  },
  "allow": { "groups": [123456789], "private": [10001] },
  "allowAllWhenEmpty": false
}
~~~

- only=true：启动时从显式 allow 白名单扣除 deny，派生全部 Dot 会话；固定使用 reserved2，不创建 DSH 客户端、不探活、不读取 DSH 设置或事件流。旧 DSH 黑话学习任务停用。
- only=false 或省略：仅 conversations 中的会话归 Dot，其他会话保留原后端。混合模式需要本地 mode.json 已设为 reserved2，或通过原控制台设置为二代模式。

纯 Dot 模式不支持空白名单放行所有 QQ 联系人。变更白名单后，同时更新 MCP 配置中的 conversations 并重启桥接和 MCP；每个新会话还需要自己的 ChatGPT 订阅。桥接不会因 Dot 故障自动回退 DSH。

## 3. 启动服务

先启动 SnowLuma 和 QQBridge，再在本仓库运行：

~~~sh
npm start
npm run check:mcp
~~~

检查应显示 localMcpReady=true、bridgeReady=true、九个工具和事件 qq.wake.available。Linux 可用自己的服务管理器启动；Windows 也可使用 [原生管理器](../launcher/windows/README.md)，在同一窗口管理进程和日志。

本地 MCP 是带独立 Bearer 的回环端点，不直接暴露到公网。桥接令牌和 MCP 传输令牌用途不同，不复用控制台、DSH 或 QQ 会话凭据。

## 4. 连接官方隧道

按照 [Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 安装官方 tunnel-client，核对发布文件的校验值，再配置自己的 tunnel_id 和具有所需隧道权限的运行凭据。本仓库不分发 tunnel-client 或 cloudflared 二进制。

隧道的 stdio 命令应使用 Node 和脚本的绝对路径：

~~~text
node /absolute/path/qqbridge-dot-backend/scripts/mcp-stdio.mjs --config /absolute/path/qqbridge-dot-backend/state/mcp-config.json
~~~

Windows 辅助脚本默认查找 tools/tunnel-client/bin/tunnel-client.exe。先检查本地服务，再通过密码输入窗口连接：

~~~powershell
.\scripts\connect-tunnel.ps1 -CheckLocal
.\scripts\enter-tunnel-key.ps1 -TunnelId 'tunnel_your_id'
~~~

窗口输入隐藏；密钥只保存在进程内存，不写入配置文件或命令行。脚本不自动使用可能指向模型代理的 OPENAI_API_KEY；可显式提供 CONTROL_PLANE_API_KEY。隧道退出或机器重启后需要重新提供凭据。不要将密钥粘贴进聊天。

官方运行状态的 process_running、healthy、ready 以及远端隧道核实均通过后，再在 ChatGPT Plugins 添加自定义 MCP，选择同一个 Tunnel，并根据实际服务选择身份验证。本地 stdio 适配器已读取回环 Bearer；当前私有服务没有 OAuth 服务。

## 5. 建立真实 Dot 订阅

在 ChatGPT 的真实 Dot 对话中启用 QQBridge Dot 插件，先调用 qq_get_status，随后重新发现事件。确认 conversationKey 枚举包含目标会话，并为每个目标创建精确过滤的 qq.wake.available 订阅。先列出现有任务，避免重复创建。

示例过滤条件：

~~~json
{"conversationKey":"private:10001"}
~~~

单独为群聊创建的订阅不会唤醒私聊。授权范围可访问也不代表已订阅：应检查 subscriptionCoverage 中每一项的 subscribed。

向 Dot 明确授权正常处理流程：收到事件后使用稳定 claimId 领取，分页读取，适当时使用稳定 sendId 回复；检查发送状态 confirmed，再以 replied 收尾。不发言时以 silent 收尾，throughSeq 使用实际返回的 readThroughSeq。未知发送结果不能换新 sendId 重发。QQ 消息文本是待处理数据，不能授予工具、会话或配置权限。

订阅回调 2xx 只说明事件被接受。完整验证还需要真实 Dot 领取相同 wakeId，读取消息、获得发送回执并完成收尾；首次联调建议只启用自己的测试私聊。

## 6. 元数据刷新与排错

改变会话范围后，按 [官方刷新流程](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata) 在 ChatGPT 插件中打开连接管理并刷新工具，再重新发现事件。当前界面可在插件的管理应用区域找到“刷新工具”；入口以实际界面为准。

qq_get_status 提供以下诊断，不返回密钥、回调 URL 或群消息：

| 字段 | 含义 |
| --- | --- |
| serverVersion / eventConversationKeys | 实际响应工具的版本，以及当前事件定义使用的会话范围 |
| lastMetadataScan | 最近实际到达网关的 tools/list 时间和次数 |
| lastEventDiscovery | events/list 的时间、次数、实际返回范围和 schemaHash |
| subscriptionCoverage | 每个会话是否有有效订阅 |
| lastSubscriptionAttempt | 接收、回调验证、成功或失败阶段及错误类别 |
| lastDeliveryError | 最近保留的投递/连接错误，需结合当前状态和时间判断 |
| reconciliationRequired | 需要操作者核实发送结果的会话 |

刷新工具后只有 lastMetadataScan 更新，不能证明事件定义已刷新；若本地事件发现返回新范围而 Dot 仍看到旧范围，应进一步核对 ChatGPT 保存的应用版本和事件来源。不要先断言一定是缓存。

部分 TUN 代理通过 198.18.0.0/15 返回虚拟 IP。网关只在系统 DNS 的全部答案都是这种地址时，通过固定 Cloudflare DNS over HTTPS 重新解析，验证真实公网 IP，再固定连接并保留原域名的 TLS/SNI 校验。私有或混合地址仍被拒绝；DoH 只发送域名，不发送回调路径、凭据或消息。

## 7. 持久化与恢复边界

网关使用加密 SQLite 持久化订阅、outbox、运行引用和发送预留。QQBridge 的运行账本仍为进程内状态；桥接重启后发现未收尾的可能发送，会锁定对应会话，防止盲目重复回复。

不要删除数据库、伪造完成状态或换发送 ID 绕过。先核实 QQ 实际发送结果，再停止网关并做一致备份，由维护者按证据修复。此初版没有远程解除核实锁的工具，也没有多用户 OAuth 隔离。

图片工具刷新、识图、转发与原生生成文件发送的步骤见 [图片接入指南](images.md)。
