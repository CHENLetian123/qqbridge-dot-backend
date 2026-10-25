# qqbridge-dot-backend

为 QQBridge 的 `reserved2` 仿真群友模式接入 ChatGPT Dot 的实验项目。

**当前阶段：接入设计与离线生命周期原型。尚未实现远程 MCP 服务、MCP Events 投递或 QQBridge 适配补丁，也没有完成真实 QQ / Dot 联调。不能直接替换 DeepSeek Harness。**

## 为什么单独建仓库

QQBridge 继续管理 QQ 消息、群聊状态与触发策略；本项目负责 Dot 的事件接入、受限工具和任务回执。这样可以分别跟进 QQBridge 与 ChatGPT MCP 协议的更新。

独立仓库仍需要对 QQBridge 做版本绑定的适配。当前上游的唤醒、会话与运行结束处理依赖 DSH；仅调用现有 HTTP 接口不足以完整接管 `reserved2`。必要时可用一个 QQBridge fork 承载补丁，但 Dot 的主要逻辑保留在本仓库。

完整决策见 [ADR 0001](docs/decisions/0001-independent-backend.md)，检查过的上游版本与改动边界见 [QQBridge 适配说明](compat/qqbridge/README.md)。

## 职责分工

| 部分 | 目标职责 | 初版状态 |
| --- | --- | --- |
| 用户现有 SnowLuma / QQ 客户端 | QQ 消息接入与发送 | 不在本项目中分发或配置 |
| QQBridge `reserved2` | 消息序号、群状态、唤醒合并、观察与潜水策略 | 已审阅上游；适配补丁待实现 |
| 本项目生命周期核心 | 会话归属、运行租约、已读水位、发送回执、显式收尾 | 离线内存原型 |
| 本项目 MCP 层 | 按会话受限的 QQ 工具、订阅与事件投递 | 待实现 |
| ChatGPT Dot | 读取上下文、决定是否发言、调用工具并结束本轮 | 待真实联调 |

目标流程：QQBridge 合并一次唤醒，本项目将事件交给已订阅的 Dot；Dot 通过工具读群聊、选择发言或沉默，最后显式结束这一轮。消息在思考期间继续入库，下一轮处理尚未确认的部分。

## 运行初版

需要 Node.js 24 或更高版本。当前没有第三方运行依赖，不需要 API key。

```sh
npm test
npm run demo
```

这两条命令只运行本地状态机和模拟场景，不连接网络、不读真实群消息，也不向 QQ 发送内容。`package.json` 的 `private: true` 仅防止误发布到 npm，与 GitHub 仓库可见性无关。

## 原型要验证什么

- 同一个会话同一时刻只有一个有效运行；重新绑定后，旧代际不能继续写入。
- 事件已接收与 Dot 已完成是两件事。收到 webhook `2xx` 不能释放整个运行。
- Dot 读到的消息水位与它确认处理的水位明确区分，思考期间新来的消息不会被整批清掉。
- 发言和回合结束分别确认。选择沉默也能正常结束，不能依赖“发了一条消息”来清除忙碌状态。
- 每次发送有稳定的 `sendId`；结果不明时保留不确定状态，不盲目重发。原型不保证外部系统的 exactly-once 发送。
- 运行租约到期后可以恢复；旧运行迟到的完成请求不能清掉新运行。

原型只把状态保存在进程内。重启恢复、持久化事务、真实授权和跨进程并发控制都属于后续工作，不能把它作为生产服务暴露出去。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/lifecycle.mjs` | 离线生命周期核心 |
| `test/lifecycle.test.mjs` | 水位、租约和回执等行为测试 |
| `examples/offline-demo.mjs` | 模拟唤醒、读取、发送与收尾 |
| [contracts/protocol.md](contracts/protocol.md) | 拟定的接入契约与不变量 |
| [compat/qqbridge/](compat/qqbridge/README.md) | 上游基线、适配位置和兼容性状态 |
| [docs/roadmap.md](docs/roadmap.md) | 实施顺序与验收标准 |
| [docs/verification.md](docs/verification.md) | 实际执行的验证与尚未验证的范围 |

## Dot 接入约束

依据 2026-10-25 检查的官方文档，Dot 可通过自定义 MCP 插件订阅 MCP Events。插件需要可访问的 MCP 端点，并完成服务发现、订阅、webhook 验证与签名。事件接收成功后仍是异步处理；文档没有在该协议中提供一条可直接替代 DSH `turn/end` 的完成通知。因此，本项目拟提供应用层收尾工具，并辅以租约恢复。

后续实现必须重新核对届时的官方协议与账号能力。这里的应用层工具名、字段和状态机是本项目的设计，不是 OpenAI 或 QQBridge 已有的标准接口。

## 参考

- [QQBridge](https://github.com/Derpyu520/qq-bridge)
- [已审阅的 QQBridge commit](https://github.com/Derpyu520/qq-bridge/commit/a49877f4e58d04e47532d44b803360d0f001160d)
- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [连接自定义 MCP 插件](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Dot 持续指令与控制](https://learn.chatgpt.com/docs/dots/controls)

MIT 许可适用于本仓库的原创内容。本项目与 QQBridge、SnowLuma 或 OpenAI 无官方关联；第三方源码或补丁若后续纳入，应保留相应许可声明。
