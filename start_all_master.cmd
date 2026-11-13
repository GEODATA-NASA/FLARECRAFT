@echo off
setlocal
cd /d "%~dp0"

:: تفعيل الـ venv وتثبيت المكتبات تلقائياً
if not exist ".venv" (
    python -m venv .venv
)
call .venv\Scripts\activate
python -m pip install -r requirements.txt --quiet

@echo off
echo Starting main.py...
python main.py

echo main.py finished. Now starting pipeline and servers...
call run_pipeline_and_servers.cmd

pause