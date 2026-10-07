# Register BPM Scorecard Sync — weekly, Sunday midnight, runs even when not logged in
# Uses the SYSTEM account so no password is needed.
# Must be run from an Administrator PowerShell window.

$taskName = "BPM Scorecard Sync"
$bat      = "C:\Code\beyond\sync-scorecard.bat"

# Delete old task if it exists
schtasks /delete /tn $taskName /f 2>$null

# Register using PowerShell's task scheduler (requires admin)
$action  = New-ScheduledTaskAction -Execute $bat
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "12:00AM"
$settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable -WakeToRun
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

Write-Host ""
Write-Host "Done. Task status:"
schtasks /query /tn $taskName /fo LIST | Select-String "Status|Task Name|Next Run|Run As"
