//go:build windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "BreezeAgent"

// Restart restarts the Windows service via SCM.
// Used for non-update restarts where no binary swap is needed.
func Restart() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("failed to connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("failed to open service: %w", err)
	}
	defer s.Close()

	// Stop the service
	status, err := s.Control(svc.Stop)
	if err != nil {
		return fmt.Errorf("failed to stop service: %w", err)
	}

	// Wait for service to stop
	timeout := time.Now().Add(30 * time.Second)
	for status.State != svc.Stopped {
		if time.Now().After(timeout) {
			return fmt.Errorf("timeout waiting for service to stop")
		}
		time.Sleep(300 * time.Millisecond)
		status, err = s.Query()
		if err != nil {
			return fmt.Errorf("failed to query service: %w", err)
		}
	}

	// Start the service
	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start service: %w", err)
	}

	// Wait for service to start
	timeout = time.Now().Add(30 * time.Second)
	for {
		status, err = s.Query()
		if err != nil {
			return fmt.Errorf("failed to query service: %w", err)
		}
		if status.State == svc.Running {
			break
		}
		if time.Now().After(timeout) {
			return fmt.Errorf("timeout waiting for service to start")
		}
		time.Sleep(300 * time.Millisecond)
	}

	return nil
}

// restartScriptOptions captures inputs to the PowerShell helper script that
// performs the in-place agent binary swap on Windows. Built by RestartWithHelper
// and consumed by buildRestartScript so the script text can be unit-tested
// without spawning PowerShell.
//
// The half-set invariant from the pre-PR-B shape (four parallel string fields
// where "both UserHelper paths are set OR both empty" was only enforced by a
// defensive runtime check) is now expressed in the type system: UserHelper is
// a *BinaryPair, nil means "no helper to swap", and a non-nil value carries
// both paths together. Issue #816, #845 follow-up.
type restartScriptOptions struct {
	// Agent is the freshly-downloaded breeze-agent.exe temp file plus its
	// final install location. Required.
	Agent BinaryPair
	// UserHelper, when non-nil, is the freshly-downloaded breeze-user-helper.exe
	// temp file plus its final install location (typically the same directory
	// as the agent). nil means "no user-helper to swap" — the generated script
	// omits the helper Copy-Item entirely (backward-compat with releases that
	// lack the user-helper artifact). Issue #816.
	UserHelper *BinaryPair
}

// buildRestartScript renders the PowerShell helper script. Extracted from
// RestartWithHelper so it can be unit-tested for shell-injection safety and
// for backward-compatible behavior when the user-helper paths are unset
// (issue #816). Single-quote escaping doubles single quotes, matching the
// established convention for the agent path.
//
// Error handling: PowerShell's Copy-Item is a non-terminating cmdlet by
// default — a failed Copy (locked file, ACL denied, disk full) does NOT
// stop the script, so without `$ErrorActionPreference = 'Stop'` + try/catch,
// we'd swallow the failure and proceed to Start-Service, ending up with the
// new agent paired with a stale or missing user-helper — exactly the
// partial-success state #816 was filed against. The generated script:
//   - sets `$ErrorActionPreference = 'Stop'` globally,
//   - wraps the swap block (Stop-Service / Stop-Process / Copy-Item agent /
//     Copy-Item user-helper) in a single try/catch,
//   - logs Exception.Message / StackTrace / ScriptStackTrace + a named
//     "operation" tag to `${env:TEMP}\breeze-update-failure-<unix>.log` on
//     failure (TEMP always exists; ProgramData may not on fresh installs —
//     see #609),
//   - always falls through to Start-Service afterwards so the host doesn't
//     end with the service stopped (catch path attempts start too — if the
//     partial swap left a corrupt agent, the start may fail, but at least
//     we've tried and the failure log captures the cause),
//   - keeps Remove-Item cleanups outside the try/catch so they always run.
func buildRestartScript(opts restartScriptOptions) string {
	safeAgent := strings.ReplaceAll(opts.Agent.Temp, "'", "''")
	safeAgentTarget := strings.ReplaceAll(opts.Agent.Target, "'", "''")

	// nil-as-absent: the type system now guarantees both helper paths come as
	// a single unit, so we cannot land in the half-set state the pre-PR-B
	// defensive check guarded against.
	hasHelper := opts.UserHelper != nil
	var safeHelper, safeHelperTarget string
	if hasHelper {
		safeHelper = strings.ReplaceAll(opts.UserHelper.Temp, "'", "''")
		safeHelperTarget = strings.ReplaceAll(opts.UserHelper.Target, "'", "''")
	}

	lines := []string{
		// Make all errors in the swap block terminating so try/catch can
		// actually catch a failed Copy-Item. Without this, Copy-Item is
		// non-terminating and a write failure would silently regress to
		// the pre-#816 bug (new agent + stale/missing user-helper).
		"$ErrorActionPreference = 'Stop'",
		"Start-Sleep -Seconds 3",
		"try {",
		// Stop the agent service first. We OPT OUT of -ErrorAction Stop here
		// because the service may not exist on some test paths and that
		// shouldn't fail the script.
		"  Stop-Service -Name '" + serviceName + "' -Force -ErrorAction SilentlyContinue",
		// Kill any lingering breeze processes (helper, viewer, user helpers)
		// that might hold file locks on the binary or shared directory.
		"  Get-Process -Name 'breeze-helper','breeze-agent','breeze-user-helper','breeze-viewer' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
		"  Start-Sleep -Seconds 2",
		fmt.Sprintf("  Copy-Item -Path '%s' -Destination '%s' -Force", safeAgent, safeAgentTarget),
	}

	// Ordering: the agent Copy MUST come before the helper Copy. A partial
	// failure that stops between the two leaves a working (if pre-#816)
	// install rather than the helper-installed-but-agent-stale state #816
	// was filed against. (See restart_windows_test.go's ordering test.)
	if hasHelper {
		lines = append(lines,
			fmt.Sprintf("  Copy-Item -Path '%s' -Destination '%s' -Force", safeHelper, safeHelperTarget),
		)
	}

	lines = append(lines,
		// Success path: start the service.
		"  Start-Service -Name '"+serviceName+"'",
		"} catch {",
		// Failure path: log structured diagnostics. ${env:TEMP} always exists
		// on Windows (unlike C:\ProgramData\Breeze, which may not exist yet
		// on a fresh install — see #609 / HardenProgramDataAcl sequencing).
		"  $stamp = [int][double]::Parse((Get-Date -UFormat %s))",
		"  $logPath = Join-Path $env:TEMP (\"breeze-update-failure-$stamp.log\")",
		"  $op = if ($_.InvocationInfo) { $_.InvocationInfo.Line } else { '<unknown>' }",
		"  $msg = @(",
		"    \"Breeze update-helper failure at $(Get-Date -Format o)\",",
		"    \"operation: $op\",",
		"    \"exception: $($_.Exception.Message)\",",
		"    \"stackTrace: $($_.Exception.StackTrace)\",",
		"    \"scriptStackTrace: $($_.ScriptStackTrace)\"",
		"  ) -join \"`r`n\"",
		"  $msg | Out-File -FilePath $logPath -Append -Encoding utf8",
		// Always attempt Start-Service afterwards so we don't leave the host
		// with the service stopped. If the partial Copy corrupted the agent,
		// this start may fail too — that's OK, the log above captures why.
		"  Start-Service -Name '"+serviceName+"' -ErrorAction SilentlyContinue",
		"}",
		// Cleanup OUTSIDE the try/catch — these should always run regardless
		// of swap success or failure, and Remove-Item is best-effort anyway.
		fmt.Sprintf("Remove-Item -Path '%s' -Force -ErrorAction SilentlyContinue", safeAgent),
	)
	if hasHelper {
		lines = append(lines,
			fmt.Sprintf("Remove-Item -Path '%s' -Force -ErrorAction SilentlyContinue", safeHelper),
		)
	}
	lines = append(lines, "Remove-Item -Path $PSCommandPath -Force -ErrorAction SilentlyContinue")

	return strings.Join(lines, "\r\n")
}

// RestartWithHelper spawns a detached PowerShell script that:
//  1. Waits for the current process to exit
//  2. Stops the service
//  3. Copies the new agent binary (and, optionally, the new user-helper)
//     over the old one
//  4. Starts the service
//  5. Cleans up temp files
//
// This avoids the race where the agent tries to SCM-stop itself
// (killing the goroutine before it can call Start).
//
// userHelper is optional. Pass nil to perform an agent-only upgrade (the
// pre-#816 behavior). When non-nil, the generated script also copies the
// user-helper into place so the post-upgrade HelperLifecycleManager finds
// it on disk and does not fall back to spawning breeze-agent.exe in a loop
// (issue #816).
func RestartWithHelper(agent BinaryPair, userHelper *BinaryPair) error {
	script := buildRestartScript(restartScriptOptions{
		Agent:      agent,
		UserHelper: userHelper,
	})

	scriptFile, err := os.CreateTemp("", "breeze-update-*.ps1")
	if err != nil {
		return fmt.Errorf("failed to create update script: %w", err)
	}
	if _, err := scriptFile.WriteString(script); err != nil {
		scriptFile.Close()
		os.Remove(scriptFile.Name())
		return fmt.Errorf("failed to write update script: %w", err)
	}
	scriptFile.Close()

	userHelperTemp := ""
	userHelperTarget := ""
	if userHelper != nil {
		userHelperTemp = userHelper.Temp
		userHelperTarget = userHelper.Target
	}
	log.Info("spawning update helper script",
		"script", scriptFile.Name(),
		"newBinary", agent.Temp,
		"target", agent.Target,
		"userHelperTemp", userHelperTemp,
		"userHelperTarget", userHelperTarget,
	)

	cmd := exec.Command("powershell.exe",
		"-NoProfile", "-ExecutionPolicy", "Bypass",
		"-File", scriptFile.Name(),
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}

	if err := cmd.Start(); err != nil {
		os.Remove(scriptFile.Name())
		return fmt.Errorf("failed to start update helper: %w", err)
	}

	// Detach — don't wait for the process
	_ = cmd.Process.Release()

	log.Info("update helper spawned, agent will exit via service stop")
	return nil
}
