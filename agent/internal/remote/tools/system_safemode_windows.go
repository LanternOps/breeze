//go:build windows

package tools

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/safemode"
)

// RebootToSafeMode sets the BCD safeboot flag to "network" and initiates
// a system reboot. If the shutdown command fails, the BCD flag is rolled
// back to prevent an accidental safe mode boot on the next organic reboot.
// An optional delay (minutes, 0-1440) is supported; buildShutdownCommand
// applies the minutes→seconds conversion the Windows `shutdown /t` flag needs.
func RebootToSafeMode(payload map[string]any) CommandResult {
	startTime := time.Now()

	delay := clampShutdownDelayMinutes(GetPayloadInt(payload, "delay", 0))

	slog.Info("reboot to safe mode requested", "delayMinutes", delay)

	// Build the command BEFORE touching the BCD flag, so a construction error
	// can never strand the machine with safeboot set and no reboot scheduled.
	cmd, err := buildShutdownCommand(true, delay)
	if err != nil {
		slog.Error("failed to build shutdown command", "error", err.Error())
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	// Set BCD safe mode flag before initiating reboot.
	if err := safemode.SetSafeBootNetwork(); err != nil {
		slog.Error("failed to set BCD safeboot flag", "error", err.Error())
		return NewErrorResult(fmt.Errorf("failed to set safe mode: %w", err), time.Since(startTime).Milliseconds())
	}
	slog.Info("BCD safeboot flag set to network")

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
