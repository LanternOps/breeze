package tools

import (
	"fmt"
	"log/slog"
	"time"
)

const delayedRestartHelperCommand = "internal-delayed-restart"

// RestartAgentService spawns a background process that restarts the agent
// service after a short delay, then returns success immediately so the
// command result can be reported back before the agent dies.
func RestartAgentService(startTime time.Time) CommandResult {
	slog.Info("agent restart requested via service manager")
	err := spawnDelayedRestart()
	if err != nil {
		slog.Error("failed to spawn delayed restart", "error", err.Error())
		return NewErrorResult(
			fmt.Errorf("failed to schedule agent restart: %w", err),
			time.Since(startTime).Milliseconds(),
		)
	}

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
