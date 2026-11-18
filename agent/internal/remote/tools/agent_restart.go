package tools

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/flashguard"
)

const delayedRestartHelperCommand = "internal-delayed-restart"

// spawnDelayedRestartFn is a seam so a test never restarts a real service.
var spawnDelayedRestartFn = spawnDelayedRestart

// RestartAgentService spawns a background process that restarts the agent
// service after a short delay, then returns success immediately so the
// command result can be reported back before the agent dies.
func RestartAgentService(startTime time.Time) CommandResult {
	slog.Info("agent restart requested via service manager")
	// Refused during a firmware update. On success the admission is kept through
	// the hand-off: the helper stops this process a few seconds from now, and a
	// flash must not start in the meantime. If the restart never comes, it lapses.
	done, err := flashguard.Default().AdmitPowerAction("agent_restart")
	if err != nil {
		return NewErrorResult(fmt.Errorf("agent restart refused: %w", err), time.Since(startTime).Milliseconds())
	}
	err = spawnDelayedRestartFn()
	if err != nil {
		done()
		slog.Error("failed to spawn delayed restart", "error", err.Error())
		return NewErrorResult(
			fmt.Errorf("failed to schedule agent restart: %w", err),
			time.Since(startTime).Milliseconds(),
		)
	}

	flashguard.HoldFor(done, flashguard.RestartHandoffHold)
	slog.Info("delayed restart process spawned, agent will restart in ~3 seconds")

	result := map[string]any{
		"name":    agentServiceName,
		"action":  "restart",
		"delayed": true,
		"message": "Agent restart scheduled — service will restart in a few seconds",
	}
	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

// RunDelayedRestartHelper is executed by a detached helper subprocess so the
// current service instance can return its response before the actual restart.
func RunDelayedRestartHelper() error {
	time.Sleep(3 * time.Second)
	return runAgentRestartNow()
}
