//go:build linux

package watchdog

import (
	"fmt"
	"os/exec"
	"strings"
)

const agentServiceName = "breeze-agent"

// osServiceController is the production serviceController on Linux. systemd
// owns the unit lifecycle, so the historical escalation ladder is kept as-is
// and only adapted to the structured contract.
type osServiceController struct{}

func (osServiceController) Recover(attempt int, req RecoveryRequest) (RecoveryResult, error) {
	return escalatingServiceRecover(attempt, req)
}

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
