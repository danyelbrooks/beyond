@echo off
cd /d C:\Code\beyond
"C:\Program Files\nodejs\node.exe" node_modules\.bin\serve src/command-center -l 3000 >> logs\web-server.log 2>&1
