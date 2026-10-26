# qqbridge-dot-backend

让你在 **ChatGPT 中的真实 Dot** 通过 SnowLuma + QQBridge 接收 QQ 消息，并使用 MCP 工具回复。

已验证真实事件唤醒，以及私聊的自动领取、读取、发送和收尾。支持纯 Dot 后端：全部显式白名单会话由 Dot 接管，不需要运行 DSH；也保留按会话混合后端的兼容方式。目前 Dot 工具支持纯文本消息。

## 先理解这条链路

~~~text
你发 QQ 消息
  → SnowLuma 收到消息
  → QQBridge 入库并生成唤醒
  → MCP 网关把事件发送给已订阅的 Dot
  → ChatGPT Dot 领取、读取、判断是否回复
  → 调用 QQ 工具发送，最后显式收尾
~~~

本机运行的是桥接、工具和事件服务，负责思考和回复的是 ChatGPT Dot。工具调用通过官方 Secure MCP Tunnel 抵达本机，事件通过签名 HTTPS 回调抵达 ChatGPT；本地网关不调用模型 API。

**本机服务启动、隧道连接、插件连接、事件订阅、实际回复是五个检查点。** 只看到“插件已连接”还需要继续完成订阅和收发验证。

## 新手接入：先跑通自己的私聊

下面以 Windows + PowerShell 为例，工作目录使用 C:\bots。示例 QQ 号 10001、群号 123456789 和目录都必须替换成自己的实际配置。

### 1. 准备环境和 QQ 消息入口

你需要：

- Node.js 24 和 Git，确认 node --version、git --version 能运行。
- 一套已登录 QQ、能正常运行的 SnowLuma。按你使用的发行版说明配置 OneBot HTTP / WebSocket；本例分别为 127.0.0.1:3000 和 127.0.0.1:3001。
- 能创建自定义 MCP 插件、能使用 Dot 事件任务的 ChatGPT 账号或工作区。相关功能受账号和工作区权限限制。
- Windows 原生管理器需要 .NET 10 SDK 构建；运行机器需要 .NET 10 Desktop Runtime。它能把各服务和日志放在同一窗口，不为每个组件打开终端。

先确认 QQ 登录正常，记下 SnowLuma 的实际安装目录、OneBot 地址和访问令牌。本仓库不分发 QQ 客户端或 SnowLuma；这些组件的安装与登录以其发行说明为准。

### 2. 下载项目并应用固定基线补丁

新建工作目录后执行：

~~~powershell
New-Item -ItemType Directory -Path C:\bots -Force | Out-Null
Set-Location C:\bots
git clone https://github.com/UyNewNas/qqbridge-dot-backend.git
if ($LASTEXITCODE -ne 0) { throw '本仓库下载失败，请先检查目标目录和网络。' }
git clone -c core.autocrlf=false https://github.com/Derpyu520/qq-bridge.git
if ($LASTEXITCODE -ne 0) { throw 'QQBridge 下载失败，请先检查目标目录和网络。' }
git -C .\qq-bridge checkout --detach a49877f4e58d04e47532d44b803360d0f001160d
if ($LASTEXITCODE -ne 0) { throw '固定版本检出失败。' }

Set-Location .\qq-bridge
npm ci
if (-not (Test-Path .\config.json)) {
    Copy-Item .\config.example.json .\config.json
}

Set-Location ..\qqbridge-dot-backend
npm ci
node .\scripts\apply-qqbridge-patch.mjs --source ..\qq-bridge --check
node .\scripts\apply-qqbridge-patch.mjs --source ..\qq-bridge
~~~

这组命令用于全新副本。已有 QQBridge 配置或本地源码修改时，先保留原安装，按 [适配指南](docs/local-integration.md) 准备副本；安装器会校验固定 commit 和文件内容，不覆盖不匹配的源码，也不修改配置或会话状态。

QQBridge 仍会安装其原有 npm 依赖，但纯 Dot 模式不需要启动 DSH 程序。

### 3. 初始化凭据，配置自己的私聊

在 qqbridge-dot-backend 目录运行，先把 10001 替换成你的 QQ 号：

~~~powershell
npm run setup:mcp -- --bridge-config ../qq-bridge/config.json --conversation private:10001
~~~

生成的文件都在本机 state/ 中：

| 文件 | 用途 |
| --- | --- |
| mcp-config.json | 本地端口、桥接地址和允许访问的会话 |
| dot-api-token | MCP 网关访问 QQBridge 的专用令牌 |
| mcp-transport-token | 本地 MCP HTTP 入口的独立令牌 |

已有配置不会被 setup 覆盖，后续修改直接编辑本机配置。打开 QQBridge 的 config.json，把以下字段合并进去，并保留其他配置：

~~~json
{
  "ownerQQ": 10001,
  "allow": { "private": [10001], "groups": [] },
  "allowAllWhenEmpty": false,
  "socialV2": { "enabled": true },
  "dot": {
    "enabled": true,
    "only": true,
    "conversations": ["private:10001"],
    "tokenFile": "../qqbridge-dot-backend/state/dot-api-token",
    "leaseMs": 600000
  }
}
~~~

同时将原有 snowluma 配置中的 homeDir、wsUrl、httpUrl、accessToken 改成步骤 1 的实际值。tokenFile 相对 QQBridge 目录解析，必须指向本仓库生成的同一个 dot-api-token。

only=true 会把显式白名单中的全部会话交给 Dot，固定使用 reserved2 消息流程，停用 DSH 客户端、探活、设置同步、事件流和旧 DSH 黑话学习任务。还需确认 state/mcp-config.json 中的 conversations 是你刚配置的私聊。

### 4. 在管理器里启动服务

在本仓库的 PowerShell 窗口执行：

~~~powershell
.\launcher\windows\build.ps1
$env:QQB_BRIDGE_DIR = 'C:\bots\qq-bridge'
$env:QQB_DOT_BACKEND_DIR = 'C:\bots\qqbridge-dot-backend'
$env:QQB_SNOWLUMA_DIR = 'C:\bots\SnowLuma'
Start-Process '.\launcher\windows\publish\GPTBot管理器.exe'
~~~

将 SnowLuma 目录换成实际目录，点击管理器的“一键启动”。纯 Dot 模式应只显示 SnowLuma、QQ Bridge、Dot MCP 三项。检查日志和“接入状态”，再回到 PowerShell 执行：

~~~powershell
npm run check:mcp
~~~

此时应有 localMcpReady=true、bridgeReady=true，工具数量为 6，事件包含 qq.wake.available。subscriptions=0 在尚未创建订阅时是正常状态。

<details>
<summary>不使用 Windows 管理器时</summary>

按各自方式启动 SnowLuma；在 QQBridge 目录运行 npm start，在本仓库运行 npm start，保持两个服务持续运行。Linux 可使用自己的服务管理器；Windows 管理器详细说明见 [这里](launcher/windows/README.md)。

</details>

### 5. 创建并连接官方 Secure MCP Tunnel

按 [官方隧道说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 在 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels) 创建或复用隧道，确认它关联到你要使用的 ChatGPT 工作区。记下自己的 tunnel_id。

创建或修改隧道需要 Tunnels Read + Manage；运行隧道客户端及在 ChatGPT 中选择隧道需要 Tunnels Read + Use。运行密钥使用 OpenAI Platform 中具有相应权限的凭据，不能拿 DeepSeek 或其他模型代理密钥替代。

从 [官方 tunnel-client 仓库](https://github.com/openai/tunnel-client) 下载与你系统架构匹配的发行包，按其校验文件验证下载。Windows 辅助脚本要求下列文件存在：

~~~text
qqbridge-dot-backend/tools/tunnel-client/bin/tunnel-client.exe
~~~

在本仓库执行：

~~~powershell
.\scripts\connect-tunnel.ps1 -CheckLocal
.\scripts\enter-tunnel-key.ps1 -TunnelId 'tunnel_your_id'
~~~

将示例 ID 替换成自己的完整隧道 ID。在弹出的 GPTBot 密码输入窗口填写运行密钥，点击 Verify and connect；看不到窗口时可用 Alt+Tab 查找。密钥只在进程内存中，脚本不保存到磁盘，也不要求你发到聊天里。

连接成功后，检查本机 state/tunnel-last-connect.json：processRunning、healthy、ready、remoteVerified 应全部为 true。保持隧道客户端运行。它与本地 Dot MCP 服务是不同进程；重启机器或隧道进程退出后，需要重新输入运行密钥连接。

| 凭据 | 从哪里来、用在哪里 |
| --- | --- |
| SnowLuma 访问令牌 | SnowLuma 的实际配置，供本机 OneBot 连接使用 |
| 两个本地 Dot 令牌 | setup:mcp 自动生成，保留在本机文件中 |
| OpenAI 隧道运行密钥 | 在本地密码窗口输入，供官方隧道控制面使用；不是本项目的模型 API key |

### 6. 在 ChatGPT 添加 QQBridge Dot 插件

打开 [ChatGPT 插件页](https://chatgpt.com/plugins)：

1. 点击“添加 → 添加自定义 MCP 服务器”。
2. 名称填 QQBridge Dot，连接选择“隧道 / Tunnel”，填写同一个 tunnel_id。
3. 当前私有 stdio 接入没有 OAuth 服务，身份验证选择“无 / No authentication”。本地 Bearer 已由 stdio 适配器从本机文件读取。
4. 创建插件，确认能发现六个工具和事件 qq.wake.available。
5. 在 ChatGPT 调用 qq_get_status，确认 bridgeReachable=true，且会话列表包含自己的私聊。

平台和工作区权限仍然适用。插件显示“已连接”后，继续执行下一步；此时 subscriptions 仍可能为 0。

### 7. 在真正的 Dot 对话中创建订阅

**下面这段发到 ChatGPT 中你的 Dot 对话窗口。** QQ 里的机器人此时负责接收普通消息，不能代替你在 ChatGPT 侧创建事件任务。

将以下示例中的 10001 换成自己的 QQ 号后发送：

> 使用 QQBridge Dot 插件。先调用 qq_get_status，并重新发现 qq.wake.available，确认 conversationKey 包含 private:10001。先列出任务避免重复；如果没有这个私聊的同类任务，创建精确过滤 {"conversationKey":"private:10001"} 的事件订阅。
>
> 我授权你正常处理这个私聊：收到唤醒后，用稳定 claimId 领取；分页读取当前会话消息；需要回复时用稳定 sendId 调用 qq_send_message，确认发送结果；最后用实际 readThroughSeq 作为 throughSeq，调用 qq_finish_turn，以 replied 或 silent 收尾。发送结果未知时不要换 ID 重发。保留其他已有订阅，先报告创建结果和状态。

确认 qq_get_status 返回该会话 subscribed=true。只有一个私聊订阅时，subscriptions 应为 1；这个数字是订阅总数，不是 QQ 消息数。

如果 Dot 说任务创建返回异常，先列出任务并检查实际订阅是否已保存，再决定重试，避免重复任务。

### 8. 发一条新 QQ 私聊，确认自动完成整轮

现在回到 QQ，给机器人发一条普通测试消息。首次唤醒按现有合并策略可能有延迟；它需要经过事件投递和 Dot 的处理，并不保证即时回复。

完整成功的证据是：

| 检查点 | 应看到什么 |
| --- | --- |
| 接收 | SnowLuma 收到该私聊，QQBridge 消息进入未读队列 |
| 唤醒 | 生成此私聊的 wakeId，事件被回调接受 |
| 执行 | Dot 自动领取同一个 wakeId，读取消息 |
| 发送 | QQ 回复发送成功，状态 confirmed |
| 收尾 | 同一回合 finished=true |

只在 Dot 对话里手动要求“处理待领取唤醒”后收到回复，可以验证工具链路；还需要发一条新 QQ 消息，确认事件订阅能自动唤醒 Dot。webhook 2xx 或 subscribed=true 也不能单独证明整轮完成。

## 私聊跑通后，增加群聊或其他会话

以增加 group:123456789 为例：

1. QQBridge 的 allow.groups 增加目标群；本仓库 state/mcp-config.json 的 conversations 同时保留原私聊并加入目标群。
2. 当前回合收尾后，重启 QQ Bridge 和 Dot MCP。纯 Dot 模式会从白名单派生桥接归属。
3. 在 ChatGPT 打开 QQBridge Dot → 右上“管理” → 页面下方“管理应用” → “刷新工具”。
4. 让 Dot 重新发现事件，核对 schema 的 conversationKey 枚举已同时包含群聊和私聊。
5. 保留原私聊任务，去重后新增 {"conversationKey":"group:123456789"} 的订阅，并授权正常处理该群。

两个会话各有一个订阅时，应看到 subscriptions=2，两个 subscribed 都为 true。可访问范围、实际事件 schema 和订阅覆盖要同时核对。

## 常见问题：按证据定位

| 现象 | 检查与处理 |
| --- | --- |
| bridgeReachable=false | 检查 QQBridge 是否运行、补丁是否应用、Dot 是否启用、端口和专用令牌是否一致。插件连接成功不能替代这个检查。 |
| tunnel_client_not_connected / did not poll | 官方隧道未运行或没有正常轮询；检查进程及当前控制面状态，恢复后再试。 |
| MCP request timed out | 对照隧道、stdio、本地网关和桥接响应时间逐层检查；不要先认定是 QQ 离线。 |
| OAuth 设置自动发现失败 | 当前私有 stdio 服务没有 OAuth；核对连接是否选了 Tunnel，以及是否按本指南选择无身份验证。 |
| blocked_address，失败阶段 callback_verification | 检查回调地址解析。当前实现已兼容系统 DNS 全部返回 198.18/15 代理虚拟 IP 的情形；真实私有或混合地址仍会拒绝。 |
| 状态说可访问，事件枚举却没有该会话 | 核对桥接和 MCP 范围，重启服务，按上面的“管理应用 → 刷新工具”更新元数据，再重新发现事件。不能只看 qq_get_status。 |
| 找不到“刷新” | 在插件右上齿轮的“管理”页面下方找“管理应用 → 刷新工具”，入口以实际界面为准。 |
| subscribed=true 但 Dot 只记录元数据 | 在真正的 Dot 对话里把任务从只记录改成正常领取、读取、回复和收尾。 |
| 私聊没触发，群聊正常 | 检查是否只有群订阅；每个 conversationKey 都需要对应的精确订阅。 |
| 只有手动去 Dot 说话后才回复 | 核对自动事件订阅是否覆盖私聊，以及事件是否真正触发任务。 |
| lastDeliveryError 仍显示旧错误 | 结合错误时间、当前 bridgeReachable、事件记录和实际调用判断；历史错误不一定表示本次仍失败。 |
| reconciliationRequired 非空 | 先核实 QQ 实际发送结果，按 [恢复说明](docs/dot-mcp-local.md#7-持久化与恢复边界) 处理，不能删库或换 sendId 绕过。 |

诊断字段 serverVersion、lastMetadataScan、lastEventDiscovery 和 lastSubscriptionAttempt 用于确认“刷新或订阅请求是否真的到达当前服务”。操作后只更新工具扫描记录，不代表事件扫描也已更新；服务器返回新 schema 而 Dot 仍显示旧 schema 时，继续核对应用版本和事件来源。

## 工具、限制和开发验证

六个工具为 qq_get_status、qq_list_wakes、qq_claim_turn、qq_read_messages、qq_send_message、qq_finish_turn。消息文本是待处理数据，不授予工具或跨会话权限。发送使用稳定 ID，读取和已读确认分开，静默也需要收尾。

当前 Dot 工具仅支持纯文本读取、回复和收尾，尚未迁移 DSH 模型配置、完整对话历史、独立研究、图片、语音和贴纸工具。网关使用加密 SQLite 保存订阅、outbox 和发送预留，但 QQBridge 的运行账本仍在进程内，未知发送需要核实。

~~~powershell
npm run format:check
npm test
npm run demo
$env:QQBRIDGE_SOURCE_DIR = 'C:\bots\qq-bridge'
npm run test:integration
~~~

组件测试使用真实 bridge.js，并用本地替身隔离 QQ、DSH 和回调服务，不发送真实 QQ 消息；缺少源码或补丁时会失败，不会跳过。真实联调和测试结果见 [验证记录](docs/verification.md)，各提交的 CI 见 [GitHub Actions](https://github.com/UyNewNas/qqbridge-dot-backend/actions/workflows/ci.yml)。

| 进一步阅读 | 内容 |
| --- | --- |
| [接入与恢复细节](docs/dot-mcp-local.md) | 身份、隧道、诊断、持久化和恢复边界 |
| [QQBridge 适配](docs/local-integration.md) | 固定基线、安装、混合模式和撤回方式 |
| [本地 API](docs/local-api.md) | 本机桥接 API 与运行协议 |
| [Windows 管理器](launcher/windows/README.md) | 构建、进程管理、路径和日志 |
| [历史隐私检查](docs/privacy-audit.md) | 已发布提交的密钥、私有数据和署名检查 |
| [后续工作](docs/roadmap.md) | 尚未实现的能力与恢复设计 |

## 凭据与许可

state/、运行日志、环境文件和下载的隧道二进制已从 Git 排除。令牌、隧道运行密钥、数据库及其 .key 文件保留在本机；提交前仍应检查暂存区。初始化脚本不覆盖已有凭据，隧道密码窗口不保存运行密钥。

本仓库原创内容使用 MIT 许可，QQBridge 原始许可完整保存在 [UPSTREAM-LICENSE](compat/qqbridge/UPSTREAM-LICENSE)，包含上游公开署名及其原有联系信息。本项目与 QQBridge、SnowLuma 或 OpenAI 无官方关联。package.json 的 private=true 只防止误发布到 npm。

协议和产品操作参考：[MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[插件连接与刷新](https://developers.openai.com/plugins/deploy/connect-chatgpt)。工作区策略和界面变化时，以官方文档与当前实际界面为准。
