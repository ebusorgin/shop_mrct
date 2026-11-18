# Локальная PostgreSQL для MIX markt CRM.
# Использует portable-сборку .devtools\pg18\pgsql и каталог данных .devtools\data.
# Docker не нужен; на сервере с Docker этот скрипт не вызывается.
param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir  = Join-Path $repoRoot '.devtools\data'
$pgBin    = Join-Path $repoRoot '.devtools\pg18\pgsql\bin'
$pgCtl    = Join-Path $pgBin 'pg_ctl.exe'
$pgReady  = Join-Path $pgBin 'pg_isready.exe'
$logFile  = Join-Path $repoRoot '.devtools\pg.log'

function Test-DbPort {
  [bool](Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue)
}

switch ($Action) {
  'start' {
    if (Test-DbPort) {
      Write-Host 'PostgreSQL уже слушает 127.0.0.1:5432'
      exit 0
    }
    if (-not (Test-Path $pgCtl)) {
      Write-Error "Не найден pg_ctl: $pgCtl (ожидается portable PostgreSQL 18 в .devtools\pg18)"
      exit 2
    }

    # После жёсткого выключения остаётся postmaster.pid мёртвого процесса.
    $pidFile = Join-Path $dataDir 'postmaster.pid'
    if (Test-Path $pidFile) {
      $stalePid = 0
      [void][int]::TryParse((Get-Content $pidFile -First 1), [ref]$stalePid)
      if ($stalePid -gt 0 -and (Get-Process -Id $stalePid -ErrorAction SilentlyContinue)) {
        Write-Error "postmaster.pid указывает на живой процесс $stalePid, но порт 5432 не слушается"
        exit 3
      }
      Remove-Item $pidFile -Force
      Write-Host 'Удалён устаревший postmaster.pid'
    }

    # pg_ctl запускает postgres отдельным процессом. Ни -Wait, ни пайплайн не используем:
    # PowerShell ждал бы всё дерево процессов до остановки сервера.
    $null = Start-Process -FilePath $pgCtl `
      -ArgumentList @('-D', $dataDir, '-l', $logFile, '-w', 'start') `
      -WindowStyle Hidden

    for ($i = 0; $i -lt 30; $i++) {
      if (Test-DbPort) { break }
      Start-Sleep -Seconds 1
    }
    if (-not (Test-DbPort)) {
      Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue | Out-Host
      Write-Error 'PostgreSQL не поднялся за 30 секунд (см. .devtools\pg.log)'
      exit 4
    }
    & $pgReady -h 127.0.0.1 -p 5432
    exit $LASTEXITCODE
  }

  'stop' {
    if (-not (Test-DbPort)) {
      Write-Host 'PostgreSQL не запущен'
      exit 0
    }
    if (-not (Test-Path $pgCtl)) { Write-Error "Не найден pg_ctl: $pgCtl"; exit 2 }
    & $pgCtl -D $dataDir -m fast -w stop | Out-Host
    exit $LASTEXITCODE
  }

  'status' {
    if (-not (Test-Path $pgReady)) { Write-Error "Не найден pg_isready: $pgReady"; exit 2 }
    & $pgReady -h 127.0.0.1 -p 5432
    exit $LASTEXITCODE
  }
}
