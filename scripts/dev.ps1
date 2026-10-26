<#
.SYNOPSIS
  启动 Percho 开发版（electron-vite dev）。

.DESCRIPTION
  默认使用**隔离的用户数据**（agent dir `~/.pi/agent-dev`、userData `@percho/desktop-dev`），
  所以可以和已安装的正式版同时开着，不会抢单实例锁、不会 EPERM、不会写坏真实会话与 ui-state。

  需要看真实会话 / 记忆 / AGENTS.md 时用 -Shared：退回正式目录（`~/.pi/agent` + `@percho/desktop`），
  这时 dev 与安装版互斥（共用 userData 抢同一把锁），必须先把安装版退出。

.PARAMETER Shared
  使用正式数据目录（等同日常应用）。与安装版互斥。

.PARAMETER Port
  CDP 调试端口，默认 9224。scripts/cdp-*.mjs 默认连这个端口。

.PARAMETER Inspector
  同时打开 main 进程 V8 inspector（9229）。脚本头要求 `--inspect=9229` 时才需要。

.PARAMETER Rebuild
  强制重建 lan-web 单文件产物（默认只在产物缺失或源码更新时重建）。

.EXAMPLE
  .\scripts\dev.ps1
  隔离数据启动，CDP 9224。

.EXAMPLE
  .\scripts\dev.ps1 -Shared
  用真实数据启动（先退出安装版）。日常双击用 `dev-shared.ps1`，它已写死这个参数。

.EXAMPLE
  .\scripts\dev.ps1 -Port 9333 -Inspector
  换端口 + 开 main inspector。
#>
[CmdletBinding()]
param(
	[switch]$Shared,
	[int]$Port = 9224,
	[switch]$Inspector,
	[switch]$Rebuild
)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 控制台默认 GBK，中文提示会乱码；切 UTF-8（不改则下面所有提示都是问号）
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopDir = Join-Path $repoRoot "packages/desktop"

if (-not (Test-Path (Join-Path $repoRoot "node_modules/electron/dist/electron.exe"))) {
	Write-Host "[dev] 依赖未安装，先跑 npm install" -ForegroundColor Red
	exit 1
}

# ---- 数据目录口径（与 src/main/dev-agent-dir.ts 保持一致）----
$homeDir = $env:USERPROFILE
$appData = [Environment]::GetFolderPath("ApplicationData")
if ($Shared) {
	$agentDir = Join-Path $homeDir ".pi/agent"
	$userData = Join-Path $appData "@percho/desktop"
} else {
	$agentDir = Join-Path $homeDir ".pi/agent-dev"
	$userData = Join-Path $appData "@percho/desktop-dev"
}

# ---- lan-web 单文件产物：main 通过 ?raw 静态 import，缺失会直接编译失败 ----
$lanDist = Join-Path $desktopDir "src/lan-web/dist/lan-web/index.html"
$needLanBuild = $Rebuild -or -not (Test-Path $lanDist)
if (-not $needLanBuild) {
	$lanSrc = Get-ChildItem (Join-Path $desktopDir "src/lan-web") -Recurse -File -Include *.ts,*.tsx,*.css,*.html |
		Where-Object { $_.FullName -notlike "*\dist\*" }
	$newestSrc = ($lanSrc | Measure-Object -Property LastWriteTime -Maximum).Maximum
	$needLanBuild = $newestSrc -gt (Get-Item $lanDist).LastWriteTime
}
if ($needLanBuild) {
	Write-Host "[dev] 构建 lan-web ..." -ForegroundColor DarkGray
	Push-Location $desktopDir
	try {
		& npm run build:lan-web
		if ($LASTEXITCODE -ne 0) { Write-Host "[dev] lan-web 构建失败" -ForegroundColor Red; exit 1 }
	} finally { Pop-Location }
}

# ---- 端口占用检查（CDP 端口被别的实例占着时脚本会连错页面）----
$portBusy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
	$owner = (Get-Process -Id $portBusy[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
	Write-Host "[dev] 端口 $Port 已被占用（$owner，PID $($portBusy[0].OwningProcess)），换端口：-Port <n>" -ForegroundColor Red
	exit 1
}

# -Shared 与安装版共用 userData，抢同一把单实例锁：安装版在跑时新实例会静默退出，白等一场
if ($Shared) {
	$installed = Get-Process Percho -ErrorAction SilentlyContinue
	if ($installed) {
		Write-Host "[dev] -Shared 需要独占正式 userData，但安装版正在运行（PID $($installed[0].Id)）。" -ForegroundColor Red
		Write-Host "      先退出安装版，或去掉 -Shared 用隔离数据启动（可与安装版同时运行）。" -ForegroundColor Red
		exit 1
	}
}

# ---- 环境变量：隔离是默认，-Shared 才退回正式目录 ----
$env:PERCHO_SHARED_DEV_DATA = if ($Shared) { "1" } else { $null }
$env:PI_CODING_AGENT_DIR = $null   # 交给 dev-agent-dir.ts 决定，避免残留 env 干扰

$electronArgs = @()
if ($Inspector) { $electronArgs += "--inspect=9229" }
$electronArgs += "--remote-debugging-port=$Port"

Write-Host ""
Write-Host "  Percho dev" -ForegroundColor Cyan
Write-Host "  数据      $(if ($Shared) { '正式（与安装版互斥，需先退出安装版）' } else { '隔离（可与安装版同时运行）' })" -ForegroundColor Gray
Write-Host "  agent dir $agentDir" -ForegroundColor Gray
Write-Host "  userData  $userData" -ForegroundColor Gray
Write-Host "  CDP       http://127.0.0.1:$Port" -ForegroundColor Gray
Write-Host "  退出      Ctrl+C（本脚本只清理本次启动的 Electron）" -ForegroundColor Gray
Write-Host ""

# 记录启动前已有的 dev Electron，退出时只清理新增的，绝不碰安装版（进程名 Percho.exe）
$before = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
	Where-Object { $_.CommandLine -like "*$repoRoot*" } | Select-Object -ExpandProperty ProcessId)

Push-Location $desktopDir
try {
	# 直接调 electron-vite（不经 npm run dev：npm 会吞掉 `--` 之后的 Electron 参数）
	& npx electron-vite dev -- @electronArgs
} finally {
	Pop-Location
	$after = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
		Where-Object { $_.CommandLine -like "*$repoRoot*" } | Select-Object -ExpandProperty ProcessId)
	$leftover = $after | Where-Object { $before -notcontains $_ }
	foreach ($procId in $leftover) {
		# /T 连同渲染进程一起结束，避免主进程退了 GPU/renderer 还在占 userData
		& taskkill /PID $procId /T /F 2>&1 | Out-Null
	}
	if ($leftover) { Write-Host "[dev] 已清理 $($leftover.Count) 个残留 Electron 进程" -ForegroundColor DarkGray }
}
