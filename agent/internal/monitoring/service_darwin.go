//go:build darwin

package monitoring

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

func checkService(name string) CheckResult {
	info, err := svcquery.GetStatus(name)
	if err != nil {
		return CheckResult{
			Status:  StatusNotFound,
			Details: map[string]any{"error": err.Error()},
		}
	}

	status := CheckStatus(StatusStopped)
	if info.IsActive() {
		status = StatusRunning
	}

	return CheckResult{
		Status: status,
		Details: map[string]any{
			"displayName": info.DisplayName,
			"startType":   info.StartType,
		},
	}
}

func restartService(name string) error {
	// Stop then start via launchctl
	info, err := svcquery.GetStatus(name)
	if err != nil {
		return fmt.Errorf("cannot find service %s: %w", name, err)
	}

	// Use the resolved name (may have prefix)
	resolvedName := info.Name

	// Stop if running
	if info.IsActive() {
		if err := runCommand("launchctl", "stop", resolvedName); err != nil {
			return fmt.Errorf("failed to stop service %s: %w", resolvedName, err)
		}
	}

	// Start
	if err := runCommand("launchctl", "start", resolvedName); err != nil {
		return fmt.Errorf("failed to start service %s: %w", resolvedName, err)
	}

	return nil
}
