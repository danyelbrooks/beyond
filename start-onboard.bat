@echo off
cd /d C:\Code\beyond
"C:\Program Files\nodejs\node.exe" --watch src/onboarding/server.js >> logs\onboard-server.log 2>&1
