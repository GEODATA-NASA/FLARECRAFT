@echo off
rem GeoFlare for a second laptop: both laptops on the SAME Wi-Fi or phone hotspot, this one runs GeoFlare, the other opens it by address.
rem Everything stays live on this laptop (today's fires, the air, Ask Flick); the other laptop needs only a browser.
setlocal
cd /d "%~dp0"
echo Stopping GeoFlare if it is already running here, so it can restart open to the network...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
set "GEOFLARE_HOST=0.0.0.0"
echo.
echo  On the OTHER laptop, open one of these in Chrome or Edge:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { '      http://' + $_.IPAddress + ':8010/present/' }"
echo.
echo  If Windows asks about the firewall, choose Allow (private networks).
echo  Use your own phone hotspot, not a public Wi-Fi: anyone on the same network can open these addresses while this runs.
echo.
call start.cmd present
