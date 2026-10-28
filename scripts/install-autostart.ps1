# Ставит MIX markt CRM в автозапуск Windows.
# Основной вариант — задача Планировщика по входу пользователя (не требует прав администратора,
# потому что Docker Desktop и его именной канал доступны только сессии пользователя).
# Если Planning Task Service недоступен — fallback: .cmd в папке «Автозагрузка».
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$starter  = Join-Path $PSScriptRoot 'start-crm.ps1'
$ps       = (Get-Command powershell.exe).Source
$taskName = 'MixmarktCRM-Autostart'
$psArgs   = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $starter

# Задача пересоздаётся целиком — так безопасно повторять установку после изменений.
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host 'Старая задача удалена'
}

try {
  $action   = New-ScheduledTaskAction -Execute $ps -Argument $psArgs
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'MIX markt CRM: Docker-БД + PM2 на порту 4000 при входе в Windows' | Out-Null
  Write-Host "Готово: задача '$taskName' запускает CRM при входе пользователя $env:USERNAME"
} catch {
  Write-Host "Планировщик недоступен: $($_.Exception.Message)"
  $cmdFile = Join-Path ([Environment]::GetFolderPath('Startup')) 'MixmarktCRM.cmd'
  $body = '@echo off', ('start "CRM" "{0}" {1}' -f $ps, $psArgs)
  $body -join "`r`n" | Set-Content -Path $cmdFile -Encoding ASCII
  Write-Host "Готово: добавлен файл автозагрузки $cmdFile"
}

Write-Host "Лог запуска: $env:LOCALAPPDATA\mixmarkt-crm\autostart.log"
Write-Host "Проверка:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$starter`""
