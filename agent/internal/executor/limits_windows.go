//go:build windows

package executor

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// setProcessGroup is a no-op on Windows. Job Objects could be used for full
// process tree management but are deferred to a future enhancement.
func setProcessGroup(cmd *exec.Cmd) {}

// killProcessGroup kills the process directly on Windows.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

// hideWindow prevents the spawned shell (powershell.exe, cmd.exe, etc.) from
// allocating a visible console window when the user-helper (linked
// -H windowsgui) executes a user-context script. Without CREATE_NO_WINDOW the
// kernel attaches a fresh console to console-subsystem children.
func hideWindow(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
