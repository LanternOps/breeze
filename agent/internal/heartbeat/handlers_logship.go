package heartbeat

import (
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

var (
	revertMu    sync.Mutex
	revertTimer *time.Timer
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

	if !logging.SetShipperLevel(level) {
		return tools.CommandResult{
			Status: "failed",
			Error:  "log shipper not initialized — agent may not be enrolled or log shipping is not configured",
		}
	}

	// Auto-revert after specified duration (default 60 minutes).
	// Cancel any pending revert timer to prevent goroutine stacking.
	durationMinutes := tools.GetPayloadInt(cmd.Payload, "durationMinutes", 60)
	if durationMinutes > 0 {
		revertMu.Lock()
		if revertTimer != nil {
			revertTimer.Stop()
		}
		revertTimer = time.AfterFunc(time.Duration(durationMinutes)*time.Minute, func() {
			logging.SetShipperLevel("warn")
			log.Info("log shipping level auto-reverted to warn",
				"previousLevel", level,
				"afterMinutes", durationMinutes,
			)
		})
		revertMu.Unlock()
	}

	return tools.NewSuccessResult(map[string]any{
		"newLevel":        level,
		"durationMinutes": durationMinutes,
	}, 0)
}
