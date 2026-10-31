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
	pid         int // from status file (via refreshPID)
	spawnedPID  int // PID we actually spawned (not overwritten by refreshPID)
	watcher     *watcher
	lastApplied time.Time

	// Set when the on-disk config changed for a running helper that hasn't been
	// restarted yet (#1382). The helper only reads --config at spawn, so a
	// running session must be restarted to pick up new tray settings. We defer
	// the restart while a chat is active, so this flag persists across
	// heartbeats until the session goes idle and the restart actually happens.
	pendingConfigRestart bool

	// Set to true when the watcher gives up after repeated failures.
	// Prevents Apply() from re-spawning and re-creating the watcher.
	// Cleared on helper update, when the installed Assist version differs from
	// gaveUpVersion, or watcherGiveUpRetry after gaveUpAt (#10183).
	watcherGaveUp bool
	gaveUpAt      time.Time
	gaveUpVersion string

	// crashFailures counts Assist exits since its last healthy run (#10302).
	// It lives here rather than in the watcher goroutine so a heartbeat
	// relaunch or a watcher restart cannot silently zero it. Cleared by
	// noteAssistRunningLocked (after watcherHealthyUptime), on give-up, on a
	// not-a-crash watcher exit, and by freshCrashTracking (new binary, rollback
	// restart). Dropped with the state when the session goes away.
	crashFailures int
	// lastSpawnAt is when ensureRunningSession last launched Assist in this
	// session, from any caller (watcher, Apply, update, rollback). Zero only
	// while the agent has not launched Assist in this session since it started;
	// never cleared on exit.
	lastSpawnAt time.Time

	// launchIssue: the install-issue code of a pre-launch refusal in this
	// session (webview2_outdated); "" when the last launch check passed.
	launchIssue string
	// webview2Refusal dedupes the refusal WARN: "<found>><minimum>" of the
	// refusal last logged.
	webview2Refusal string
	// webview2UnknownLogged: the "runtime version not found" WARN fired for
	// this session; reset once a version is read.
	webview2UnknownLogged bool
	// exitProbeErrLogged: a failure to watch Assist for its exit code was
	// logged for this session; reset once a probe opens.
	exitProbeErrLogged bool

	// exitProbes hold running Assist processes open so the watcher can log how
	// they exited (assist_exit.go). Keyed by PID. Guarded by Manager.mu.
	exitProbes map[int]exitProbe
	// lastExit is the most recent Assist exit the watcher observed.
	lastExit      assistExit
	lastExitKnown bool
}

func newSessionState(key, baseDir string) *sessionState {
	sessionDir := filepath.Join(baseDir, "sessions", key)
	return &sessionState{
		key:        key,
		configPath: filepath.Join(sessionDir, "helper_config.yaml"),
		statusPath: filepath.Join(sessionDir, "helper_status.yaml"),
	}
}

// freshCrashTracking gives Assist a fresh chance after a deliberate change
// (new binary, rollback restart): it leaves the give-up state and starts the
// crash count over.
func (s *sessionState) freshCrashTracking() {
	s.watcherGaveUp = false
	s.crashFailures = 0
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
