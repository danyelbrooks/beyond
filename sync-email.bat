@echo off
cd /d C:\Code\beyond
"C:\Program Files\nodejs\node.exe" src/email/sync.js >> logs\email-sync.log 2>&1
