# MIX markt CRM: полный старт сервиса. Вызывается автозапуском Windows (Планировщик/Автозагрузка).
# Логика: дождаться Docker -> поднять БД -> стартнуть PM2 -> проверить, что порт 4000 отвечает.
$ErrorActionPreference = 'Continue'

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

# 1. Docker Desktop поднимается долго, поэтому ждём его демон, а не падаем сразу.
$dockerReady = $false
for ($i = 0; $i -lt 20; $i++) {
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
  Start-Sleep -Seconds 5
}
if ($dockerReady) { Write-Log 'Docker: демон доступен' } else { Write-Log 'Docker: НЕ ответил за 100 c (проверяем дальше как есть)' }

# 2. База данных в контейнере mixmarkt-crm-db
if ($dockerReady) {
  Push-Location $repoRoot
  docker compose up -d db 2>&1 | ForEach-Object { Write-Log "docker compose: $_" }
  Pop-Location

  $healthy = $false
  for ($i = 0; $i -lt 24; $i++) {
    if ((docker inspect -f '{{.State.Health.Status}}' mixmarkt-crm-db 2>$null) -eq 'healthy') { $healthy = $true; break }
    Start-Sleep -Seconds 5
  }
  if ($healthy) { Write-Log 'БД: healthy' } else { Write-Log 'БД: НЕ стала healthy за 120 c' }
}

# 3. Процесс сервера. PM2-демон, запущенный от планировщика, не привязан к терминалу и живёт после выхода.
Push-Location $repoRoot
$pm2Out = pm2 startOrReload ecosystem.config.js 2>&1 | Out-String
$pm2Code = $LASTEXITCODE
# В лог идут только служебные строки [PM2] — таблица статуса забивает файл рамками
($pm2Out -split "`r?`n") | Where-Object { $_ -match '\[PM2\]' } | ForEach-Object { Write-Log $_.Trim() }
Write-Log "pm2 startOrReload: exit=$pm2Code"
$null = pm2 save 2>&1
Pop-Location

# 4. Проверка готовности: сервер сам раздаёт и API, и клиентский бандл
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    if ((Invoke-WebRequest -Uri 'http://localhost:4000' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 3 }
}
if ($ok) { Write-Log 'OK: CRM отвечает на http://localhost:4000' } else { Write-Log 'ОШИБКА: CRM не отвечает на http://localhost:4000' }
Write-Log '=== конец ==='
