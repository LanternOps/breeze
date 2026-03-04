//go:build windows

package monitoring

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

func checkService(name string) CheckResult {
	info, err := svcquery.GetStatus(name)
	if err != nil {
		return CheckResult{
			Status:  "not_found",
			Details: map[string]any{"error": err.Error()},
		}
	}

	status := "stopped"
	if info.IsActive() {
		status = "running"
	}

	return CheckResult{
		Status: status,
		Details: map[string]any{
			"displayName": info.DisplayName,
			"startType":   info.StartType,
			"binaryPath":  info.BinaryPath,
		},
	}
}

func restartService(name string) error {
	// Use the existing svcquery/tools restart mechanism
	if err := runCommand("net", "stop", name); err != nil {
		// Ignore stop errors — service may already be stopped
		_ = err
	}
	if err := runCommand("net", "start", name); err != nil {
		return fmt.Errorf("failed to start service %s: %w", name, err)
	}
	return nil
}
