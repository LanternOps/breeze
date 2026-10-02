package heartbeat

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

const (
	// defaultLogLevelOverrideMinutes applies when the payload carries no
	// positive durationMinutes. A non-positive value used to disable the
	// auto-revert entirely; an override must now always end (#7416).
	defaultLogLevelOverrideMinutes = 60
	// maxLogLevelOverrideMinutes matches logging.MaxLevelOverrideDuration and
	// the API's zod bound on set_agent_log_level.durationMinutes.
	maxLogLevelOverrideMinutes = int(logging.MaxLevelOverrideDuration / time.Minute)
)

// handleSetLogLevel sets a temporary override of the level this agent ships
// to the API. The override is persisted next to agent.yaml, so it survives a
// service restart and is picked up by the helper processes' shippers within
// their poll interval; it always expires, after which every process ships at
// its configured log_shipping_level again (see logging/leveloverride.go).
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

	durationMinutes := tools.GetPayloadInt(cmd.Payload, "durationMinutes", defaultLogLevelOverrideMinutes)
	if durationMinutes <= 0 {
		durationMinutes = defaultLogLevelOverrideMinutes
	}
	if durationMinutes > maxLogLevelOverrideMinutes {
		durationMinutes = maxLogLevelOverrideMinutes
	}

	st, err := logging.ApplyShipperLevelOverride(level, time.Duration(durationMinutes)*time.Minute)
	if err != nil {
		if errors.Is(err, logging.ErrShipperNotInitialized) {
			return tools.CommandResult{
				Status: "failed",
				Error:  "log shipper not initialized — agent may not be enrolled or log shipping is not configured",
			}
		}
		return tools.CommandResult{Status: "failed", Error: err.Error()}
	}

	if !st.Persisted {
		// The running service ships at the new level, but a restart will
		// drop it and the helpers will never see it. Say so in the result
		// and in Agent Logs rather than reporting a plain success.
		log.Warn("log shipping level override applied in memory only; it will not survive a restart or reach helper processes",
			"level", level, "error", st.PersistError)
	}

	result := map[string]any{
		// newLevel is kept for API builds that predate appliedLevel.
		"newLevel":        st.Level,
		"appliedLevel":    st.Level,
		"baseLevel":       st.BaseLevel,
		"durationMinutes": durationMinutes,
		"expiresAt":       st.ExpiresAt.UTC().Format(time.RFC3339),
		"persisted":       st.Persisted,
	}
	if st.PersistError != "" {
		result["persistError"] = st.PersistError
	}
	return tools.NewSuccessResult(result, 0)
}
