# Run as Administrator to configure the email sync to run 24/7
$taskName = "BPM Email Sync"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute "C:\Code\beyond\sync-email.bat"
$trigger   = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 5) -Once -At (Get-Date)
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "BPM email sync" -Force

Write-Host "Done."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
