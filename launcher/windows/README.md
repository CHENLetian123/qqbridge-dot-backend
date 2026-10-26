# Windows 管理器

可选的原生 WinForms 管理器，用于在同一窗口启停 SnowLuma、QQBridge 和 Dot MCP，并查看日志。子进程不单独打开终端；Windows Job Object 负责停止进程树。

需要 .NET 10 SDK 构建，运行机器需要 .NET 10 Desktop Runtime；Node.js 24 必须在 PATH 中。

```powershell
.\launcher\windows\build.ps1
$env:QQB_BRIDGE_DIR = 'C:\bots\qq-bridge'
$env:QQB_DOT_BACKEND_DIR = (Get-Location).Path
& '.\launcher\windows\publish\GPTBot管理器.exe'
```

管理器也可以放在同时包含 `qq-bridge` 和本仓库的父目录；后端目录通过 package.json 的包名识别，不要求特定检出目录名。SnowLuma 目录可通过 `QQB_SNOWLUMA_DIR` 指定。

QQBridge 配置 `dot.only=true` 时，管理器只展示 SnowLuma、QQ Bridge、Dot MCP，一键启动不会等待或启动 DSH，桥接和 MCP 异常退出后可自动重启。混合模式保留兼容的 DSH 服务项。

“接入状态”逐会话显示订阅覆盖情况。MCP 服务已启动不代表 Secure MCP Tunnel 已连接；隧道由官方 tunnel-client 管理，重连方式见 [接入说明](../../docs/dot-mcp-local.md)。关闭管理器会停止它启动的服务；外部实例只显示端口状态，不能由它停止。

构建后可运行 `GPTBot管理器.exe --self-test`，检查隐藏进程启动、UTF-8 输出、退出码和子进程清理；结果写入程序旁的 manager-test-result.txt，文件不提交。
