//go:build windows

package executor

import "os/exec"

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
