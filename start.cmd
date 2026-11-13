@echo off
rem GeoFlare - one-click start. Starts the GeoData AI service (port 8000) and GeoFlare (port 8010), then opens the browser.
rem   start.cmd             the story, then the apps
rem   start.cmd dashboard   GeoFlare Dashboard
rem   start.cmd fires       GeoFlare Fires
rem   start.cmd air         GeoFlare Air
rem Uses the full harmonized record when it exists, otherwise the 2025 preview data.
setlocal
cd /d "%~dp0"
title GeoFlare - Team FLARECRAFT
set "BASE=http://127.0.0.1:8010/"
set "URL=%BASE%%~1?r=%RANDOM%%RANDOM%"

rem 1. The GeoData AI service: severity model, fire archive and assistant (from the original project).
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8000/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    if exist "%~dp0..\repo\.venv\Scripts\python.exe" (
        echo Starting the GeoData AI service in a separate window...
        start "GeoFlare Fires - GeoData AI service" /min /d "%~dp0..\repo" "%~dp0..\repo\.venv\Scripts\python.exe" -m uvicorn api.main:app --host 127.0.0.1 --port 8000
    ) else (
        echo GeoData project not found next to this folder - GeoFlare Fires will show it as offline.
    )
)

rem 2. GeoFlare itself. Already running? Just open the browser.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '%BASE%health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
    start "" "%URL%"
    exit /b 0
)
if exist "data\product\report.json" (
    set "EMBER_PRODUCT=%~dp0data\product"
    echo Using the full 2003-2025 harmonized record.
) else (
    set "EMBER_PRODUCT=%~dp0data\product-agg-dev"
    echo Full record not built yet - using the 2025 preview data.
)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing '%BASE%health' -TimeoutSec 2 | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep -Seconds 1 } }"
echo.
echo  GeoFlare is starting on %BASE%
echo  Dashboard: %BASE%dashboard   Fires: %BASE%fires   Air: %BASE%air
echo  Keep this window open while you use it. Close it to stop.
echo.
".venv\Scripts\python.exe" -m uvicorn api.main:app --host 127.0.0.1 --port 8010 --log-level warning
