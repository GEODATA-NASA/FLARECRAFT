@echo off
rem GeoFlare - one-click start. Starts the GeoData AI service (port 8000) and GeoFlare (port 8010), then opens the browser.
setlocal
cd /d "%~dp0"

:: --- التعديل المضاف هنا: التأكد من تفعيل الـ venv وتثبيت المتطلبات تلقائياً ---
echo Checking and installing requirements for GeoFlare...
if not exist ".venv" (
    python -m venv .venv
)
call .venv\Scripts\activate
python -m pip install -r requirements.txt --quiet
:: --------------------------------------------------------------------------

title GeoFlare - Team FLARECRAFT
set "BASE=http://127.0.0.1:8010/"
set "URL=%BASE%%~1?r=%RANDOM%%RANDOM%"

rem 1. The GeoData AI service: severity model, fire archive and assistant.
rem    Inside the GeoData repository this folder is geoflare\ and GeoData is the parent folder;
rem    in a side-by-side setup GeoData is a sibling folder called repo.
set "GEODATA=%~dp0.."
if not exist "%GEODATA%\api\main.py" set "GEODATA=%~dp0..\repo"
set "GEODATA_STARTED=0"
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8000/api/v1/model' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    if exist "%GEODATA%\.venv\Scripts\python.exe" (
        echo Starting the GeoData AI service in a separate window...
        start "GeoFlare Fires - GeoData AI service" /min /d "%GEODATA%" "%GEODATA%\.venv\Scripts\python.exe" -m uvicorn api.main:app --host 127.0.0.1 --port 8000
        set "GEODATA_STARTED=1"
    ) else (
        echo GeoData AI service not found or its .venv is missing - GeoFlare Fires will show it as offline.
    )
)

if "%GEODATA_STARTED%"=="1" (
    echo Waiting for GeoData AI to finish starting...
    powershell -NoProfile -Command "$ready = $false; for ($i = 0; $i -lt 90; $i++) { try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8000/api/v1/model' -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { Start-Sleep -Seconds 1 } }; if (-not $ready) { exit 1 }"
    if errorlevel 1 echo GeoData AI did not become ready in time. GeoFlare will start, but severity features may be offline.
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
