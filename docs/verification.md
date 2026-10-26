# 验证记录与边界

## 环境

- 日期：2026-10-26。
- 本轮本地：Windows，Node.js 24；原有 Linux 记录与每次远端执行结果以 [GitHub Actions](https://github.com/UyNewNas/qqbridge-dot-backend/actions/workflows/ci.yml) 为准。
- 固定 QQBridge 基线：Derpyu520/qq-bridge@a49877f4e58d04e47532d44b803360d0f001160d。

## 可重复执行的验证

本轮整理后已在 Windows / Node.js v24.15.0 执行：53 项单元测试、7 项固定基线组件集成测试全部通过；干净基线的补丁预检、安装与重复安装通过；离线示例和原生管理器自检通过。

| 检查 | 入口 | 覆盖 |
| --- | --- | --- |
| 格式 | npm run format:check | 新增 MCP 运行代码、入口与测试 |
| 单元和安装器 | npm test | 租约、水位、幂等、权限、加密状态、回调地址、元数据诊断、安装回滚 |
| 离线示例 | npm run demo | 新消息保留、沉默与迟到完成拒绝 |
| 固定基线安装 | patch:check / patch:apply / 重复 apply | 干净基线、overlay 安装、重复安装识别 |
| 组件集成 | QQBRIDGE_SOURCE_DIR 指向已适配源码后运行 npm run test:integration | 真实 bridge.js、HTTP MCP、签名 Events、领取/读取/发送/收尾、未知发送、纯 Dot 无 DSH 调用 |
| Windows 管理器 | --self-test | 隐藏进程、UTF-8 输出、退出码、停止和子进程树清理 |

组件测试隔离了真实 QQ、SnowLuma SDK、DSH 和 webhook 接收端，运行真实 QQBridge 入口及本地模块。缺少源码或补丁会失败，不会跳过。HTTP MCP 同时经过官方 MCP SDK 客户端互操作验证；stdio 入口也有协议转发测试。

CI 在 Linux / Windows 运行单元测试，在 Linux 的固定上游源码上执行安装器预检、实际安装、重复安装和组件集成，并在 Windows 构建管理器和运行进程生命周期自检。具体提交是否通过以对应 CI 记录为准。

## 已完成的真实账号联调

以下记录来自一套实际 SnowLuma + QQBridge + ChatGPT Dot 环境，账号、群号、密钥、回调地址和原始日志不进入仓库：

1. 私有 Secure MCP Tunnel 已发现六个工具和 qq.wake.available。
2. 群事件通过签名回调被接受，用户确认该事件实际触发 Dot 处理。
3. Dot 已通过同一私聊 wakeId 领取、读取、发送并显式收尾，发送状态 confirmed、finished=true。
4. 更新事件范围并刷新插件后，群聊和私聊的两条精确订阅均生效，没有重复建任务。
5. 新私聊自动生成事件，首次投递成功；Dot 自动领取，QQ 发送成功一条，并完成收尾。该轮从收到消息到确认发送约 59 秒，不作为延迟承诺。
6. 切为纯 Dot 后，DSH 端口停止监听；QQBridge 报告 backend=dot，QQ 在线，隧道正常。

真实联调使用的是保留用户其他本地改动的 QQBridge 安装。固定基线补丁另行通过组件测试；本记录不声明其他 QQBridge 版本、账号、网络环境或未迁移工具已兼容。

## 尚未验证或未实现

- 所有故障场景下的真实平台重投和账号撤销行为；当前以组件测试覆盖相关边界。
- 多机器、多进程或多用户部署；当前为单机私有连接。
- QQBridge 内存运行账本的完整重启恢复；网关只保留可核实引用和不确定发送隔离。
- Dot 图片、语音、贴纸工具，以及 DSH 对话历史和独立研究任务迁移。
- 对外部 QQ 发送提供 exactly-once 保证。
