@echo off
setlocal
chcp 65001 >nul 2>&1

pushd "%~dp0..\.." >nul 2>&1
if errorlevel 1 (
  echo AICO-PPT 编辑器无法启动：无法进入 skill 根目录，请确认共享目录已经挂载或映射为 Windows 盘符。
  pause
  exit /b 2
)

set "LAUNCHER=%CD%\scripts\deck-editor.py"
if not exist "%LAUNCHER%" (
  echo AICO-PPT Dev Shell 无法启动：调试入口必须保留在仓库的 tools/dev-shell 目录中。正式编辑入口位于 AICO-Harness。
  pause
  exit /b 2
)

set "SHORTCUT=%~dp0AICO-PPT Dev Shell（Windows）.lnk"
set "SHORTCUT_SCRIPT=%CD%\scripts\create_windows_launcher_shortcut.ps1"
if not exist "%SHORTCUT%" if exist "%SHORTCUT_SCRIPT%" if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SHORTCUT_SCRIPT%" >nul 2>&1
)

where py.exe >nul 2>&1
if not errorlevel 1 goto launch_py

where python.exe >nul 2>&1
if not errorlevel 1 goto launch_python

echo AICO-PPT 编辑器无法启动：找不到 Python 3，请先安装 Python 3 并勾选“Add Python to PATH”。
pause
exit /b 2

:launch_py
py.exe -3 "%LAUNCHER%" --detach-windows --app %*
exit /b %errorlevel%

:launch_python
python.exe "%LAUNCHER%" --detach-windows --app %*
exit /b %errorlevel%
