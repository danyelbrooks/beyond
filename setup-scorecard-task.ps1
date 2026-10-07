# Register BPM Scorecard Sync as a weekly task — runs every Sunday at midnight
$taskName = "BPM Scorecard Sync"
$bat      = "C:\Code\beyond\sync-scorecard.bat"

# Delete old task if it exists
schtasks /delete /tn $taskName /f 2>$null

# Create task: weekly, Sunday, at 00:00
schtasks /create /tn $taskName /tr $bat /sc weekly /d SUN /st 00:00 /f

Write-Host ""
Write-Host "Done. Task status:"
schtasks /query /tn $taskName /fo LIST | Select-String "Status|Task Name|Next Run"
