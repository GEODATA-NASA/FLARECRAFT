@echo off
rem Ember Almanac (fire calendar) + GeoData AI (fire-severity map) - one-click start.
rem Uses the full harmonized record when it exists, otherwise the 2025 preview data.
setlocal
cd /d "%~dp0"
title Ember Almanac - Team FLARECRAFT
set "URL=http://127.0.0.1:8010/"

rem 1. The sibling app: GeoData AI severity map on port 8000 (from the original project).
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8000/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    if exist "%~dp0..\repo\.venv\Scripts\python.exe" (
        echo Starting the GeoData severity map in a separate window...
        start "GeoData AI - severity map" /min /d "%~dp0..\repo" "%~dp0..\repo\.venv\Scripts\python.exe" -m uvicorn api.main:app --host 127.0.0.1 --port 8000
    ) else (
        echo GeoData project not found next to this folder - the Severity map button will be unavailable.
    )
)

rem 2. Ember Almanac itself. Already running? Just open the browser.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '%URL%health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
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
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing '%URL%health' -TimeoutSec 2 | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep -Seconds 1 } }"
echo.
echo  Ember Almanac is starting on %URL%
echo  Keep this window open while you use it. Close it to stop.
echo.
".venv\Scripts\python.exe" -m uvicorn api.main:app --host 127.0.0.1 --port 8010 --log-level warning
