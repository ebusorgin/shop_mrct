# MIX markt CRM: полный старт локального контура.
# 1) база: portable PostgreSQL 18 из .devtools (Docker — только как запасной вариант);
# 2) сервер: PM2 на порту 4000, с автоперезапуском.
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
  Add-Content -Path $logFile -Encoding utf8 -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

Write-Log '=== старт ==='

# 1. База данных: сначала portable PostgreSQL, иначе Docker.
$portablePg = Join-Path $repoRoot '.devtools\pg18\pgsql\bin\pg_ctl.exe'
if (Test-Path $portablePg) {
  Write-Log 'БД: portable PostgreSQL 18 (.devtools)'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'local-db.ps1') start 2>&1 | ForEach-Object { Write-Log "db: $_" }
} else {
  $dockerReady = $false
  for ($i = 0; $i -lt 20; $i++) {
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
    Start-Sleep -Seconds 5
  }
  if ($dockerReady) {
    Write-Log 'БД: Docker'
    Push-Location $repoRoot
    docker compose up -d db 2>&1 | ForEach-Object { Write-Log "docker compose: $_" }
    Pop-Location
    for ($i = 0; $i -lt 24; $i++) {
      if ((docker inspect -f '{{.State.Health.Status}}' mixmarkt-crm-db 2>$null) -eq 'healthy') { break }
      Start-Sleep -Seconds 5
    }
  } else {
    Write-Log 'БД: ни portable PostgreSQL, ни Docker не доступны'
  }
}

# 2. Сервер под PM2: демон живёт после выхода из терминала.
Push-Location $repoRoot
$pm2Out = pm2 startOrReload ecosystem.config.js 2>&1 | Out-String
$pm2Code = $LASTEXITCODE
($pm2Out -split "`r?`n") | Where-Object { $_ -match '\[PM2\]' } | ForEach-Object { Write-Log $_.Trim() }
Write-Log "pm2 startOrReload: exit=$pm2Code"
$null = pm2 save 2>&1
Pop-Location

# 3. Проверка готовности: сервер раздаёт API и собранный клиент.
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    if ((Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) {
      $ok = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 3
  }
}
if ($ok) { Write-Log 'OK: CRM отвечает на http://localhost:4000' } else { Write-Log 'ОШИБКА: CRM не отвечает на http://localhost:4000' }
Write-Log '=== конец ==='
