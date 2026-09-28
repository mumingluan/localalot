@echo off
setlocal

cd /d "%~dp0" || goto workdir_failed

where node.exe >nul 2>nul
if errorlevel 1 goto node_missing
where npm.cmd >nul 2>nul
if errorlevel 1 goto npm_missing

for /f %%V in ('node -p "parseInt(process.versions.node, 10)"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto node_missing
if %NODE_MAJOR% LSS 22 goto node_too_old

if not exist "node_modules\.bin\webpack.cmd" goto install
if not exist "node_modules\.bin\vsce.cmd" goto install
goto package

:install
call npm.cmd ci
if errorlevel 1 goto install_failed

:package
rem vsce runs vscode:prepublish, which builds the production bundle.
call ".\node_modules\.bin\vsce.cmd" package
if errorlevel 1 goto package_failed

echo VSIX build completed.
set "BUILD_EXIT_CODE=0"
goto finish

:workdir_failed
echo ERROR: Cannot open the project directory.
set "BUILD_EXIT_CODE=1"
goto finish

:node_missing
echo ERROR: Node.js was not found. Install Node.js 22 or newer and reopen the terminal.
set "BUILD_EXIT_CODE=1"
goto finish

:npm_missing
echo ERROR: npm.cmd was not found. Install Node.js with npm and reopen the terminal.
set "BUILD_EXIT_CODE=1"
goto finish

:node_too_old
echo ERROR: Node.js %NODE_MAJOR% is too old. This project's VSIX packager requires Node.js 22 or newer.
set "BUILD_EXIT_CODE=1"
goto finish

:install_failed
echo ERROR: npm ci failed. Review the npm error above.
set "BUILD_EXIT_CODE=1"
goto finish

:package_failed
echo ERROR: VSIX packaging failed. Review the error above.
set "BUILD_EXIT_CODE=1"
goto finish

:finish
if /i not "%~1"=="--no-pause" pause
exit /b %BUILD_EXIT_CODE%
