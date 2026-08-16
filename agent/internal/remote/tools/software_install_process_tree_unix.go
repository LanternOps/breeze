//go:build !windows

package tools

import (
	"errors"
	"log/slog"
	"os/exec"
	"syscall"
)

// unixInstallerProcessTree puts the installer in its own process group. A
// descendant that reparents to init is unreachable by pid, but it stays in the
// group it was born into, so signalling the group is what actually reaches the
// real installer on a timeout.
type unixInstallerProcessTree struct{}

func newInstallerProcessTree() installerProcessTree { return unixInstallerProcessTree{} }

func (unixInstallerProcessTree) prepare(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func (unixInstallerProcessTree) adopt(*exec.Cmd) {}

func (unixInstallerProcessTree) kill(cmd *exec.Cmd) {
	if cmd.Process == nil || cmd.Process.Pid <= 0 {
		return
	}
	// Setpgid makes the child its own group leader, so its pid IS the group id.
	// SIGKILL rather than a graceful term: the deadline has already killed the
	// leader, and whatever is left has outlived a 30-minute install window.
	// ESRCH just means the group drained on its own first.
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		slog.Warn("failed to terminate installer process group after timeout",
			"pid", cmd.Process.Pid, "error", err.Error())
	}
}

func (unixInstallerProcessTree) release() {}
