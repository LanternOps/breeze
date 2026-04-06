//go:build darwin

package tools

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

const agentServiceName = "com.breeze.agent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, delayedRestartHelperCommand)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func runAgentRestartNow() error {
	return exec.Command("launchctl", "kickstart", "-k", "system/"+agentServiceName).Run()
}
