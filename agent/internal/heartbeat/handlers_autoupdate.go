package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func handleSetAutoUpdate(h *Heartbeat, cmd Command) tools.CommandResult {
	// Extract the 'enabled' parameter from the payload
	enabled := tools.GetPayloadBool(cmd.Payload, "enabled", false)

	// Update the in-memory config
	h.config.AutoUpdate = enabled

	// Persist the change to disk
	if err := config.SetAndPersist("auto_update", enabled); err != nil {
		return tools.CommandResult{
			Status: "failed",
			Error:  "failed to persist auto_update setting: " + err.Error(),
		}
	}

	log.Info("auto_update setting changed",
		"enabled", enabled,
	)

	return tools.NewSuccessResult(map[string]any{
		"enabled": enabled,
	}, 0)
}
