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

	// Log the change before persistence attempt so it always fires
	log.Info("auto_update setting changed", "enabled", enabled)

	// Persist the change to disk
	if err := config.SetAndPersist("auto_update", enabled); err != nil {
		log.Error("failed to persist auto_update setting", "error", err)
		return tools.CommandResult{
			Status: "failed",
			Error:  "failed to persist auto_update setting: " + err.Error(),
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"enabled": enabled,
	}, 0)
}
