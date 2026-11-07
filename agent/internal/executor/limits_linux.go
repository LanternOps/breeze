//go:build linux

package executor

import (
	"os/exec"
	"syscall"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// setProcessGroup configures the command to run in its own process group and
// receive SIGKILL if the parent dies (Linux-only Pdeathsig).
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pgid:      0,
		Pdeathsig: syscall.SIGKILL,
	}
	procspawn.Prepare(cmd)
}

// hideWindow is a no-op on Linux.
func hideWindow(cmd *exec.Cmd) {}
