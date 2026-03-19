//go:build linux

package tools

import (
	"os/exec"
	"strings"
	"syscall"
)

const agentServiceName = "breeze-agent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	cmd := exec.Command("systemd-run", "--scope", "--",
		"bash", "-c", "sleep 3 && systemctl restart breeze-agent")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
