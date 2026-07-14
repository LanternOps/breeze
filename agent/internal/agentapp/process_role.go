package agentapp

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// ProcessStartup is the non-secret diagnostic record for one agent or helper
// process startup. CompanionHelper is true only for a user-helper command that
// did not resolve to the main agent binary fallback.
type ProcessStartup struct {
	Binary             string    `json:"binary"`
	ExecutablePath     string    `json:"executablePath"`
	PID                int       `json:"pid"`
	ParentPID          int       `json:"parentPid"`
	WindowsSessionID   uint32    `json:"windowsSessionId"`
	LaunchMode         string    `json:"launchMode"`
	HelperRole         string    `json:"helperRole,omitempty"`
	LifecycleKey       string    `json:"lifecycleKey,omitempty"`
	CompanionHelper    bool      `json:"companionHelper"`
	MainBinaryFallback bool      `json:"mainBinaryFallback"`
	Version            string    `json:"version"`
	CreatedAt          time.Time `json:"createdAt"`
}

func classifyProcess(command, role, executable string, service bool) (string, bool) {
	base := strings.ToLower(filepath.Base(executable))
	fallback := command == "user-helper" && base != strings.ToLower(sessionbroker.UserHelperBinaryName)
	switch {
	case command == "run" && service:
		return "service-run", false
	case command == "run":
		return "console-run", false
	case command == "user-helper" && role == "system":
		return "system-helper", fallback
	case command == "user-helper" && role == "user":
		return "user-helper", fallback
	default:
		return "other", false
	}
}

func processStartupFields(s ProcessStartup) map[string]any {
	return map[string]any{
		"binary":             s.Binary,
		"executablePath":     s.ExecutablePath,
		"pid":                s.PID,
		"parentPid":          s.ParentPID,
		"windowsSessionId":   s.WindowsSessionID,
		"launchMode":         s.LaunchMode,
		"helperRole":         s.HelperRole,
		"lifecycleKey":       s.LifecycleKey,
		"companionHelper":    s.CompanionHelper,
		"mainBinaryFallback": s.MainBinaryFallback,
		"version":            s.Version,
		"createdAt":          s.CreatedAt,
	}
}
