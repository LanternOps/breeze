//go:build !windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Restart tries service managers in order, then falls back to exec.
func Restart() error {
	// Try systemd first (Linux)
	if err := restartSystemd(); err == nil {
		return nil
	}

	// Try launchd (macOS)
	if err := restartLaunchd(); err == nil {
		return nil
	}

	// No service manager available
	log.Warn("no service manager detected, falling back to exec — agent will not auto-restart on crash")
	return restartExec()
}

func restartSystemd() error {
	out, err := exec.Command("systemctl", "restart", "breeze-agent").CombinedOutput()
	if err != nil {
		log.Warn("systemd restart failed", "error", err.Error(), "output", string(out))
		return err
	}
	log.Info("restarted via systemd")
	return nil
}

func restartLaunchd() error {
	out, err := exec.Command("launchctl", "kickstart", "-k", "system/com.breeze.agent").CombinedOutput()
	if err != nil {
		log.Warn("launchd restart failed", "error", err.Error(), "output", string(out))
		return err
	}
	log.Info("restarted via launchd")
	return nil
}

// RestartWithHelper is Windows-only; on Unix it's never called because
// updater.go gates on runtime.GOOS == "windows".
func RestartWithHelper(_, _ string) error {
	return fmt.Errorf("RestartWithHelper is only supported on Windows")
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

	log.Info("restarting via exec", "binary", binary)
	args := []string{binary, "run"}
	env := os.Environ()

	return syscall.Exec(binary, args, env)
}
