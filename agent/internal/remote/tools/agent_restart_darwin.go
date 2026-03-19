//go:build darwin

package tools

import (
	"os/exec"
	"strings"
	"syscall"
)

const agentServiceName = "com.breeze.agent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	cmd := exec.Command("bash", "-c",
		"sleep 3 && launchctl kickstart -k system/com.breeze.agent")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
