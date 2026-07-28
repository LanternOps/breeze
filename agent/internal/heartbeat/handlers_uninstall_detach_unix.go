//go:build !windows

package heartbeat

import (
	"os/exec"
	"syscall"
)

// startDetachedProcess launches name/args in its own session (Setsid) and
// releases the handle so the child is not waited on and survives this process
// being killed by launchd/systemd when the agent's own service is stopped
// (#2878). Same detach pattern as tools.agent_restart_darwin.
func startDetachedProcess(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
