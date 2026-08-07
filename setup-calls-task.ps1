# Run as Administrator to set up the daily Talkroute call sync
$taskName = "BPM Call Sync"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute "C:\Code\beyond\sync-calls.bat"
$trigger   = New-ScheduledTaskTrigger -Daily -At "6:00AM"
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Daily Talkroute call sync + owner health rescore" -Force

Write-Host "Done. Call sync scheduled for 6:00 AM daily."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
