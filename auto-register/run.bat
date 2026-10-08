@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Edit PYTHON below if "python" is not on your PATH.
rem  Example: set PYTHON=C:\Python312\python.exe
rem  (Double-clicking a .bat does NOT see per-user PATH additions
rem   in some setups, so an absolute path is the safest.)
rem ============================================================
set PYTHON=python

echo.
echo   workspace-auto-register
echo   -----------------------
echo   [1] dry-run  (list pending links)
echo   [2] run 1 account
echo   [3] run all
echo   [4] show ledger
echo   [5] import cookies into proxy
echo.
set /p CHOICE=Choose [1-5]: 

if "%CHOICE%"=="1" "%PYTHON%" register.py --dry-run
if "%CHOICE%"=="2" "%PYTHON%" register.py --limit 1
if "%CHOICE%"=="3" "%PYTHON%" register.py
if "%CHOICE%"=="4" type output\accounts.tsv
if "%CHOICE%"=="5" "%PYTHON%" import_to_proxy.py --dry-run

echo.
pause
