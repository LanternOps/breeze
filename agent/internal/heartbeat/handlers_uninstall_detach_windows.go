//go:build windows

package heartbeat

import (
	"syscall"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// startDetachedProcess launches name/args in a new process group and releases
// the handle so the child is not waited on and survives the SCM stopping this
// service's process. Same pattern as updater.RestartWithHelper — the child
// must outlive the agent so it can tear the agent's own service down (#2878).
func startDetachedProcess(name string, args ...string) error {
	cmd := procspawn.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// startWatchedDetachedProcess is startDetachedProcess that keeps the handle
// and waits on it, so the agent learns if the child exits while the agent is
// still running (#11154). Waiting does not tie the child's lifetime to ours.
func startWatchedDetachedProcess(name string, args ...string) (<-chan int, error) {
	cmd := procspawn.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	procspawn.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return watchExit(cmd), nil
}
