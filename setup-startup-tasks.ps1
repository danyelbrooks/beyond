# Run as Administrator to auto-start BPM servers on Windows boot

# Web server (localhost:3000)
$webTask = "BPM Web Server"
Unregister-ScheduledTask -TaskName $webTask -Confirm:$false -ErrorAction SilentlyContinue
$action   = New-ScheduledTaskAction -Execute "C:\Code\beyond\start-web.bat"
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $webTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "BPM command center web server on port 3000" -Force

# API server (localhost:3005)
$apiTask = "BPM API Server"
Unregister-ScheduledTask -TaskName $apiTask -Confirm:$false -ErrorAction SilentlyContinue
$action   = New-ScheduledTaskAction -Execute "C:\Code\beyond\start-api.bat"
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $apiTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "BPM API server on port 3005" -Force

# Onboarding server (localhost:3006)
$onboardTask = "BPM Onboarding Server"
Unregister-ScheduledTask -TaskName $onboardTask -Confirm:$false -ErrorAction SilentlyContinue
$action   = New-ScheduledTaskAction -Execute "C:\Code\beyond\start-onboard.bat"
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $onboardTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "BPM onboarding portal server on port 3006" -Force

Write-Host "Done. All three servers will start automatically on Windows boot."
Get-ScheduledTask -TaskName $webTask, $apiTask, $onboardTask | Select-Object TaskName, State
