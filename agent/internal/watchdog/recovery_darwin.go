//go:build darwin

package watchdog

import (
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const agentServiceLabel = "com.breeze.agent"

// osServiceController is the production serviceController on macOS. launchd
// owns the daemon lifecycle, so the historical escalation ladder is kept as-is
// and only adapted to the structured contract.
type osServiceController struct{}

func (osServiceController) Recover(attempt int, req RecoveryRequest) (RecoveryResult, error) {
	return escalatingServiceRecover(attempt, req)
}

// restartAgentService restarts the launchd service for the agent.
// It tries "launchctl kickstart -k" first (modern), then falls back to
// bootout + bootstrap (also modern) if kickstart is not available.
func restartAgentService() error {
	out, err := procspawn.Command("launchctl", "kickstart", "-k", "system/"+agentServiceLabel).CombinedOutput()
	if err == nil {
		return nil
	}

	// Fallback: bootout then bootstrap.
	bootoutErr := procspawn.Command("launchctl", "bootout", "system/"+agentServiceLabel).Run()
	if bootoutErr != nil {
		// Ignore bootout error — service may not be loaded.
		_ = bootoutErr
	}

	const darwinPlistPath = "/Library/LaunchDaemons/com.breeze.agent.plist"
	out, err = procspawn.Command("launchctl", "bootstrap", "system", darwinPlistPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl bootstrap failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// startAgentService starts the launchd service for the agent.
// If the service is already loaded, kickstart is used; otherwise bootstrap.
func startAgentService() error {
	// Check if already loaded.
	loaded := procspawn.Command("launchctl", "print", "system/"+agentServiceLabel).Run() == nil

	if loaded {
		out, err := procspawn.Command("launchctl", "kickstart", "system/"+agentServiceLabel).CombinedOutput()
		if err != nil {
			return fmt.Errorf("launchctl kickstart failed: %s: %w", strings.TrimSpace(string(out)), err)
		}
		return nil
	}

	// Not loaded — bootstrap from plist.
	const darwinPlistPath = "/Library/LaunchDaemons/com.breeze.agent.plist"
	out, err := procspawn.Command("launchctl", "bootstrap", "system", darwinPlistPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl bootstrap failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}
