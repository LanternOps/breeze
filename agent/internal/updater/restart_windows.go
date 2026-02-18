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

// RestartWithHelper spawns a detached PowerShell script that:
//  1. Waits for the current process to exit
//  2. Stops the service
//  3. Copies the new binary over the old one
//  4. Starts the service
//  5. Cleans up temp files
//
// This avoids the race where the agent tries to SCM-stop itself
// (killing the goroutine before it can call Start).
func RestartWithHelper(newBinaryPath, targetPath string) error {
	// Escape single quotes to prevent PowerShell injection
	safeBinary := strings.ReplaceAll(newBinaryPath, "'", "''")
	safeTarget := strings.ReplaceAll(targetPath, "'", "''")

	script := strings.Join([]string{
		"Start-Sleep -Seconds 3",
		"Stop-Service -Name '" + serviceName + "' -Force -ErrorAction SilentlyContinue",
		"Start-Sleep -Seconds 2",
		fmt.Sprintf("Copy-Item -Path '%s' -Destination '%s' -Force", safeBinary, safeTarget),
		"Start-Service -Name '" + serviceName + "'",
		fmt.Sprintf("Remove-Item -Path '%s' -Force -ErrorAction SilentlyContinue", safeBinary),
		"Remove-Item -Path $PSCommandPath -Force -ErrorAction SilentlyContinue",
	}, "\r\n")

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
