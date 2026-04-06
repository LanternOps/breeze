//go:build linux

package watchdog

import (
	"fmt"
	"os/exec"
	"strings"
)

const agentServiceName = "breeze-agent"

// restartAgentService restarts the systemd unit for the agent.
func restartAgentService() error {
	out, err := exec.Command("systemctl", "restart", agentServiceName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// startAgentService starts the systemd unit for the agent.
func startAgentService() error {
	out, err := exec.Command("systemctl", "start", agentServiceName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl start failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}
