# Sets up the "Fjord update" task: runs build.ps1 -Auto every 3 hours, which updates Firefox inside Fjord
# when a new version is out (and Fjord is closed). Run once:  powershell -ExecutionPolicy Bypass -File tools\install-updater.ps1
# Remove it again:  Unregister-ScheduledTask -TaskName 'Fjord update'
$ErrorActionPreference = 'Stop'
$build = Join-Path (Split-Path $PSScriptRoot) 'build.ps1'

# Runs as this user while signed in; headless conhost keeps a console window from flashing up
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$build`" -Auto"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 3)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'Fjord update' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Fjord will check for Firefox updates every 3 hours (log: $(Split-Path $PSScriptRoot)\dist\update.log)."
