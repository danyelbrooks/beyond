@echo off
cd /d C:\Code\beyond
"C:\Program Files\nodejs\node.exe" src/calls/sync-calls.js >> logs\calls-sync.log 2>&1
"C:\Program Files\nodejs\node.exe" src/owners/score-owners.js >> logs\calls-sync.log 2>&1
