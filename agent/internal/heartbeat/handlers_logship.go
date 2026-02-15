package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func handleSetLogLevel(_ *Heartbeat, cmd Command) tools.CommandResult {
	level := tools.GetPayloadString(cmd.Payload, "level", "")
	if level == "" {
		return tools.CommandResult{
			Status: "failed",
			Error:  "missing or invalid level parameter",
		}
	}

	switch level {
	case "debug", "info", "warn", "error":
		// valid
	default:
		return tools.CommandResult{
			Status: "failed",
			Error:  "invalid level: must be debug, info, warn, or error",
		}
	}

	logging.SetShipperLevel(level)

	// Auto-revert after specified duration (default 60 minutes)
	durationMinutes := tools.GetPayloadInt(cmd.Payload, "durationMinutes", 60)
	if durationMinutes > 0 {
		go func() {
			time.Sleep(time.Duration(durationMinutes) * time.Minute)
			logging.SetShipperLevel("warn")
			log.Info("log shipping level auto-reverted to warn",
				"previousLevel", level,
				"afterMinutes", durationMinutes,
			)
		}()
	}

	return tools.NewSuccessResult(map[string]any{
		"newLevel":        level,
		"durationMinutes": durationMinutes,
	}, 0)
}
