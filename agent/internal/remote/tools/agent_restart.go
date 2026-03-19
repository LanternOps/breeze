package tools

import (
	"fmt"
	"time"
)

// RestartAgentService spawns a background process that restarts the agent
// service after a short delay, then returns success immediately so the
// command result can be reported back before the agent dies.
func RestartAgentService(startTime time.Time) CommandResult {
	err := spawnDelayedRestart()
	if err != nil {
		return NewErrorResult(
			fmt.Errorf("failed to schedule agent restart: %w", err),
			time.Since(startTime).Milliseconds(),
		)
	}

	result := map[string]any{
		"name":    agentServiceName,
		"action":  "restart",
		"delayed": true,
		"message": "Agent restart scheduled — service will restart in a few seconds",
	}
	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}
