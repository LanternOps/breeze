//go:build windows

package tools

import (
	"fmt"
	"log/slog"
	"os/exec"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/safemode"
)

// RebootToSafeMode sets the BCD safeboot flag to "network" and initiates
// a system reboot. If the shutdown command fails, the BCD flag is rolled
// back to prevent an accidental safe mode boot on the next organic reboot.
// An optional delay (minutes, 0-1440) is supported; converted to seconds
// for the Windows shutdown command.
func RebootToSafeMode(payload map[string]any) CommandResult {
	startTime := time.Now()

	delay := GetPayloadInt(payload, "delay", 0)
	if delay < 0 {
		delay = 0
	} else if delay > 1440 {
		delay = 1440
	}

	slog.Info("reboot to safe mode requested", "delayMinutes", delay)

	// Set BCD safe mode flag before initiating reboot.
	if err := safemode.SetSafeBootNetwork(); err != nil {
		slog.Error("failed to set BCD safeboot flag", "error", err.Error())
		return NewErrorResult(fmt.Errorf("failed to set safe mode: %w", err), time.Since(startTime).Milliseconds())
	}
	slog.Info("BCD safeboot flag set to network")

	// Initiate reboot. Delay is in minutes, shutdown /t expects seconds.
	delaySeconds := delay * 60
	cmd := exec.Command("shutdown", "/r", "/t", strconv.Itoa(delaySeconds))
	if err := cmd.Run(); err != nil {
		// Rollback: clear the BCD flag so the machine doesn't accidentally
		// enter safe mode on the next organic reboot.
		rollbackErr := safemode.ClearSafeBootFlag()
		errMsg := fmt.Sprintf("failed to initiate reboot: %v", err)
		if rollbackErr != nil {
			slog.Error("CRITICAL: shutdown failed and BCD rollback also failed",
				"shutdownError", err.Error(), "rollbackError", rollbackErr.Error())
			errMsg += fmt.Sprintf("; CRITICAL: also failed to rollback BCD flag: %v", rollbackErr)
		} else {
			slog.Warn("shutdown failed, BCD safeboot flag rolled back", "error", err.Error())
		}
		return NewErrorResult(fmt.Errorf("%s", errMsg), time.Since(startTime).Milliseconds())
	}

	slog.Info("safe mode reboot initiated", "delayMinutes", delay)

	result := map[string]any{
		"command": CmdRebootSafeMode,
		"delay":   delay,
		"mode":    "network",
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}
