# QQBridge 适配验证记录

- 日期：2026-10-25
- 本地环境：Node.js v24.22.1，Linux
- 适配基线：`Derpyu520/qq-bridge`，提交 `a49877f4e58d04e47532d44b803360d0f001160d`
- 本仓库运行和测试代码使用 Node.js 标准库；组件集成测试通过明确的替身隔离外部 SDK、DSH 和 QQ 服务。

本记录区分本地单元测试、真实 QQBridge 源码的组件集成测试和真实服务联调。下表记录本轮已实际执行的本地验证；每个提交的远端验证以 [GitHub Actions](https://github.com/UyNewNas/qqbridge-dot-backend/actions/workflows/ci.yml) 为准。

## 本轮执行结果

| 验证项 | 命令或操作 | 结果 |
| --- | --- | --- |
| 离线单元测试 | `npm test` | **PASS：33 tests / 33 pass / 0 fail / 0 skipped** |
| 补丁预检 | `node scripts/apply-qqbridge-patch.mjs --source "$QQBRIDGE_SOURCE_DIR" --check` | **PASS**：在固定基线源码上完成预检 |
| 实际补丁安装 | `node scripts/apply-qqbridge-patch.mjs --source "$QQBRIDGE_SOURCE_DIR"` | **PASS**：完成补丁及 overlay 安装 |
| 同版本重复安装 | 再次执行上述安装命令 | **PASS**：明确返回 `already-applied` |
| 离线演示最终复跑 | `npm run demo` | **PASS**：新消息保留、沉默收尾和迟到完成拒绝均正常 |
| QQBridge 组件集成 | 设置指向已安装补丁源码的绝对路径 `QQBRIDGE_SOURCE_DIR`，执行 `npm run test:integration` | **PASS：5 tests / 5 pass / 0 fail / 0 skipped** |
| GitHub Actions | `offline` 和 `qqbridge-integration` 两个 job | 工作流已配置；具体提交结果见上方 Actions 链接 |

本轮最终补丁安装和组件测试目标为本地 `qqbridge-integration-final` 副本，不写用户的 QQBridge 配置或状态。安装后的两个生产文件已与交付源码逐字比对一致，Git blob 摘要记录于 [baseline.json](../compat/qqbridge/baseline.json)。最终集成测试必须使用已安装补丁和 overlay 的源码目录；缺失 `QQBRIDGE_SOURCE_DIR`、缺失源码或未应用补丁都会使测试失败，不会以跳过代替验证。

`npm test` 显式运行 `test/*.test.mjs`，使用 Node 内置测试运行器及 `--test-isolation=none`。它不包含需要源码目录和本地监听端口的集成测试。

## 已通过的 33 项单元测试

| 测试文件 | 数量 | 核实的行为 |
| --- | ---: | --- |
| `test/lifecycle.test.mjs` | 11 | 单会话单运行；事件确认与运行完成分离；代际和租约隔离；显式连续已读水位；思考期间的新消息保留；发送预留、幂等及未知结果；明确的回复或沉默完成；旧完成回执不能清除新运行 |
| `test/dot-backend.test.mjs` | 12 | 排队不消耗运行租约；领取重试和恢复回执；分页不能越过未读消息；完成重放；过期与实际发送前的校验；并发发送去重；未知发送阻止换 ID 重发或成功完成；同步失败收束；沉默后等待宿主观察条件；运行和传输凭据不能作为 QQ 文本发出；被中断的运行和零未读观察状态可以恢复 |
| `test/patch-installer.test.mjs` | 8 | 只读预检和重复安装；源码漂移；缺失或不适用的补丁；overlay 冲突与不完整安装；越界补丁拒绝；写入故障回滚；符号链接和安装锁；Git checkout 提交不匹配 |
| `test/qqbridge-client.test.mjs` | 2 | 凭据只发送到允许的 loopback 目标并拒绝重定向；不静默重试不确定发送，不替换调用者的幂等键 |

这些测试验证当前进程内的协议和失败处理，不证明跨进程互斥、重启恢复或外部发送 exactly-once。

## 组件集成测试的边界

集成 harness 复制并启动**实际打过补丁的上游 `src/bridge.js` 及其本地模块**，运行真实 HTTP 路由、认证、QQBridge 状态机和 Dot overlay。Node.js 24 的 loader 仅替换 `@snowluma/sdk`、`js-yaml` 和 `dsh-client.js`。OneBot 目标是本地测试 HTTP 服务，可以记录发送和模拟服务已经收到消息、响应却丢失的情况。

已通过的 5 项组件测试覆盖以下场景：

1. DSH 离线时，Dot 会话能够合并唤醒、发送、保留处理中新增消息、沉默收尾；另一个由 DSH 托管的群继续使用原分支。
2. 真实路由上的认证、跨站访问、跨会话访问、DSH 旧工具入口及暂停状态不能绕过权限。
3. 租约过期产生替代运行后，迟到的完成请求不能清除新运行。
4. OneBot 已收到消息但回执丢失时，发送成为未知结果，重复调用不会再次派发。
5. 切出再进入 `reserved2`、暂停再恢复时，旧运行失效，新运行无需新消息即可唤醒；沉默完成后的观察状态在零未读、无限潜水、没有睡眠定时器且关闭主动检查时也能恢复。

这些测试没有连接真实 QQ、NapCat 或 ChatGPT Dot，也没有启动 MCP 服务。HTTP 和宿主状态机真实运行，不等于外部服务端到端联调完成。潜水前观察使用宿主的真实判断入口；其真实群聊时序和原版行为兼容仍需后续联调确认。

## CI 配置与真实服务待验证项

工作流已配置两个独立 job：离线 job 使用 Node.js 24 执行 `npm test` 和 `npm run demo`；组件集成 job 检出上述固定 QQBridge 提交，依次执行补丁预检、安装、重复安装，再以绝对路径 `QQBRIDGE_SOURCE_DIR` 执行 `npm run test:integration`。Actions 使用固定完整提交 SHA。组件测试通过 loader 隔离外部依赖，不安装或启动真实 QQBridge 外部服务。

CI 的执行结果按提交记录在 Actions 中；它与以上本地记录覆盖相同层次的验证。仍未完成的能力和验证包括：

- 真实 QQ 发送、真实 Dot 调度及二者的端到端联调。
- 远程 MCP 服务、MCP 认证、订阅及 MCP Events 投递；本仓库的本地 HTTP 契约不是 MCP 实现。
- 运行、领取、发送和完成回执的持久化，跨进程互斥及进程重启后的恢复。
- 真实群聊中的观察期、模式切换及长期定时行为兼容验证。
- 其他 QQBridge 提交或发行版的兼容性；当前补丁安装器只接受明确校验过的固定基线。

未知发送保持为待核实状态，不自动重发；当前没有面向真实外部服务的发送结果核实流程。进程内测试通过不能推出外部 exactly-once 保证。
