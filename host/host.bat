@echo off
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0host.ps1" %*
