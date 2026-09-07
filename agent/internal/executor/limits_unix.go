//go:build !windows && !linux

package executor

import (
	"os/exec"
	"syscall"
)

// setProcessGroup configures the command to run in its own process group.
// This prevents orphaned child processes.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
		Pgid:    0,
	}
}

// hideWindow is a no-op on non-Windows platforms.
func hideWindow(cmd *exec.Cmd) {}
