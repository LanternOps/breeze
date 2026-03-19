//go:build windows

package tools

import (
	"os/exec"
	"strings"
	"syscall"
)

const agentServiceName = "BreezeAgent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	cmd := exec.Command("powershell", "-WindowStyle", "Hidden", "-Command",
		"Start-Sleep -Seconds 3; Restart-Service BreezeAgent")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008} // DETACHED_PROCESS
	return cmd.Start()
}
