//go:build linux

package executor

import (
	"os/exec"
	"syscall"
)

// setProcessGroup configures the command to run in its own process group and
// receive SIGKILL if the parent dies (Linux-only Pdeathsig).
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pgid:      0,
		Pdeathsig: syscall.SIGKILL,
	}
}

// killProcessGroup kills the entire process group of the command.
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		return cmd.Process.Kill()
	}
	return syscall.Kill(-pgid, syscall.SIGKILL)
}
