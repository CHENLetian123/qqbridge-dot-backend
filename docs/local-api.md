# 已实现的本地 API v1

路径前缀：`/api/dot/v1`。本接口运行在 QQBridge 原控制台的回环 HTTP 服务器上，供同机的后续 MCP 服务调用。它不是 MCP 协议端点。

每次请求均需 `Authorization: Bearer <Dot专用token>`。POST 使用 `Content-Type: application/json`，请求体上限 64 KiB。Host、远端地址及 Origin 必须符合回环访问约束；不接受跨站请求，不启用 CORS。Bearer 不授予控制台管理权限。

## 请求表

| 方法与相对路径 | 请求内容 | 返回与行为 |
| --- | --- | --- |
| `GET /health` | 无 | 协议版本、内存存储标记、配置会话数量 |
| `GET /wakes` | 无 | 可领取的 `wakes`；不开始运行租约 |
| `POST /runs/claim` | `wakeId`, `claimId` | `run`, `context`, `readThroughSeq`, 恢复回执；领取时开始租约 |
| `POST /runs/{runId}/read` | `runToken`, `afterSeq`（默认 0）, `limit`（默认 30） | `messages`, `readThroughSeq`, `unreadCount` |
| `POST /runs/{runId}/send` | `runToken`, `sendId`, `text`, 可选 `replyToMessageId` | `send` 回执与是否为重复请求 |
| `POST /runs/{runId}/finish` | `runToken`, `throughSeq`, `outcome` | 完成回执与观察状态 |

首版没有 heartbeat、任意群号转发、管理员工具或外部回调 URL 参数。默认运行租约为 120 秒，可在配置中设为 100–900000 毫秒；实际联调不宜照搬测试使用的极短租约。

## 领取与上下文

待领取唤醒包含：

```json
{
  "wakeId": "opaque-id",
  "key": "group:123456789",
  "reason": "atMention",
  "createdAt": 1792929600000
}
```

领取请求必须有稳定 `claimId`。同一 `claimId` 和 `wakeId` 在该运行仍有效时返回同一个运行；换成另一个唤醒则拒绝。不能通过更换领取 ID 在同一会话并行开启第二个运行。

`run` 包含 `key`, `runId`, `runToken`, `generation`, `expiresAt`。后续操作同时需要全局 Bearer 和当前运行凭据，跨会话或旧代际凭据会被拒绝。`context` 包含角色、环境、记忆、当前时间和唤醒配置，不包含原 QQBridge agent token，也不把未读消息原文塞进领取响应；消息通过 `read` 获取。

领取及重复领取都会返回 `uncertainSends` 与 `previousSends`，帮助识别前一轮未完成任务的发信结果。这些记录不代表已经解决了不确定发送。

## 分页读取

第一次从 `afterSeq: 0` 读取。随后把上一页 `readThroughSeq` 作为游标继续读取，`limit` 为 1–100。服务端不允许跳过尚未展示的消息。

`seq` 是 QQBridge 会话内序号，`messageId` 是 QQ 消息标识。两者不能替换。正文使用上游缓冲保存的文本，可能包含上游既有截断；需要尾部时返回 `tail`。当前没有媒体内容读取接口。

读取只记“该运行看到了哪些消息”，不会确认已处理。`finish.throughSeq` 必须显式提供，且不能超过当前运行已展示的连续水位。思考期间后来进入队列的消息不会被旧水位清除。

## 发送与不确定回执

`text` 是一条纯文本，具体长度仍受 QQBridge 发送配置限制。可选 `replyToMessageId` 为非零整数的字符串；服务端继续验证引用属于当前会话。

`sendId` 在会话内标识一个逻辑发送。重试保留 ID 和相同正文、引用目标。相同 ID 配不同载荷返回冲突；同 ID 的并发请求也只派发一次。成功发言不会自动完成运行。

| `send.status` | 含义 | 后续处理 |
| --- | --- | --- |
| `confirmed` | 原发送路径确认完整发送一条消息 | 可继续读取或以 `replied` 完成 |
| `rejected` | 明确在派发前被拒绝 | 检查限频、权限或参数；该发送 ID 的回执不会自动变成新的发送 |
| `unknown` | 请求可能已送达，但无法确认结果 | 同 ID 查询返回既有状态；禁止换 ID 重新派发，也禁止继续确认消息 |

API 的 `ok: true` 表示成功处理回执查询，**不等于 QQ 发送成功**；调用方必须检查 `send.status`。HTTP/网络异常发生时也不能假定“没发出去”。Node 客户端不会自动重试写操作。

QQBridge 原有白名单、暂停、静默、工具开关、正文检查和限频仍在实际发送路径中执行。排队等待后真正派发前，再次检查原运行凭据；不能把旧请求放到后来创建的新运行名下。

## 完成、观察与恢复

`outcome` 为 `replied` 或 `silent`：前者要求本轮至少有一条确认发送，后者不能隐藏已确认的本轮发言。明确拒绝且未派发的尝试不算成功发言。在途或不确定发送阻止成功收尾。

同一运行、同样参数的完成请求可重放既有回执，不会清掉下一轮运行；冲突参数被拒绝。重置、撤销权限或模式切换产生的新代际会拒绝旧凭据。

完成后运行释放。若潜水前观察尚未满足，观察由本机桥接继续执行；不伪造已观察标记，不占用一个长时间阻塞的 Dot 工具调用。观察期间来信会经原合并窗口安排唤醒。初版沿用已有唤醒配置，不提供模型随意修改 wake-config 的 API。

租约到期保留未确认消息，最多进行 3 次连续自动重试；之后等待新触发或操作者检查。暂停或离开 `reserved2` 撤销旧运行，恢复时重新调度中断的处理或观察。发送结果不明时的对账仍待实现，不能通过重启来声称问题已解决。

## 错误与存储边界

错误响应形如：

```json
{"ok":false,"error":{"code":"STALE_RUN","message":"This run has ended or expired."}}
```

常见类别：401 凭据缺失；403 范围/权限错误；400 游标或参数错误；409 幂等冲突或未解决发送；410 过期运行或代际；503 容量限制。具体 QQBridge 拒绝可能使用原有状态码。

本实验不删除发送去重记录来腾空间；内存最多保存 2048 个运行与 8192 次发送预留，达到限制后拒绝新增操作。运行、claim 和发送账本只在该进程内有效。持久化、崩溃恢复、明确对账、跨进程互斥以及生产用记录保留策略均属于下一阶段。
