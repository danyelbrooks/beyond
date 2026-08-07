@echo off
cd /d C:\Code\beyond
"C:\Program Files\nodejs\node.exe" src/api/server.js >> logs\api-server.log 2>&1
