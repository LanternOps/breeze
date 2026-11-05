//go:build darwin

package tools

import (
	"os"
	"strings"
	"syscall"

	"github.com/breeze-rmm/agent/internal/procspawn"
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
	cmd := procspawn.Command(self, delayedRestartHelperCommand)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func runAgentRestartNow() error {
	return procspawn.Command("launchctl", "kickstart", "-k", "system/"+agentServiceName).Run()
}
