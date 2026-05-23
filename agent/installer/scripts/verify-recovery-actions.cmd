@echo off
REM Verify the SCM service-recovery actions are set on a Breeze install.
REM
REM Run on a FRESH VM after MSI install. An upgrade over a developer-
REM installed agent (where `breeze-agent service install` had been run)
REM will look correct even if the MSI CustomAction never fired, so this
REM only proves correctness on a clean-slate install.
REM
REM Expected output for each service:
REM   RESET_PERIOD (in seconds)    : 86400
REM   FAILURE_ACTIONS              : RESTART -- Delay = 5000 milliseconds.
REM                                : RESTART -- Delay = 10000 milliseconds.
REM                                : RESTART -- Delay = 30000 milliseconds.

setlocal
set EXIT=0

echo === BreezeAgent ===
sc qfailure BreezeAgent | findstr /C:"RESET_PERIOD" /C:"RESTART"
if errorlevel 1 set EXIT=1

echo.
echo === BreezeWatchdog ===
sc qfailure BreezeWatchdog | findstr /C:"RESET_PERIOD" /C:"RESTART"
if errorlevel 1 set EXIT=1

echo.
if "%EXIT%"=="0" (
  echo OK: recovery actions present on both services.
) else (
  echo FAIL: recovery actions missing on one or both services.
  echo Check that the MSI CustomAction "ConfigureBreezeFailureActions"
  echo fired during install. Re-run "msiexec /i breeze-agent.msi /l*v
  echo install.log" and grep install.log for ConfigureBreezeFailureActions.
)
exit /b %EXIT%
