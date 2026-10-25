# QQBridge 兼容与适配状态

## 当前状态

**状态：实验性适配已实现，提供固定基线补丁和安装器。组件测试运行真实桥接程序，外部 QQ / DSH 使用本机替身；真实 QQ / Dot 兼容性仍未验证。**

- 检查日期：2026-10-25
- 上游：[`Derpyu520/qq-bridge`](https://github.com/Derpyu520/qq-bridge)
- 固定 commit：[`a49877f4e58d04e47532d44b803360d0f001160d`](https://github.com/Derpyu520/qq-bridge/tree/a49877f4e58d04e47532d44b803360d0f001160d)
- 机器可读记录：[baseline.json](./baseline.json)
- 补丁：[qqbridge-dot.patch](qqbridge-dot.patch)
- 随补丁安装的模块：[overlay/src/dot-backend.mjs](overlay/src/dot-backend.mjs)
- 安装步骤：[本地联调](../../docs/local-integration.md)
- 实际接口：[本地 API v1](../../docs/local-api.md)
- 真实 MCP/Events、运行账本持久化及真实 QQ/Dot 联调尚未完成。

本记录不表示支持该 commit 之前或之后的任何发行版。更换上游版本必须重新检查边界并运行集成验证；文件 blob SHA 不能用作仓库 commit。

## 现有接口为什么不足

`reserved2` 收到消息后会先入库、判断触发条件并合并唤醒，但最终投递仍进入 DSH 的 `ensureSession()` 和 `api.sessions.prompt()`。回合开始/结束通过 DSH 事件更新忙碌状态、清理待唤醒标记并处理无行动兜底。

现有 `/api/socialV2/wake` 仍要求桥接唤醒 DSH；暂停二代模式又会禁止 agent 工具调用。因此既不能只改 `dsh.provider`，也不能暂停原后端后直接用管理接口轮询，来获得完整的 Dot 后端语义。

回发接口可复用现有业务规则，但它们要求会话 token、`reserved2`、白名单、启用状态和限频。已检查的发送校验没有“必须存在活跃 DSH turn”这一硬要求；实际耦合主要在会话 policy、mapping 和生命周期管理。

## 补丁覆盖的边界

| 边界 | 必须完成的改动 |
|---|---|
| 后端归属 | 按会话选择 DSH 或 Dot，并带绑定代际；同一唤醒只交给一个后端 |
| 唤醒投递 | 为 Dot 增加独立的就绪、投递与接受处理；不经过 DSH preset 或会话创建逻辑 |
| 回合收尾 | 提供显式完成/失败回执，清理对应运行的忙碌状态，处理积压原因；超时租约只负责异常恢复 |
| 会话范围 | 保留 agent 身份和会话 token；把 policy 中的 DSH 专用身份改成对应后端的有效代际 |
| 已读确认 | 按已展示的连续 `readThroughSeq` 确认；拒绝跳过未展示消息，拒绝旧运行清除新消息 |
| 观察与潜水 | 让本地计时器继续观察，在满足条件后安排潜水或下一次唤醒；不得直接删除观察门 |
| 出站动作 | 沿用发送检查和记录，增加运行/发送幂等键；支持不发消息的正常完成 |

这些接口由本补丁提供，不是原版上游已有的扩展 API。安装器锁定 commit 与原文件 SHA，在基线不匹配时停止应用。会话归属采用静态配置，进程重启后生效；首版只开放纯文本读取、发送与收尾，观察后沿用已有唤醒配置，不开放任意 wake-config 修改。

旧 DSH 工具面不能用当前或旧 agent token 访问 Dot 会话；只有内部固定发送代理携带有效运行身份时可以复用原发送路由。模式切换、暂停、会话重置和权限变化撤销旧运行，恢复时重新安排被中断的工作。固定管理命令回执仍保留原模式与白名单限制。

源码补丁涉及的原始许可见 [UPSTREAM-LICENSE](UPSTREAM-LICENSE)。本项目未分发 SnowLuma 源码或二进制。

## 源码定位

下面的行号仅帮助阅读本次固定基线，不是补丁匹配规则。正式适配应依据函数及行为验证。

| 范围 | 固定基线来源 |
|---|---|
| 消息入库及唤醒触发 | [`bridge.js` 10974–10997](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L10974-L10997) |
| DSH 投递 | [`bridge.js` 9111–9193](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L9111-L9193) |
| busy 判断 | [`bridge.js` 10524–10569](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L10524-L10569) |
| DSH 回合结束收尾 | [`bridge.js` 11455–11539](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L11455-L11539) |
| 发送授权和限频 | [`bridge.js` 5242–5328](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L5242-L5328) |
| 真实发送前守卫 | [`bridge.js` 8034–8048](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L8034-L8048) |
| 观察条件判断 | [`bridge.js` 8338–8366](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L8338-L8366) |
| 标读、潜水时的观察门 | [`bridge.js` 4782–4824](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L4782-L4824)、[4917–4968](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/bridge.js#L4917-L4968) |
| 本地 stdio MCP 与调用身份 | [`mcp-snowluma-safe.js`](https://github.com/Derpyu520/qq-bridge/blob/a49877f4e58d04e47532d44b803360d0f001160d/src/mcp-snowluma-safe.js) |

## 集成验收

以下项目全部通过后，才可将某一固定基线标记为已验证兼容：

1. 一个会话由 Dot 接管后，DSH 不再消费该会话的唤醒；其他会话仍按原后端运行。
2. 一次合并唤醒只创建一次有效运行；重复事件和发送重试不重复发 QQ 消息。
3. 模型只获取当前会话上下文；处理期间新到的消息保持未读，旧回执不能确认它们。
4. 发言完成和决定不插话都能释放本轮运行，随后可以再次唤醒。
5. 任务结束后观察计时继续生效；窗口内新消息、有限睡眠到期和主动唤醒均不丢失。
6. 超时、连接中断、后端切换和迟到回执能恢复，且不让旧运行覆盖当前状态。
7. 白名单、暂停、静默、工具开关、限频及真实发送前检查仍有效。

离线模拟通过只能说明本项目协议和状态机的测试结果。QQBridge 补丁测试、真实 MCP/Events 接入以及真实 QQ/Dot 联调必须分别记录证据，不能互相代替。
