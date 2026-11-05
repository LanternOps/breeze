//go:build !windows

package heartbeat

import (
	"syscall"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// startDetachedProcess launches name/args in its own session (Setsid) and
// releases the handle so the child is not waited on and survives this process
// being killed by launchd/systemd when the agent's own service is stopped
// (#2878). Same detach pattern as tools.agent_restart_darwin.
func startDetachedProcess(name string, args ...string) error {
	cmd := procspawn.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	procspawn.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
