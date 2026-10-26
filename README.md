# qqbridge-dot-backend

通过 MCP 工具、MCP Events 和 Secure MCP Tunnel，将 ChatGPT Dot 接入 QQBridge / SnowLuma。

当前版本已验证真实 Dot 的事件触发，以及私聊的自动领取、读取、发送和收尾。支持按会话混合使用 Dot / DSH，也支持配置 dot.only=true，让全部显式白名单会话使用 Dot，停止创建 DSH 客户端、探活和事件流。首次接入步骤见 [接入指南](docs/dot-mcp-local.md)。

## 链路与职责

QQ 消息 → SnowLuma → QQBridge 的未读队列与唤醒策略 → 本项目的事件网关 → ChatGPT Dot。

Dot 收到事件后，通过本项目的 MCP 工具领取回合、读取消息、选择回复或沉默，并显式收尾。QQBridge 保留发送限频、白名单、静默、工具开关和观察策略。

| 组件 | 职责 |
| --- | --- |
| SnowLuma / QQ 客户端 | 接收 QQ 消息、执行 OneBot 发送；本仓库不分发 |
| 固定基线 QQBridge 适配器 | 会话归属、唤醒合并、运行租约、消息水位、发送校验、观察与潜水 |
| MCP 网关 | 六个受限工具、事件发现、订阅、签名回调、加密持久化和不确定发送隔离 |
| ChatGPT Dot | 读取上下文、判断是否回复、调用工具并结束本轮 |

Dot 工具调用通过官方私有隧道抵达本机；事件通过经过验证的 HTTPS 回调发送给 ChatGPT。本地服务不调用模型 API，也不代替真实 Dot。

## 快速开始

需要 Node.js 24、Git，以及单独安装的 QQBridge / SnowLuma。推荐使用干净的 QQBridge 副本。

~~~sh
npm ci
npm test
npm run demo
node scripts/apply-qqbridge-patch.mjs --source ../qq-bridge --check
node scripts/apply-qqbridge-patch.mjs --source ../qq-bridge
npm run setup:mcp -- --bridge-config ../qq-bridge/config.json --conversation group:123456789 --conversation private:10001
~~~

把 QQBridge 配置指向生成的专用令牌，按需启用纯 Dot 模式，然后运行 npm start。完整配置、隧道、账号和订阅步骤见 [接入指南](docs/dot-mcp-local.md)。安装器锁定 [QQBridge 基线](compat/qqbridge/baseline.json)，不修改配置或会话状态；本地源码有改动时会拒绝覆盖。

## MCP 工具与事件

| 工具 | 用途 |
| --- | --- |
| qq_get_status | 桥接状态、会话范围、逐会话订阅覆盖、发现和订阅诊断 |
| qq_list_wakes | 获取待领取唤醒的元数据 |
| qq_claim_turn | 用稳定 claimId 领取回合，返回不含凭据的上下文和 runId |
| qq_read_messages | 按水位分页读取当前回合的消息 |
| qq_send_message | 用稳定 sendId 发送本会话的一条纯文本回复 |
| qq_finish_turn | 按实际已读水位，以 replied 或 silent 收尾 |

事件 qq.wake.available 使用精确的 conversationKey 过滤，例如 group:123456789 或 private:10001。事件只含唤醒元数据，消息内容由 Dot 领取后读取。新增会话需要同时更新桥接范围、MCP 范围和 ChatGPT 事件订阅；插件元数据变动后需要在插件管理页刷新。

## 运行约束

- 同一会话同时只有一个有效回合；旧代际和过期租约不能继续发送或收尾。
- webhook 2xx 只表示 ChatGPT 接收事件，不能代替完成回合。
- 仅读取不代表确认处理；收尾只确认连续、已展示的消息水位，后续新消息继续保留。
- sendId 与内容绑定，未知发送结果必须核实，不能换新 ID 重发。外部发送不保证 exactly-once。
- 网关使用 AES-256-GCM 加密的 SQLite 保存订阅、outbox、运行引用和发送预留；密钥侧文件必须一起保管。
- QQBridge 的运行账本仍在进程内。重启后存在未收尾发送时，网关会锁定会话等待核实，不能简单删库恢复。
- 本机 HTTP 端点只接受回环 Bearer 请求；隧道 stdio 入口从本机文件读取凭据，stdout 只输出 JSON-RPC。
- 回调验证和投递要求 HTTPS、公网目的地址、固定实际连接 IP、有效 TLS 和 Standard Webhooks 签名，不跟随重定向。

目前 Dot 工具范围是纯文本读取、回复和收尾。DSH 的模型配置、完整对话历史、独立黑话研究以及图片、语音和贴纸工具未迁移为 Dot 工具。纯 Dot 模式会停用旧 DSH 学习任务。

## 验证与目录

~~~sh
npm run format:check
npm test
npm run demo
QQBRIDGE_SOURCE_DIR=/absolute/path/to/patched/qq-bridge npm run test:integration
~~~

PowerShell 先设置 $env:QQBRIDGE_SOURCE_DIR 再运行集成测试。缺少已打补丁源码时测试会失败，不会跳过。组件测试运行真实 bridge.js，QQ / DSH / 回调服务使用本地替身，不发送真实 QQ 消息。真实账号验证与测试边界见 [验证记录](docs/verification.md)，各提交的 CI 见 [GitHub Actions](https://github.com/UyNewNas/qqbridge-dot-backend/actions/workflows/ci.yml)。

| 路径 | 内容 |
| --- | --- |
| src/mcp/ | HTTP JSON-RPC、网关、SQLite 存储、回调网络与签名 |
| src/qqbridge-client.mjs | 受限本地桥接客户端，不自动重试写操作 |
| src/lifecycle.mjs | 离线生命周期模型与不变量 |
| scripts/ | 凭据初始化、服务启动、检查、stdio 入口及 Windows 隧道连接 |
| compat/qqbridge/ | 固定基线补丁、适配模块、许可及版本约束 |
| launcher/windows/ | 可选的原生管理器，统一管理进程和日志 |
| test/ | 生命周期、安装器、MCP、网络边界与真实桥接组件测试 |
| docs/ | 接入、API、验证、设计决策和后续工作 |

## 参考与许可

- [QQBridge](https://github.com/Derpyu520/qq-bridge) / [适配说明](compat/qqbridge/README.md)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [自定义 MCP 连接与元数据刷新](https://developers.openai.com/plugins/deploy/connect-chatgpt)

本仓库原创内容使用 MIT 许可，QQBridge 原始许可保存在 [UPSTREAM-LICENSE](compat/qqbridge/UPSTREAM-LICENSE)。本项目与 QQBridge、SnowLuma 或 OpenAI 无官方关联。package.json 的 private=true 只防止误发布到 npm。
