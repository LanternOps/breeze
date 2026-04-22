package helper

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/secmem"
	"gopkg.in/yaml.v3"
)

var log = logging.L("helper")

// Settings mirrors the API HelperSettings shape.
type Settings struct {
	Enabled            bool   `json:"enabled" yaml:"-"`
	ShowOpenPortal     bool   `json:"showOpenPortal" yaml:"show_open_portal"`
	ShowDeviceInfo     bool   `json:"showDeviceInfo" yaml:"show_device_info"`
	ShowRequestSupport bool   `json:"showRequestSupport" yaml:"show_request_support"`
	PortalUrl          string `json:"portalUrl,omitempty" yaml:"portal_url,omitempty"`
}

// Config is the YAML shape written to helper_config.yaml.
type Config struct {
	ShowOpenPortal     bool   `yaml:"show_open_portal"`
	ShowDeviceInfo     bool   `yaml:"show_device_info"`
	ShowRequestSupport bool   `yaml:"show_request_support"`
	PortalUrl          string `yaml:"portal_url,omitempty"`
	DeviceName         string `yaml:"device_name,omitempty"`
	DeviceStatus       string `yaml:"device_status,omitempty"`
	LastCheckin        string `yaml:"last_checkin,omitempty"`
}

// SpawnFunc launches a helper in the given session with extra CLI args.
// Returns the PID of the spawned process and any error.
type SpawnFunc func(sessionKey string, binaryPath string, args ...string) (pid int, err error)

// ErrNoActiveSession is returned by SpawnFunc when no user session is available.
var ErrNoActiveSession = fmt.Errorf("no active user session")

// Option configures a Manager.
type Option func(*Manager)

// WithSpawnFunc sets a platform-specific function for launching the helper.
func WithSpawnFunc(fn SpawnFunc) Option {
	return func(m *Manager) { m.spawnFunc = fn }
}

// WithSessionEnumerator overrides the default active-session enumerator.
func WithSessionEnumerator(e SessionEnumerator) Option {
	return func(m *Manager) { m.sessionEnumerator = e }
}

// Manager handles helper binary lifecycle: install/update plus per-session runtime state.
type Manager struct {
	mu                sync.Mutex
	binaryPath        string
	baseDir           string
	serverURL         string
	authToken         *secmem.SecureString
	agentID           string
	ctx               context.Context
	spawnFunc         SpawnFunc
	sessionEnumerator SessionEnumerator
	sessions          map[string]*sessionState
	isOurProcessFunc  func(pid int, binaryPath string) bool
	stopByPIDFunc     func(pid int) error

	pendingHelperVersion  string
	updateFailures        int
	abandonedVersion      string // version we gave up updating to
}

// New creates a new helper Manager.
func New(ctx context.Context, serverURL string, authToken *secmem.SecureString, agentID string, opts ...Option) *Manager {
	m := &Manager{
		ctx:               ctx,
		binaryPath:        defaultBinaryPath(),
		baseDir:           defaultBaseDir(),
		serverURL:         serverURL,
		authToken:         authToken,
		agentID:           agentID,
		sessionEnumerator: NewPlatformEnumerator(),
		sessions:          make(map[string]*sessionState),
		isOurProcessFunc:  isOurProcess,
		stopByPIDFunc:     stopByPID,
	}
	for _, opt := range opts {
		opt(m)
	}
	if m.spawnFunc == nil {
		m.spawnFunc = defaultSpawnFunc
	}
	return m
}

func defaultBinaryPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Applications/Breeze Helper.app/Contents/MacOS/breeze-helper"
	case "windows":
		pf := os.Getenv("ProgramFiles")
		if pf == "" {
			pf = `C:\Program Files`
		}
		return filepath.Join(pf, "Breeze Helper", "breeze-helper.exe")
	default:
		return "/usr/local/bin/breeze-helper"
	}
}

// DefaultBinaryPath returns the platform-default Breeze Assist binary path.
func DefaultBinaryPath() string {
	return defaultBinaryPath()
}

func defaultBaseDir() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/Breeze"
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "Breeze")
	default:
		return "/etc/breeze"
	}
}

func defaultSpawnFunc(sessionKey, binaryPath string, args ...string) (int, error) {
	if len(args) >= 2 && args[0] == "--config" {
		return spawnWithConfig(binaryPath, sessionKey, args[1])
	}
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = filepath.Dir(binaryPath)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	return pid, nil
}

// Apply is called on each heartbeat with the latest helper settings.
func (m *Manager) Apply(settings *Settings) {
	if settings == nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.migrateFromLegacyName()
	if m.needsSessionMigration() {
		m.migrateToSessions()
	}

	if m.sessionEnumerator == nil {
		return
	}

	if settings.Enabled && !m.isInstalled() {
		if err := m.downloadAndInstall(); err != nil {
			log.Error("failed to install breeze assist", "error", err.Error())
			return
		}
	}

	activeSessions := m.sessionEnumerator.ActiveSessions()
	activeKeys := make(map[string]bool, len(activeSessions))
	cfg := settingsToConfig(settings)

	for _, si := range activeSessions {
		activeKeys[si.Key] = true
		state, exists := m.sessions[si.Key]
		if !exists {
			state = newSessionState(si.Key, m.baseDir)
			m.sessions[si.Key] = state
		}

		if settings.Enabled {
			if !state.configUnchanged(cfg) {
				if err := m.writeSessionConfig(state, cfg, si); err != nil {
					log.Error("failed to write per-session config", "session", si.Key, "error", err.Error())
					continue
				}
				if !m.helperSupportsConfigFlag() {
					if err := m.writeLegacyConfig(cfg); err != nil {
						log.Warn("failed to write legacy helper config fallback", "error", err.Error())
					}
				}
			}

			state.refreshPID()
			if err := m.ensureRunningSession(state); err != nil {
				log.Error("failed to start breeze assist", "session", si.Key, "error", err.Error())
			} else {
				m.startSessionWatcher(state)
			}
			continue
		}

		state.refreshPID()
		m.stopSessionWatcher(state)
		if err := m.ensureStoppedSession(state); err != nil {
			log.Error("failed to stop breeze assist", "session", si.Key, "error", err.Error())
		}
	}

	for key, state := range m.sessions {
		if activeKeys[key] {
			continue
		}
		state.refreshPID()
		m.stopSessionWatcher(state)
		if err := m.ensureStoppedSession(state); err != nil {
			log.Warn("failed to stop stale helper session", "session", key, "error", err.Error())
		}
		delete(m.sessions, key)
	}

	if settings.Enabled {
		m.applyPendingUpdate()
	} else {
		m.uninstallLocked()
	}
}

// uninstallLocked performs full cleanup when the helper policy is disabled.
// Removes the autostart entry, the installed package, and any per-session
// config/status files. All operations are idempotent so this is safe to call
// every Apply tick while the policy is off.
//
// Must be called with m.mu held.
func (m *Manager) uninstallLocked() {
	if !m.isInstalled() && !m.hasResidualState() {
		return
	}

	if err := removeAutoStartFunc(); err != nil {
		log.Warn("uninstall: remove autostart failed", "error", err.Error())
	}

	if err := uninstallPackageFunc(); err != nil {
		log.Warn("uninstall: remove package failed", "error", err.Error())
	}

	sessionsDir := filepath.Join(m.baseDir, "sessions")
	if err := os.RemoveAll(sessionsDir); err != nil {
		log.Warn("uninstall: remove sessions dir failed", "path", sessionsDir, "error", err.Error())
	}

	if err := os.Remove(m.legacyConfigPath()); err != nil && !os.IsNotExist(err) {
		log.Debug("uninstall: legacy config removal", "error", err.Error())
	}

	m.pendingHelperVersion = ""
	m.abandonedVersion = ""
	m.updateFailures = 0

	log.Info("breeze assist uninstalled")
}

// hasResidualState reports whether per-session helper state still exists on
// disk. Used by uninstallLocked to know when more cleanup is needed even if
// the binary is already gone.
func (m *Manager) hasResidualState() bool {
	if _, err := os.Stat(filepath.Join(m.baseDir, "sessions")); err == nil {
		return true
	}
	return false
}

func settingsToConfig(s *Settings) *Config {
	return &Config{
		ShowOpenPortal:     s.ShowOpenPortal,
		ShowDeviceInfo:     s.ShowDeviceInfo,
		ShowRequestSupport: s.ShowRequestSupport,
		PortalUrl:          s.PortalUrl,
	}
}

func (m *Manager) legacyConfigPath() string {
	return filepath.Join(m.baseDir, "helper_config.yaml")
}

func (m *Manager) writeLegacyConfig(cfg *Config) error {
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal helper config: %w", err)
	}

	path := m.legacyConfigPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create legacy config dir: %w", err)
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("write legacy temp config: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename legacy config: %w", err)
	}
	return nil
}

func (m *Manager) writeSessionConfig(state *sessionState, cfg *Config, si SessionInfo) error {
	dir := filepath.Dir(state.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create session dir: %w", err)
	}
	if runtime.GOOS != "windows" && si.UID > 0 {
		_ = os.Chown(dir, int(si.UID), -1)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	tmp := state.configPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := os.Rename(tmp, state.configPath); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename config: %w", err)
	}

	copied := *cfg
	state.lastConfig = &copied
	state.lastApplied = time.Now()
	return nil
}

// minConfigFlagVersion is the minimum helper version that supports --config.
var minConfigFlagVersion = [3]int{0, 14, 0}

func (m *Manager) ensureRunningSession(state *sessionState) error {
	// First check: scan the process table for breeze-helper.exe in this
	// session. This is the reliable check that the old code used (by process
	// name) — immune to PID tracking failures from cmd.exe wrappers, Tauri
	// re-exec, or missing status files.
	if isHelperRunningInSession(state.key, m.binaryPath) {
		return nil
	}
	// Fallback: check by tracked PIDs.
	if state.spawnedPID > 0 && m.isOurProcessFunc(state.spawnedPID, m.binaryPath) {
		return nil
	}
	if state.pid > 0 && state.pid != state.spawnedPID && m.isOurProcessFunc(state.pid, m.binaryPath) {
		return nil
	}
	if state.watcherGaveUp {
		return fmt.Errorf("helper keeps crashing, not respawning until next update")
	}
	// Kill any lingering helper that we lost track of (e.g. status file had
	// stale PID, so we kept spawning new ones). This prevents accumulating
	// hundreds of orphaned helper processes.
	if state.spawnedPID > 0 && state.spawnedPID != state.pid {
		if m.isOurProcessFunc(state.spawnedPID, m.binaryPath) {
			_ = m.stopByPIDFunc(state.spawnedPID)
		}
	}
	var pid int
	var err error
	if m.helperSupportsConfigFlag() {
		pid, err = m.spawnFunc(state.key, m.binaryPath, "--config", state.configPath)
	} else {
		pid, err = m.spawnFunc(state.key, m.binaryPath)
	}
	if err != nil {
		return err
	}
	state.pid = pid
	state.spawnedPID = pid
	return nil
}

func (m *Manager) helperSupportsConfigFlag() bool {
	v := m.installedVersionLocked()
	if v == "" {
		return false
	}
	return semverAtLeast(v, minConfigFlagVersion)
}

func semverAtLeast(version string, target [3]int) bool {
	v := strings.TrimPrefix(version, "v")
	if idx := strings.IndexByte(v, '-'); idx >= 0 {
		v = v[:idx]
	}
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 3 {
		return false
	}
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return false
		}
		if n > target[i] {
			return true
		}
		if n < target[i] {
			return false
		}
	}
	return true
}

func (m *Manager) ensureStoppedSession(state *sessionState) error {
	// Kill by spawned PID (authoritative) and status-file PID if different.
	for _, pid := range []int{state.spawnedPID, state.pid} {
		if pid > 0 && m.isOurProcessFunc(pid, m.binaryPath) {
			if err := m.stopByPIDFunc(pid); err != nil {
				return err
			}
		}
	}
	state.spawnedPID = 0
	return nil
}

func (m *Manager) allSessionsIdle() bool {
	for _, state := range m.sessions {
		status, err := ReadStatus(state.configPath)
		if err != nil {
			continue
		}
		if status.ChatActive && time.Since(status.LastActivity) < idleTimeout {
			return false
		}
	}
	return true
}

func (m *Manager) isInstalled() bool {
	_, err := os.Stat(m.binaryPath)
	return err == nil
}

// downloadAndInstall downloads the platform-appropriate helper package.
func (m *Manager) downloadAndInstall() error {
	if m.authToken == nil {
		return fmt.Errorf("cannot download helper: auth token not available")
	}
	url := fmt.Sprintf("%s/api/v1/agents/download/helper/%s/%s", m.serverURL, runtime.GOOS, runtime.GOARCH)
	log.Info("downloading helper package", "url", url)

	tmpFile, err := os.CreateTemp("", "breeze-helper-install-*"+packageExtension())
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := downloadFile(url, tmpPath, m.authToken.Reveal()); err != nil {
		return fmt.Errorf("download helper: %w", err)
	}

	if err := installPackage(tmpPath, m.binaryPath); err != nil {
		return fmt.Errorf("install helper package: %w", err)
	}

	log.Info("helper installed", "path", m.binaryPath)
	return nil
}

// CheckUpdate stores a pending Helper version upgrade.
func (m *Manager) CheckUpdate(targetVersion string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if targetVersion == m.abandonedVersion {
		return // already failed for this version, don't retry
	}
	if m.pendingHelperVersion != targetVersion {
		log.Info("helper update pending", "targetVersion", targetVersion)
		m.pendingHelperVersion = targetVersion
		m.updateFailures = 0
		// Only clear abandonedVersion when a genuinely different version is
		// requested. This prevents re-triggering a failed update.
		if m.abandonedVersion != "" && targetVersion != m.abandonedVersion {
			m.abandonedVersion = ""
		}
	}
}

// InstalledVersion returns the first readable per-session helper version.
func (m *Manager) InstalledVersion() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.installedVersionLocked()
}

func (m *Manager) installedVersionLocked() string {
	for _, state := range m.sessions {
		status, err := ReadStatus(state.configPath)
		if err != nil {
			continue
		}
		if status.Version != "" {
			return status.Version
		}
	}
	return ""
}

// applyPendingUpdate checks if a Helper update is pending and all sessions are idle.
// Must be called with m.mu held.
func (m *Manager) applyPendingUpdate() {
	if m.pendingHelperVersion == "" {
		return
	}

	if installed := m.installedVersionLocked(); installed == m.pendingHelperVersion {
		log.Info("helper already at target version, clearing pending update", "version", installed)
		m.pendingHelperVersion = ""
		m.updateFailures = 0
		return
	}

	const maxUpdateFailures = 3
	if m.updateFailures >= maxUpdateFailures {
		log.Warn("helper update abandoned after repeated failures, clearing pending update",
			"targetVersion", m.pendingHelperVersion,
			"failures", m.updateFailures,
		)
		m.abandonedVersion = m.pendingHelperVersion
		m.pendingHelperVersion = ""
		m.updateFailures = 0
		return
	}

	if !m.allSessionsIdle() {
		log.Debug("helper update deferred, chat active", "targetVersion", m.pendingHelperVersion)
		return
	}

	log.Info("helper is idle, applying update", "targetVersion", m.pendingHelperVersion)

	var stopped []*sessionState
	for _, state := range m.sessions {
		state.refreshPID()
		m.stopSessionWatcher(state)
		if err := m.ensureStoppedSession(state); err != nil {
			log.Error("failed to stop helper session for update", "session", state.key, "error", err.Error())
			return
		}
		stopped = append(stopped, state)
	}

	backupPath := m.binaryPath + ".backup"
	if err := copyFile(m.binaryPath, backupPath); err != nil {
		log.Warn("failed to backup helper binary", "error", err.Error())
	}

	if err := m.downloadAndInstall(); err != nil {
		m.updateFailures++
		log.Error("failed to install helper update", "error", err.Error(), "failures", m.updateFailures)
		if restoreErr := restoreBackup(backupPath, m.binaryPath); restoreErr != nil {
			log.Error("failed to rollback helper", "error", restoreErr.Error())
		}
		for _, state := range stopped {
			state.watcherGaveUp = false // intentional stop, not a crash
			if err := m.ensureRunningSession(state); err != nil {
				log.Error("failed to restart helper after rollback", "session", state.key, "error", err.Error())
			} else {
				m.startSessionWatcher(state)
			}
		}
		return
	}

	for _, state := range stopped {
		state.pid = 0
		state.watcherGaveUp = false // new binary — give it a fresh chance
		if err := m.ensureRunningSession(state); err != nil {
			log.Error("failed to start updated helper", "session", state.key, "error", err.Error())
			if restoreErr := restoreBackup(backupPath, m.binaryPath); restoreErr != nil {
				log.Error("failed to rollback helper", "error", restoreErr.Error())
			}
			for _, restartState := range stopped {
				_ = m.ensureRunningSession(restartState)
				m.startSessionWatcher(restartState)
			}
			return
		}
		m.startSessionWatcher(state)
	}

	log.Info("helper updated successfully", "requestedVersion", m.pendingHelperVersion)
	m.pendingHelperVersion = ""
	_ = os.Remove(backupPath)
}

// Shutdown stops all session watchers gracefully.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, state := range m.sessions {
		m.stopSessionWatcher(state)
	}
}

func (m *Manager) startSessionWatcher(state *sessionState) {
	if state.watcher != nil {
		return
	}
	w := newSessionWatcher(m.ctx, m, state)
	state.watcher = w
	go w.run()
}

// stopSessionWatcher cancels the watcher and waits for it to return, but
// never more than watcherStopTimeout — shutdown must not hang if a watcher
// goroutine is stuck inside ensureRunningSession() (process spawn). The
// leaked goroutine is abandoned when the process exits.
func (m *Manager) stopSessionWatcher(state *sessionState) {
	if state == nil || state.watcher == nil {
		return
	}
	w := state.watcher
	state.watcher = nil
	w.cancel()
	m.mu.Unlock()
	select {
	case <-w.done:
	case <-time.After(watcherStopTimeout):
		log.Warn("session watcher shutdown timed out, abandoning", "session", state.key)
	}
	m.mu.Lock()
}

const watcherStopTimeout = 2 * time.Second

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0755)
}

func restoreBackup(backupPath, targetPath string) error {
	return os.Rename(backupPath, targetPath)
}
