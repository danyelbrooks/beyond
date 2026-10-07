@echo off
cd /d C:\Code\beyond
"C:\Program Files\nodejs\node.exe" src/scorecard/sync-scorecard.js >> logs\scorecard-sync.log 2>&1
