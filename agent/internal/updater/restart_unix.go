//go:build !windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Restart restarts the agent service
func Restart() error {
	// Try systemd first (Linux)
	if err := restartSystemd(); err == nil {
		return nil
	}

	// Try launchd (macOS)
	if err := restartLaunchd(); err == nil {
		return nil
	}

	// Fall back to exec syscall
	return restartExec()
}

func restartSystemd() error {
	cmd := exec.Command("systemctl", "restart", "breeze-agent")
	return cmd.Run()
}

func restartLaunchd() error {
	cmd := exec.Command("launchctl", "kickstart", "-k", "system/com.breeze.agent")
	return cmd.Run()
}

func restartExec() error {
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}

	// Resolve symlinks
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return fmt.Errorf("failed to resolve symlinks: %w", err)
	}

	args := []string{binary, "run"}
	env := os.Environ()

	return syscall.Exec(binary, args, env)
}
