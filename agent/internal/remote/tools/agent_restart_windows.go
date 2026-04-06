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
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
		"Start-Sleep -Seconds 3; Restart-Service -Name BreezeAgent")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Detach so the child survives service stop
	_ = cmd.Process.Release()
	return nil
}

func runAgentRestartNow() error {
	return exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
		"Restart-Service -Name BreezeAgent").Run()
}
