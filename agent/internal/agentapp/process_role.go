package agentapp

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type platformProcessMetadata struct {
	ParentPID        int
	WindowsSessionID uint32
	CreatedAt        time.Time
}

// ProcessStartup is the non-secret diagnostic record for one agent or helper
// process startup. CompanionHelper is true only for a user-helper command that
// did not resolve to the main agent binary fallback.
type ProcessStartup struct {
	Binary             string         `json:"binary"`
	ExecutablePath     string         `json:"executablePath"`
	PID                int            `json:"pid"`
	ParentPID          int            `json:"parentPid"`
	WindowsSessionID   uint32         `json:"windowsSessionId"`
	LaunchMode         string         `json:"launchMode"`
	HelperRole         ipc.HelperRole `json:"helperRole,omitempty"`
	LifecycleKey       string         `json:"lifecycleKey,omitempty"`
	CompanionHelper    bool           `json:"companionHelper"`
	MainBinaryFallback bool           `json:"mainBinaryFallback"`
	Version            string         `json:"version"`
	CreatedAt          time.Time      `json:"createdAt"`
}

var mainProcessStartupCache struct {
	sync.RWMutex
	startup ProcessStartup
}

func cacheMainProcessStartup(startup ProcessStartup) {
	mainProcessStartupCache.Lock()
	mainProcessStartupCache.startup = startup
	mainProcessStartupCache.Unlock()
}

func cachedMainProcessStartup() ProcessStartup {
	mainProcessStartupCache.RLock()
	startup := mainProcessStartupCache.startup
	mainProcessStartupCache.RUnlock()
	if startup.PID != 0 {
		return startup
	}
	return currentProcessStartup("run", "", isWindowsService())
}

func currentProcessStartup(command string, role ipc.HelperRole, service bool) ProcessStartup {
	executable, _ := os.Executable()
	metadata := currentPlatformProcessMetadata()
	mode, fallback := classifyProcess(command, role, executable, service)
	lifecycleKey := ""
	if metadata.WindowsSessionID != 0 && (role == ipc.HelperRoleUser || role == ipc.HelperRoleSystem) {
		lifecycleKey = fmt.Sprintf("%d-%s", metadata.WindowsSessionID, role)
	}

	return ProcessStartup{
		Binary:             filepath.Base(executable),
		ExecutablePath:     executable,
		PID:                os.Getpid(),
		ParentPID:          metadata.ParentPID,
		WindowsSessionID:   metadata.WindowsSessionID,
		LaunchMode:         mode,
		HelperRole:         role,
		LifecycleKey:       lifecycleKey,
		CompanionHelper:    command == "user-helper" && !fallback,
		MainBinaryFallback: fallback,
		Version:            version,
		CreatedAt:          metadata.CreatedAt,
	}
}

func classifyProcess(command string, role ipc.HelperRole, executable string, service bool) (string, bool) {
	base := strings.ToLower(filepath.Base(executable))
	fallback := command == "user-helper" && base != strings.ToLower(sessionbroker.UserHelperBinaryName)
	switch {
	case command == "run" && service:
		return "service-run", false
	case command == "run":
		return "console-run", false
	case command == "user-helper" && role == ipc.HelperRoleSystem:
		return "system-helper", fallback
	case command == "user-helper" && role == ipc.HelperRoleUser:
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

func logProcessStartup(startup ProcessStartup) {
	fields := processStartupFields(startup)
	keys := []string{
		"binary",
		"executablePath",
		"pid",
		"parentPid",
		"windowsSessionId",
		"launchMode",
		"helperRole",
		"lifecycleKey",
		"companionHelper",
		"mainBinaryFallback",
		"version",
		"createdAt",
	}
	args := make([]any, 0, len(keys)*2)
	for _, key := range keys {
		args = append(args, key, fields[key])
	}
	log.Info("process startup", args...)
}
