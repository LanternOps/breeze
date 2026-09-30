package config

import (
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/logging"
)

// LogLevelOverridePath is where the agent persists a set_log_level override
// and where every process's log shipper looks for it (#7416). It lives in the
// config directory next to agent.yaml — a location the agent service can
// write and the helpers (including the macOS/Linux user-session ones) can
// read. Every InitShipper call site passes this as
// ShipperConfig.LevelOverridePath.
func LogLevelOverridePath() string {
	return filepath.Join(ConfigDir(), logging.LevelOverrideFileName)
}
