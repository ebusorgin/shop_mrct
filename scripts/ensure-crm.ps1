# сторож CRM: если сервер не отвечает на 4000 — поднимает его заново.
# вызывается задачей Планировщика MixmarktCRM-Watchdog каждые 5 минут.
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeDir  = 'C:\nvm4w\nodejs'
if (Test-Path $nodeDir) { $env:Path = "$nodeDir;$env:Path" }

$logDir = Join-Path $env:LOCALAPPDATA 'mixmarkt-crm'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'autostart.log'

function Write-Log([string]$msg) {
  Add-Content -Path $logFile -Encoding utf8 -Value ('{0} [сторож] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

# 1. живой процесс на порту — молча выходим, ничего не трогаем
#    (PM2 reload поднимает второй процесс до падения старого -> EADDRINUSE, поэтому не трогаем)
$listening = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

Write-Log 'порт 4000 не слушается — принимаю меры'

# 2. БД-контейнер может не пережить рестарт Docker Desktop: поднимаю как в start-crm.ps1
docker info 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Push-Location $repoRoot
  docker compose up -d db 2>&1 | Out-Null
  Pop-Location
}

# 3. если процесс есть в PM2, но в errored/stopped — хватает restart с обновлённым env;
#    если процесса нет вообще — полный старт через start-crm.ps1
$status = ($null)
try {
  $status = (pm2 jlist 2>$null | ConvertFrom-Json | Where-Object { $_.name -eq 'mixmarkt-crm' } | Select-Object -First 1).pm2_env.status
} catch { }

if ($status -eq 'errored' -or $status -eq 'stopped') {
  Write-Log "pm2-процесс в состоянии '$status' — делаю pm2 restart"
  pm2 restart mixmarkt-crm --update-env 2>&1 | Out-Null
} else {
  Write-Log 'pm2-процесса нет — запускаю start-crm.ps1'
  & (Join-Path $PSScriptRoot 'start-crm.ps1')
  exit $LASTEXITCODE
}

# 4. проверяю результат
Start-Sleep -Seconds 5
if (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue) {
  Write-Log 'OK: сервер снова на 4000'
} else {
  Write-Log 'ОШИБКА: после рестарта порт 4000 по-прежнему не слушается'
}
