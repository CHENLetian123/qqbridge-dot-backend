# QQBridge 兼容与适配状态

## 当前状态

**状态：`reviewed-only`，未验证运行兼容。目前没有可应用的 QQBridge patch。** 本目录记录源码基线、必要适配边界和验收条件，不是安装完成说明。

- 检查日期：2026-10-25
- 上游：[`Derpyu520/qq-bridge`](https://github.com/Derpyu520/qq-bridge)
- 固定 commit：[`a49877f4e58d04e47532d44b803360d0f001160d`](https://github.com/Derpyu520/qq-bridge/tree/a49877f4e58d04e47532d44b803360d0f001160d)
- 机器可读记录：[baseline.json](./baseline.json)
- 本项目当前仅有离线生命周期原型；真实 MCP/Events、上游适配补丁、真实 QQ/Dot 联调尚未实现。

本记录不表示支持该 commit 之前或之后的任何发行版。更换上游版本必须重新检查边界并运行集成验证；文件 blob SHA 不能用作仓库 commit。

## 现有接口为什么不足

`reserved2` 收到消息后会先入库、判断触发条件并合并唤醒，但最终投递仍进入 DSH 的 `ensureSession()` 和 `api.sessions.prompt()`。回合开始/结束通过 DSH 事件更新忙碌状态、清理待唤醒标记并处理无行动兜底。

现有 `/api/socialV2/wake` 仍要求桥接唤醒 DSH；暂停二代模式又会禁止 agent 工具调用。因此既不能只改 `dsh.provider`，也不能暂停原后端后直接用管理接口轮询，来获得完整的 Dot 后端语义。

回发接口可复用现有业务规则，但它们要求会话 token、`reserved2`、白名单、启用状态和限频。已检查的发送校验没有“必须存在活跃 DSH turn”这一硬要求；实际耦合主要在会话 policy、mapping 和生命周期管理。

## 必要适配点

| 边界 | 必须完成的改动 |
|---|---|
| 后端归属 | 按会话选择 DSH 或 Dot，并带绑定代际；同一唤醒只交给一个后端 |
| 唤醒投递 | 为 Dot 增加独立的就绪、投递与接受处理；不经过 DSH preset 或会话创建逻辑 |
| 回合收尾 | 提供显式完成/失败回执，清理对应运行的忙碌状态，处理积压原因；超时租约只负责异常恢复 |
| 会话范围 | 保留 agent 身份和会话 token；把 policy 中的 DSH 专用身份改成对应后端的有效代际 |
| 已读确认 | 按已展示的连续 `readThroughSeq` 确认；拒绝跳过未展示消息，拒绝旧运行清除新消息 |
| 观察与潜水 | 让本地计时器继续观察，在满足条件后安排潜水或下一次唤醒；不得直接删除观察门 |
| 出站动作 | 沿用发送检查和记录，增加运行/发送幂等键；支持不发消息的正常完成 |

以上是拟定的适配要求，不是上游已提供的扩展 API。正式补丁应锁定 commit、在基线不匹配时停止应用，并保留 DSH 原有路径。

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
