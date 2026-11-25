# Сторож CRM: если порт 4000 не слушается — поднимает БД и сервер заново.
# Вызывается задачей Планировщика MixmarktCRM-Watchdog каждые 5 минут.
$ErrorActionPreference = 'Continue'

# PM2 иначе каждые 30 с запускает скрытый PowerShell ради метрик процесса
# (pidusage -> gwmi). 5 минут достаточно для контроля max_memory_restart.
$env:PM2_WORKER_INTERVAL = '300000'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeDir  = 'C:\nvm4w\nodejs'
if (Test-Path $nodeDir) { $env:Path = "$nodeDir;$env:Path" }

$logDir = Join-Path $env:LOCALAPPDATA 'mixmarkt-crm'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'autostart.log'

function Write-Log([string]$msg) {
  Add-Content -Path $logFile -Encoding utf8 -Value ('{0} [сторож] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

# 1. живой процесс на порту — молча выходим
if (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue) { exit 0 }

Write-Log 'порт 4000 не слушается — принимаю меры'

# 2. БД: portable PostgreSQL, иначе Docker.
$portablePg = Join-Path $repoRoot '.devtools\pg18\pgsql\bin\pg_ctl.exe'
if (Test-Path $portablePg) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'local-db.ps1') start 2>&1 | ForEach-Object { Write-Log "db: $_" }
} else {
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Push-Location $repoRoot
    docker compose up -d db 2>&1 | Out-Null
    Pop-Location
  }
}

# 3. PM2: restart при errored/stopped, иначе полный старт.
$status = $null
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
