package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// isPermissionError checks whether an error chain contains a permission-denied error.
func isPermissionError(err error) bool {
	if errors.Is(err, os.ErrPermission) {
		return true
	}
	// Also check for EACCES directly (covers wrapped syscall errors)
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return errors.Is(pathErr.Err, syscall.EACCES)
	}
	return false
}

// isSystemServiceRunning checks if the Breeze Agent is running as a system service.
func isSystemServiceRunning() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	switch runtime.GOOS {
	case "darwin":
		return exec.CommandContext(ctx, "launchctl", "print", "system/com.breeze.agent").Run() == nil
	case "linux":
		out, err := exec.CommandContext(ctx, "systemctl", "is-active", "breeze-agent").Output()
		return err == nil && strings.TrimSpace(string(out)) == "active"
	case "windows":
		out, err := exec.CommandContext(ctx, "sc", "query", "BreezeAgent").Output()
		return err == nil && strings.Contains(string(out), "RUNNING")
	default:
		return false
	}
}
