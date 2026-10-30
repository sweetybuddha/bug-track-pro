@echo off
cd /d "%~dp0"
title BugTrack Pro Server
echo ========================================================
echo   Starting BugTrack Pro (Vite, Express and Python AI)
echo ========================================================
echo.
echo   1. Frontend: http://localhost:5173
echo   2. Backend:  http://localhost:3000
echo   3. Analyzer: http://127.0.0.1:5000
echo.
echo   NOTE: Keep this window OPEN while using the app!
echo ========================================================
echo.
npm run dev
pause

