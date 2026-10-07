# Register BPM Scorecard Sync — weekly, Sunday midnight, runs even when not logged in
# Windows will prompt for your password once to store securely with the task.
$taskName = "BPM Scorecard Sync"
$bat      = "C:\Code\beyond\sync-scorecard.bat"
$user     = "$env:USERDOMAIN\$env:USERNAME"

# Delete old task if it exists
schtasks /delete /tn $taskName /f 2>$null

Write-Host "Creating task for user: $user"
Write-Host "Windows will prompt for your password to allow the task to run when logged out."
Write-Host ""

# /rp * tells schtasks to prompt for the password interactively (never stored in a variable)
schtasks /create /tn $taskName /tr $bat /sc weekly /d SUN /st 00:00 /ru $user /rp * /f

Write-Host ""
Write-Host "Done. Task status:"
schtasks /query /tn $taskName /fo LIST | Select-String "Status|Task Name|Next Run|Run As"
