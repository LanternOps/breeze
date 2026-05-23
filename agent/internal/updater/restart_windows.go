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
type restartScriptOptions struct {
	// AgentTempPath is the freshly-downloaded breeze-agent.exe in a temp dir.
	AgentTempPath string
	// AgentTargetPath is the final install location of breeze-agent.exe.
	AgentTargetPath string
	// UserHelperTempPath is the freshly-downloaded breeze-user-helper.exe
	// in a temp dir. Empty string means "no user-helper to swap" — the
	// generated script omits the helper Copy-Item entirely (backward-compat
	// with releases that lack the user-helper artifact). Issue #816.
	UserHelperTempPath string
	// UserHelperTargetPath is the final install location of
	// breeze-user-helper.exe (typically the same directory as the agent).
	UserHelperTargetPath string
}

// buildRestartScript renders the PowerShell helper script. Extracted from
// RestartWithHelper so it can be unit-tested for shell-injection safety and
// for backward-compatible behavior when the user-helper paths are unset
// (issue #816). Single-quote escaping doubles single quotes, matching the
// established convention for the agent path.
func buildRestartScript(opts restartScriptOptions) string {
	safeAgent := strings.ReplaceAll(opts.AgentTempPath, "'", "''")
	safeAgentTarget := strings.ReplaceAll(opts.AgentTargetPath, "'", "''")

	lines := []string{
		"Start-Sleep -Seconds 3",
		// Stop the agent service first
		"Stop-Service -Name '" + serviceName + "' -Force -ErrorAction SilentlyContinue",
		// Kill any lingering breeze processes (helper, viewer, user helpers)
		// that might hold file locks on the binary or shared directory.
		"Get-Process -Name 'breeze-helper','breeze-agent','breeze-user-helper','breeze-viewer' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
		"Start-Sleep -Seconds 2",
		fmt.Sprintf("Copy-Item -Path '%s' -Destination '%s' -Force", safeAgent, safeAgentTarget),
	}

	// Optionally swap in the user-helper too. Skipped when the caller didn't
	// pre-download it (pre-#816 release, network failure, 404, etc.) — the
	// agent-only upgrade still succeeds in that case.
	if opts.UserHelperTempPath != "" && opts.UserHelperTargetPath != "" {
		safeHelper := strings.ReplaceAll(opts.UserHelperTempPath, "'", "''")
		safeHelperTarget := strings.ReplaceAll(opts.UserHelperTargetPath, "'", "''")
		lines = append(lines,
			fmt.Sprintf("Copy-Item -Path '%s' -Destination '%s' -Force", safeHelper, safeHelperTarget),
		)
	}

	lines = append(lines,
		"Start-Service -Name '"+serviceName+"'",
		fmt.Sprintf("Remove-Item -Path '%s' -Force -ErrorAction SilentlyContinue", safeAgent),
	)
	if opts.UserHelperTempPath != "" && opts.UserHelperTargetPath != "" {
		safeHelper := strings.ReplaceAll(opts.UserHelperTempPath, "'", "''")
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
// userHelperTempPath / userHelperTargetPath are optional. Pass empty strings
// to perform an agent-only upgrade (the pre-#816 behavior). When both are
// non-empty, the generated script also copies the user-helper into place
// so the post-upgrade HelperLifecycleManager finds it on disk and does not
// fall back to spawning breeze-agent.exe in a loop (issue #816).
func RestartWithHelper(newBinaryPath, targetPath string, userHelperTempPath, userHelperTargetPath string) error {
	script := buildRestartScript(restartScriptOptions{
		AgentTempPath:        newBinaryPath,
		AgentTargetPath:      targetPath,
		UserHelperTempPath:   userHelperTempPath,
		UserHelperTargetPath: userHelperTargetPath,
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

	log.Info("spawning update helper script",
		"script", scriptFile.Name(),
		"newBinary", newBinaryPath,
		"target", targetPath,
		"userHelperTemp", userHelperTempPath,
		"userHelperTarget", userHelperTargetPath,
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
