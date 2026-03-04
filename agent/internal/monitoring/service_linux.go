//go:build linux

package monitoring

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func checkService(name string) CheckResult {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "systemctl", "is-active", name)
	output, err := cmd.Output()
	statusStr := strings.TrimSpace(string(output))

	switch statusStr {
	case "active":
		return CheckResult{Status: StatusRunning}
	case "inactive", "deactivating":
		return CheckResult{Status: StatusStopped}
	case "failed":
		return CheckResult{
			Status:  StatusStopped,
			Details: map[string]any{"systemctlStatus": "failed"},
		}
	default:
		if err != nil {
			// Check if the unit exists at all
			checkCmd := exec.CommandContext(ctx, "systemctl", "cat", name)
			if checkErr := checkCmd.Run(); checkErr != nil {
				return CheckResult{
					Status:  StatusNotFound,
					Details: map[string]any{"error": fmt.Sprintf("unit %s not found", name)},
				}
			}
		}
		return CheckResult{
			Status:  "stopped",
			Details: map[string]any{"systemctlStatus": statusStr},
		}
	}
}

func restartService(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "systemctl", "restart", name)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", name, err)
	}
	return nil
}
