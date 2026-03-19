//go:build linux

package tools

import (
	"os/exec"
	"strings"
)

const agentServiceName = "breeze-agent"

func isAgentService(name string) bool {
	return strings.EqualFold(name, agentServiceName)
}

func spawnDelayedRestart() error {
	cmd := exec.Command("bash", "-c",
		"sleep 3 && systemctl restart breeze-agent")
	return cmd.Start()
}
