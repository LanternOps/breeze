//go:build windows

package monitoring

import (
	"fmt"
	"strings"

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
			"binaryPath":  info.BinaryPath,
		},
	}
}

func restartService(name string) error {
	// Stop then start via "net" commands
	if err := runCommand("net", "stop", name); err != nil {
		// Only ignore "not started" errors — log all other stop failures
		errMsg := err.Error()
		if !strings.Contains(errMsg, "not started") &&
			!strings.Contains(errMsg, "service has not been started") {
			log.Warn("service stop failed (non-fatal)", "name", name, "error", errMsg)
		}
	}
	if err := runCommand("net", "start", name); err != nil {
		return fmt.Errorf("failed to start service %s: %w", name, err)
	}
	return nil
}
