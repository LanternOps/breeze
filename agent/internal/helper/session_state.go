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

// maxSpawnCrashes is the number of rapid crashes before we enter a cooldown.
const maxSpawnCrashes = 5

// spawnCooldown is how long to wait before retrying after repeated crashes.
const spawnCooldown = 5 * time.Minute

type sessionState struct {
	key         string
	configPath  string
	statusPath  string
	lastConfig  *Config
	pid         int
	watcher     *watcher
	lastApplied time.Time

	// Crash tracking: prevents spawn loops when the helper keeps crashing.
	lastSpawnedPID  int       // PID from the most recent spawn (not overwritten by refreshPID)
	spawnCrashes    int       // consecutive spawns where the helper died before next check
	lastSpawnTime   time.Time // when we last spawned
	cooldownUntil   time.Time // if set, don't spawn until this time
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

// inCooldown returns true if the helper crashed too many times and we should
// wait before spawning again.
func (s *sessionState) inCooldown() bool {
	if s.cooldownUntil.IsZero() {
		return false
	}
	if time.Now().After(s.cooldownUntil) {
		// Cooldown expired — reset and allow spawning.
		s.spawnCrashes = 0
		s.cooldownUntil = time.Time{}
		return false
	}
	return true
}

// recordSpawn notes that we just spawned the helper.
func (s *sessionState) recordSpawn(pid int) {
	s.lastSpawnedPID = pid
	s.lastSpawnTime = time.Now()
}

// recordCrash should be called when a previously-spawned helper is no longer
// running. If crashes exceed the threshold, a cooldown is entered.
func (s *sessionState) recordCrash() {
	s.spawnCrashes++
	if s.spawnCrashes >= maxSpawnCrashes {
		s.cooldownUntil = time.Now().Add(spawnCooldown)
	}
}

// resetCrashes clears the crash counter (called when the helper is confirmed alive).
func (s *sessionState) resetCrashes() {
	s.spawnCrashes = 0
	s.cooldownUntil = time.Time{}
}
