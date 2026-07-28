//go:build windows

package heartbeat

import (
	"os/exec"
	"syscall"
)

// startDetachedProcess launches name/args in a new process group and releases
// the handle so the child is not waited on and survives the SCM stopping this
// service's process. Same pattern as updater.RestartWithHelper — the child
// must outlive the agent so it can tear the agent's own service down (#2878).
func startDetachedProcess(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
