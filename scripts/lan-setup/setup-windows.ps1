# OpenBot 局域网共享 —— Windows 客户端一键安装
#
# 做三件事：
#   1. 把共享的根证书装进「当前用户 → 受信任的根证书颁发机构」（不需要管理员）
#   2. 在桌面生成「OpenBot 共享.bat」启动器（带好环境变量，双击即用）
#   3. 用默认浏览器打开共享，确认证书生效
#
# 用法（在 PowerShell 里粘一行）：
#   irm http://192.168.0.103:8899/setup-windows.ps1 | iex

$ErrorActionPreference = 'Stop'

$Share    = '192.168.0.103'
$Api      = "https://$Share`:3100"
$Signal   = "wss://$Share`:3101/v1/signal"
$CaUrl    = "http://$Share`:8899/mkcert-rootCA.crt"
$CaFile   = Join-Path $env:TEMP 'mkcert-rootCA.crt'
$Exe      = Join-Path $env:LOCALAPPDATA 'Programs\OpenBot\OpenBot.exe'
$Launcher = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenBot 共享.bat'

Write-Host '==> 1/3 安装根证书' -ForegroundColor Cyan
Invoke-WebRequest -Uri $CaUrl -OutFile $CaFile
Import-Certificate -FilePath $CaFile -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
# 账号请求由 Electron 主进程发出，走 Node 的 TLS；Node 默认只信任自己内置的根证书，
# 不看 Windows 证书存储，所以再单独喂一份给 Node。
$CaStore = Join-Path $env:LOCALAPPDATA 'OpenBot-lan'
New-Item -ItemType Directory -Force -Path $CaStore | Out-Null
$CaPem = Join-Path $CaStore 'rootCA.crt'
Copy-Item $CaFile $CaPem -Force
Write-Host '✅ 证书已加入当前用户的受信任根（可能弹过一次安全警告，点“是”）' -ForegroundColor Green

Write-Host '==> 2/3 生成桌面启动器' -ForegroundColor Cyan
if (-not (Test-Path $Exe)) {
    Write-Host "⚠️  没找到 $Exe" -ForegroundColor Yellow
    Write-Host '   先装 OpenBot for Windows：https://openbot.run'
    Write-Host '   装好后再跑一次这个脚本。'
} else {
    $bat = @"
@echo off
rem 先退出已经在跑的 OpenBot：它有单实例锁，第二次启动只会切到旧窗口，环境变量被忽略。
taskkill /IM OpenBot.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul
set OPENBOT_AUTH_API_URL=$Api
set OPENBOT_REMOTE_SIGNAL_URL=$Signal
set NODE_EXTRA_CA_CERTS=$CaPem
start "" "$Exe"
"@
    Set-Content -Path $Launcher -Value $bat -Encoding OEM
    Write-Host "✅ 桌面已生成「OpenBot 共享.bat」" -ForegroundColor Green
}

Write-Host '==> 3/3 验证' -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri "$Api/app" -UseBasicParsing -TimeoutSec 8 | Out-Null
    Write-Host "✅ 共享可访问：$Api/app" -ForegroundColor Green
    Start-Process "$Api/app"
} catch {
    Write-Host "❌ 连不上 $Api —— 检查是否和 $Share 在同一局域网、共享是否开着" -ForegroundColor Red
}

Write-Host @"

下一步：
  1. 双击桌面「OpenBot 共享.bat」打开客户端
  2. 登录邮箱填：openbot-dev-host@example.com
     验证码直接显示在登录页面上（不发送邮件）
  3. 连上后服务器列表里就是那台 Mac 上的 agent
"@
