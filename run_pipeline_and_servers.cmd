@echo off
setlocal
cd /d "%~dp0"

set "GEOFLARE_DIR=%~dp0geoflare"
set "GEOFLARE_PY=%GEOFLARE_DIR%\.venv\Scripts\python.exe"

if not exist "%GEOFLARE_PY%" (
    echo Creating the GeoFlare virtual environment...
    python -m venv "%GEOFLARE_DIR%\.venv"
    if errorlevel 1 goto :failed
)
echo Checking and installing GeoFlare requirements...
"%GEOFLARE_PY%" -m pip install -r "%GEOFLARE_DIR%\requirements.txt" --quiet
if errorlevel 1 goto :failed

echo [1/5] Running GeoFlare pipeline (download)...
pushd "%GEOFLARE_DIR%"
"%GEOFLARE_PY%" -m pipeline.download
if errorlevel 1 goto :pipeline_failed

echo [2/5] Running pipeline (aggregate)...
"%GEOFLARE_PY%" -m pipeline.aggregate
if errorlevel 1 goto :pipeline_failed

echo [3/5] Running pipeline (build)...
"%GEOFLARE_PY%" -m pipeline.build
if errorlevel 1 goto :pipeline_failed

echo [4/5] Running pipeline (rankings)...
"%GEOFLARE_PY%" -m pipeline.rankings
if errorlevel 1 goto :pipeline_failed
popd

echo [5/5] Pipeline finished successfully! Starting GeoFlare and servers...

call geoflare\start.cmd
if errorlevel 1 goto :failed

pause
exit /b 0

:pipeline_failed
popd
echo GeoFlare pipeline failed. Servers will not be started.
pause
exit /b 1

:failed
echo Setup or startup failed. See the preceding error for details.
pause
exit /b 1