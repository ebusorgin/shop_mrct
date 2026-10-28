# Убирает MIX markt CRM из автозапуска Windows (и задачу Планировщика, и файл из «Автозагрузки»).
# Только регистрацию: запущенный PM2-процесс скрипт не трогает.
$ErrorActionPreference = 'Continue'

$taskName = 'MixmarktCRM-Autostart'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Задача '$taskName' удалена"
} else {
  Write-Host "Задача '$taskName' не найдена"
}

$cmdFile = Join-Path ([Environment]::GetFolderPath('Startup')) 'MixmarktCRM.cmd'
if (Test-Path $cmdFile) {
  Remove-Item $cmdFile -Force
  Write-Host "Файл $cmdFile удалён"
}
