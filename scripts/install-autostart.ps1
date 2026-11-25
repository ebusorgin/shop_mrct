# Ставит MIX markt CRM в автозапуск Windows.
# Основной вариант — задача Планировщика по входу пользователя (не требует прав администратора,
# потому что Docker Desktop и его именной канал доступны только сессии пользователя).
# Если Planning Task Service недоступен — fallback: .cmd в папке «Автозагрузка».
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$starter  = Join-Path $PSScriptRoot 'start-crm.ps1'
$watchdog = Join-Path $PSScriptRoot 'ensure-crm.ps1'
$wscript  = Join-Path $env:SystemRoot 'System32\wscript.exe'
$hidden   = Join-Path $PSScriptRoot 'run-hidden.vbs'
$taskName = 'MixmarktCRM-Autostart'
$wdName   = 'MixmarktCRM-Watchdog'
# Запуск через wscript: в Windows 11 с Windows Terminal окно появляется даже
# при -WindowStyle Hidden. wscript + Run(...,0) окна не создаёт вообще.
$psArgs   = '//nologo "{0}" "{1}"' -f $hidden, $starter
$wdArgs   = '//nologo "{0}" "{1}"' -f $hidden, $watchdog

# Задача пересоздаётся целиком — так безопасно повторять установку после изменений.
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host 'Старая задача удалена'
}

try {
  $action   = New-ScheduledTaskAction -Execute $wscript -Argument $psArgs
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'MIX markt CRM: Docker-БД + PM2 на порту 4000 при входе в Windows' | Out-Null
  Write-Host "Готово: задача '$taskName' запускает CRM при входе пользователя $env:USERNAME"

  # сторож: раз в 5 минут проверяет порт 4000 и оживляет сервер, если PM2 сдался (errored)
  $wdOld = Get-ScheduledTask -TaskName $wdName -ErrorAction SilentlyContinue
  if ($wdOld) { Unregister-ScheduledTask -TaskName $wdName -Confirm:$false }
  $wdAction   = New-ScheduledTaskAction -Execute $wscript -Argument $wdArgs
  $wdTrigger  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $wdSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(4))
  Register-ScheduledTask -TaskName $wdName -Action $wdAction -Trigger $wdTrigger -Settings $wdSettings `
    -Description 'MIX markt CRM: сторож порта 4000, каждые 5 минут поднимает сервер при падении' | Out-Null
  Write-Host "Готово: задача '$wdName' — сторож, стартует каждые 5 минут"
} catch {
  Write-Host "Планировщик недоступен: $($_.Exception.Message)"
  $vbsFile = Join-Path ([Environment]::GetFolderPath('Startup')) 'MixmarktCRM.vbs'
  $body = @(
    'Set sh = CreateObject("WScript.Shell")',
    ('sh.Run "wscript.exe //nologo ""{0}"" ""{1}""", 0, False' -f $hidden, $starter)
  )
  $body -join "`r`n" | Set-Content -Path $vbsFile -Encoding ASCII
  Write-Host "Готово: добавлен файл автозагрузки $vbsFile"
}

Write-Host "Лог запуска: $env:LOCALAPPDATA\mixmarkt-crm\autostart.log"
Write-Host "Проверка:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$starter`""
