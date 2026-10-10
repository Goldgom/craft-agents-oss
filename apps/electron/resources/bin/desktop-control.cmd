@echo off
if not defined CRAFT_SCRIPTS set "CRAFT_SCRIPTS=%~dp0..\scripts"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CRAFT_SCRIPTS%\desktop-control.ps1" %*
