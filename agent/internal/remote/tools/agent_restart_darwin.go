//go:build darwin

package tools

import (
	"os/exec"
	"strings"
)

const agentServiceName = "com.breeze.agent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	cmd := exec.Command("bash", "-c",
		"sleep 3 && launchctl kickstart -k system/com.breeze.agent")
	return cmd.Start()
}
