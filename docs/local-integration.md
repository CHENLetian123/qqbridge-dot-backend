# 本地 QQBridge 适配与联调

本补丁提供本机 QQBridge 的后端接口。MCP 网关、隧道和真实 Dot 订阅步骤见 [接入指南](dot-mcp-local.md)；应用补丁本身不会自动创建 ChatGPT 订阅。

## 1. 准备固定版本副本

需要 Node.js 24、Git，以及 QQBridge 原有运行依赖。本补丁让选定会话在 DSH 服务离线时工作，但没有删除 QQBridge 的 DSH npm 包依赖。

建议在源码副本中试用。唯一基线为：

```text
Derpyu520/qq-bridge@a49877f4e58d04e47532d44b803360d0f001160d
```

若重新 clone，可关闭工作区自动换行转换，避免 Windows 的 CRLF 转换改变受校验的原始字节：

```sh
git clone -c core.autocrlf=false https://github.com/Derpyu520/qq-bridge.git qq-bridge-dot-test
git -C qq-bridge-dot-test checkout --detach a49877f4e58d04e47532d44b803360d0f001160d
```

既有安装若源码有本地修改，安装器会拒绝覆盖；不要为了让检查通过而丢弃自己的改动。先保留原实例，再建立固定版本的干净副本。

## 2. 检查并应用

先停止目标 QQBridge。在本仓库目录执行，替换 `--source` 为 QQBridge 副本的路径：

```sh
node scripts/apply-qqbridge-patch.mjs --source ../qq-bridge-dot-test --check
node scripts/apply-qqbridge-patch.mjs --source ../qq-bridge-dot-test
```

安装器检查 commit（存在 `.git` 时）与 `src/bridge.js` 的 blob SHA，先在临时副本应用补丁，再发布三个文件：

- `src/bridge.js`
- `src/dot-backend.mjs`
- `src/dot-only-policy.mjs`

`--check` 不写目标目录。完整重复安装返回 `already-applied`；不同模块、版本漂移或不完整安装会失败。安装出错时尝试回滚已写文件，回滚失败会报告备份目录。此机制不保证断电或强制终止时的多文件事务原子性。

安装器不修改用户配置和群聊状态。需要撤回时，在停止实例后恢复基线 `src/bridge.js` 并移除本补丁添加的两个 overlay 模块；保留自己的配置和状态备份，不要执行整目录清理。

## 3. 专用凭据与会话归属

在 **QQBridge 副本目录** 创建专用 token 文件。下面的命令只写文件，不打印凭据，也不会覆盖已有文件：

```sh
node -e "const fs=require('node:fs');fs.mkdirSync('state',{recursive:true});fs.writeFileSync('state/dot-api-token',require('node:crypto').randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});"
```

把下面的 `dot` 字段合并进既有 `config.json`，不要覆盖其他配置。群号是示例，需要替换为自己的测试群，并继续满足原有 `allow.groups` 白名单。

```json
{
  "dot": {
    "enabled": true,
    "conversations": ["group:123456789"],
    "tokenFile": "state/dot-api-token",
    "leaseMs": 120000
  }
}
```

会话列表在进程启动时确定，变更后重启生效。Dot 会话不会因接口故障自动回退 DSH；其他会话保留原有 DSH 路径。若配置 `dot.only=true`，启动时改为从显式白名单派生全部会话，并关闭 DSH 客户端、探活、模式同步和事件流。测试时只启动负责该账号的一个桥接实例。

当前仅支持 `reserved2` / `simulation` 模式。纯 Dot 模式固定使用此流程；混合模式在 DSH 离线时启动，需要本地 `state/mode.json` 已保存：

```json
{"mode":"reserved2"}
```

补丁仍遵守原有模式切换、暂停、启用开关、白名单、工具开关、静默与限频。切出模式或暂停会撤销运行；恢复时重新安排被中断的处理与观察。

## 4. 使用本地客户端

客户端运行在与 QQBridge 同机的进程中。以下片段只查询健康和待领取唤醒；不会领取任务、确认已读或发 QQ 消息：

```js
import fs from 'node:fs';
import { QQBridgeClient } from './src/qqbridge-client.mjs';

const client = new QQBridgeClient({
  baseUrl: 'http://127.0.0.1:3100', // 替换为 QQBridge 实际控制台端口
  token: fs.readFileSync('/path/to/qq-bridge/state/dot-api-token', 'utf8').trim(),
});

console.log(await client.health());
console.log(await client.listWakes());
```

完整接口见 [local-api.md](local-api.md)。原控制台 token、QQBridge agent token 和 Dot 专用 token 是不同用途的凭据；Dot 本地 API 不能使用控制台 token 代替认证。

## 5. 当前支持程度

已实现领取、逐页读取未读、发送一条纯文本或图片（可选引用），读取消息图片、幂等发送回执、显式完成、租约恢复和桥接侧观察。人设、环境说明、群记忆和时间信息在每轮领取时提供，不依赖 DSH 长对话历史。

完成只确认本轮实际读取的消息前缀。新的消息保留到下一轮；正常沉默也能完成。观察期间新消息仍经原有合并与限频规则唤醒；满足真实观察条件后恢复现有唤醒配置。

当前不开放任意 wake-config 编辑、语音、独立贴纸库或管理操作，也不迁移 DSH 完整历史。运行账本和发送回执尚未持久化；进程重启不能恢复它们。发生 `unknown` 发送时，新发送和继续确认消息会被阻止，等待后续明确的对账恢复功能，不能靠换一个 `sendId` 重发。

这是一版用于开发联调的适配层。真实 QQ、SnowLuma 安装、Dot 调度、MCP 认证与事件投递需分别验证。

0.4.0 图片接口与 ChatGPT 文件参数接入见 [图片指南](images.md)。
