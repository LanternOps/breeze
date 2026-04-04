package helper

import (
	"path/filepath"
	"time"
)

// SessionEnumerator discovers active interactive sessions via OS-level APIs.
type SessionEnumerator interface {
	ActiveSessions() []SessionInfo
}

// SessionInfo describes an interactive session eligible for Assist.
type SessionInfo struct {
	Key      string
	Username string
	UID      uint32
}

type sessionState struct {
	key         string
	configPath  string
	statusPath  string
	lastConfig  *Config
	pid         int
	watcher     *watcher
	lastApplied time.Time

	// Set to true when the watcher gives up after repeated failures.
	// Prevents Apply() from re-spawning and re-creating the watcher.
	// Cleared on helper update or when the helper binary changes.
	watcherGaveUp bool
}

func newSessionState(key, baseDir string) *sessionState {
	sessionDir := filepath.Join(baseDir, "sessions", key)
	return &sessionState{
		key:        key,
		configPath: filepath.Join(sessionDir, "helper_config.yaml"),
		statusPath: filepath.Join(sessionDir, "helper_status.yaml"),
	}
}

func (s *sessionState) configUnchanged(cfg *Config) bool {
	if s.lastConfig == nil {
		return false
	}
	return s.lastConfig.ShowOpenPortal == cfg.ShowOpenPortal &&
		s.lastConfig.ShowDeviceInfo == cfg.ShowDeviceInfo &&
		s.lastConfig.ShowRequestSupport == cfg.ShowRequestSupport &&
		s.lastConfig.PortalUrl == cfg.PortalUrl &&
		s.lastConfig.DeviceName == cfg.DeviceName &&
		s.lastConfig.DeviceStatus == cfg.DeviceStatus &&
		s.lastConfig.LastCheckin == cfg.LastCheckin
}

func (s *sessionState) refreshPID() {
	status, err := ReadStatus(s.statusPath)
	if err != nil {
		return
	}
	s.pid = status.PID
}
