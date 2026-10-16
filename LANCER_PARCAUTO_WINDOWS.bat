@echo off
chcp 65001 >nul
title ParcAuto Maroc - Serveur Local
echo ============================================================
echo   Lancement de ParcAuto Maroc en local...
echo ============================================================
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Node.js n'est pas installe. Ouverture directe du site dans votre navigateur...
    start "" "%~dp0index.html"
    exit /b
)
start "" "http://localhost:3000"
node "%~dp0server.js"
pause
