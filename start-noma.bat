@echo off
chcp 65001 >nul
title NOMA local server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
