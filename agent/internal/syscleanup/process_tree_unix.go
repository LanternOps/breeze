//go:build !windows

package syscleanup

import (
	"context"
	"errors"
	"os/exec"
	"syscall"
)

// unixProcessTree puts the cleaner in its own process group. A descendant that
// reparents to init is unreachable by pid but stays in the group it was born
// into, so signalling the group is what actually reaches it.
type unixProcessTree struct{}

func newProcessTree() processTree { return unixProcessTree{} }

func (unixProcessTree) prepare(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func (unixProcessTree) adopt(*exec.Cmd) {}

func (unixProcessTree) kill(cmd *exec.Cmd) {
	if cmd.Process == nil || cmd.Process.Pid <= 0 {
		return
	}
	// Setpgid makes the child its own group leader, so its pid IS the group
	// id. SIGKILL rather than a graceful term: the deadline has already
	// elapsed. ESRCH just means the group drained first.
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		log.Warn("failed to terminate cleaner process group after timeout",
			"pid", cmd.Process.Pid, "error", err.Error())
	}
}

func (unixProcessTree) release() {}

func (unixProcessTree) drain(context.Context) error { return nil }
