//go:build darwin

package watchdog

import (
	"fmt"
	"os/exec"
	"strings"
)

const agentServiceLabel = "com.breeze.agent"

// restartAgentService restarts the launchd service for the agent.
// It tries "launchctl kickstart -k" first (modern), then falls back to
// bootout + bootstrap (also modern) if kickstart is not available.
func restartAgentService() error {
	out, err := exec.Command("launchctl", "kickstart", "-k", "system/"+agentServiceLabel).CombinedOutput()
	if err == nil {
		return nil
	}

	// Fallback: bootout then bootstrap.
	bootoutErr := exec.Command("launchctl", "bootout", "system/"+agentServiceLabel).Run()
	if bootoutErr != nil {
		// Ignore bootout error — service may not be loaded.
		_ = bootoutErr
	}

	const darwinPlistPath = "/Library/LaunchDaemons/com.breeze.agent.plist"
	out, err = exec.Command("launchctl", "bootstrap", "system", darwinPlistPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl bootstrap failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// startAgentService starts the launchd service for the agent.
// If the service is already loaded, kickstart is used; otherwise bootstrap.
func startAgentService() error {
	// Check if already loaded.
	loaded := exec.Command("launchctl", "print", "system/"+agentServiceLabel).Run() == nil

	if loaded {
		out, err := exec.Command("launchctl", "kickstart", "system/"+agentServiceLabel).CombinedOutput()
		if err != nil {
			return fmt.Errorf("launchctl kickstart failed: %s: %w", strings.TrimSpace(string(out)), err)
		}
		return nil
	}

	// Not loaded — bootstrap from plist.
	const darwinPlistPath = "/Library/LaunchDaemons/com.breeze.agent.plist"
	out, err := exec.Command("launchctl", "bootstrap", "system", darwinPlistPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl bootstrap failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}
