# Git 历史密钥与隐私检查

检查日期：2026-10-26。检查前已同步远端分支和标签；当时远端只有 master、没有标签或 PR，包含以下 4 个可达提交。

## 逐提交结果

| 提交 | 完整快照文件数 | 密钥扫描 | 私有运行信息检查 |
| --- | ---: | --- | --- |
| [04735f5](https://github.com/UyNewNas/qqbridge-dot-backend/commit/04735f5dd612afa738113c7071ad8f0679af3267) | 1 | 未检出 | 未发现 |
| [bd6cde4](https://github.com/UyNewNas/qqbridge-dot-backend/commit/bd6cde49aa5ae1e41fecb012da9fd2e09205743d) | 13 | 未检出 | 未发现 |
| [a7c0ddf](https://github.com/UyNewNas/qqbridge-dot-backend/commit/a7c0ddfcd6f6866ba4d682e044179c70cb8e1ef0) | 30 | 未检出 | 未发现 |
| [16c4af8](https://github.com/UyNewNas/qqbridge-dot-backend/commit/16c4af8e2bcefe4e8250e5f7ac103e2da3da244b) | 52 | 未检出 | 未发现 |

“快照”包含提交当时的完整树；同时检查历史引入和删除的内容，不只检查当前工作区。去重后覆盖 79 个文件 blob。

## 方法

1. 使用官方 Gitleaks v8.30.1 发行版，下载文件与官方发布的 SHA-256 校验值一致。
2. 默认规则扫描全部可达 Git 历史，启用完整历史选项，忽略源码内的 gitleaks:allow 注释，输出完全脱敏；结果为 4 commits scanned、no leaks found。
3. 逐个读取提交的完整快照与作者、提交者、邮箱和提交消息；检查凭据或运行产物是否曾被纳入历史。
4. 在本机内存中，额外比对实际账号标识、隧道标识、专用令牌、加密密钥表示、本机路径和可辨识聊天片段；没有将这些比对值写入报告或提交到仓库。
5. 人工复核邮箱、绝对路径、会话编号和隧道编号等候选：确认示例、测试值和公开署名来源。

未发现真实 API key、GitHub token、私钥、Dot / MCP 令牌、真实 QQ 或群号、真实隧道 ID、用户本机路径、聊天记录或运行数据库被提交。state/、运行日志、环境文件、下载工具和构建产物仍被 Git 排除。

## 仓库确实保留的公开信息

- 提交作者和版权署名使用公开 GitHub 账号及公开作者名；全部 4 个提交的作者/提交者邮箱都是 GitHub noreply 地址，没有使用私人 QQ 邮箱。
- compat/qqbridge/UPSTREAM-LICENSE 含上游原有的公开作者联系邮箱。文件与固定上游 commit 的原始 LICENSE 完整一致，保留其许可和署名信息。
- fixture@example.invalid、example.com、示例会话编号及 C:\bots 等是测试或文档示例，不是本机真实运行信息。

因此结论是未发现密钥或用户私有信息泄露，而非声称仓库中没有任何作者名、邮箱或数字。没有为此重写历史或删改上游许可证。

## 范围与后续提交

本记录覆盖检查时分支和标签可达的 Git 历史，不包含其他仓库、外部系统日志或 GitHub 内部保留但不可达的对象。检测器和人工复核不能构成对所有未知秘密的绝对保证。

本次 README 与检查记录属于后续文档提交，发布前继续扫描暂存区及新提交。实际密钥、比对种子、下载的扫描器及原始报告仅保存在被忽略的本机目录，不进入仓库。
