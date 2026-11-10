//go:build linux

package tools

import (
	"strings"
	"syscall"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const agentServiceName = "breeze-agent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	cmd := procspawn.Command("systemd-run",
		"--scope",
		"--on-active=3",
		"--",
		"systemctl", "restart", agentServiceName)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	procspawn.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func runAgentRestartNow() error {
	return procspawn.Command("systemctl", "restart", agentServiceName).Run()
}
