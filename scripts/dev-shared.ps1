<#
.SYNOPSIS
  启动 Percho 开发版，**使用真实用户数据**（等同安装版 / CLI 的数据）。

.DESCRIPTION
  与 `scripts/dev.ps1` 的唯一区别：真实目录而不是隔离副本。
    agent dir  ~/.pi/agent
    userData   %APPDATA%\@percho\desktop

  因为与安装版共用同一份 userData，两者抢同一把单实例锁 —— **必须先退出安装版**，
  否则新实例拿不到锁会静默退出（本脚本会提前检测并拒绝启动）。

  这个脚本**只供人工看真实会话/记忆/AGENTS.md**。测试、验收、截图一律用 `scripts/dev.ps1`
  （隔离目录），不要把真实数据当夹具。

  单独成文件是为了双击 / 桌面快捷方式可靠：快捷方式指向 .ps1 时附加参数常常丢，
  写死在这个文件里就不依赖参数传递。

.PARAMETER Port
  CDP 调试端口，默认 9224。scripts/cdp-*.mjs 默认连这个端口。

.PARAMETER Inspector
  同时打开 main 进程 V8 inspector（9229）。

.PARAMETER Rebuild
  强制重建 lan-web 单文件产物（默认只在产物缺失或源码更新时重建）。

.PARAMETER NoPause
  失败时不等待按键。默认会等，因为双击启动时控制台窗口会在报错后立即关掉，消息根本看不见。

.EXAMPLE
  .\scripts\dev-shared.ps1
  真实数据启动，CDP 9224。
#>
[CmdletBinding()]
param(
	[int]$Port = 9224,
	[switch]$Inspector,
	[switch]$Rebuild,
	[switch]$NoPause
)

$ErrorActionPreference = "Stop"

# 构建、端口检查、退出清理的逻辑只在 dev.ps1 里有一份；这里只负责「选真实数据」这一件事
& (Join-Path $PSScriptRoot "dev.ps1") -Shared -Port $Port -Inspector:$Inspector -Rebuild:$Rebuild
$code = $LASTEXITCODE

# 双击启动时控制台会在脚本结束后立即关闭，失败信息一闪而过 —— 留个按键
if ($code -ne 0 -and -not $NoPause) {
	Write-Host ""
	Read-Host "启动未成功（退出码 $code）。按回车关闭窗口" | Out-Null
}
exit $code
