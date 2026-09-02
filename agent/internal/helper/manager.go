package helper

import (
	"context"
	"fmt"
	"math"
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
	"github.com/breeze-rmm/agent/internal/updater"
	"gopkg.in/yaml.v3"
)

var log = logging.L("helper")

// sweepLegacyAutoStart enables the one-time HKLM Run cleanup in Apply. The
// value only ever exists on Windows (legacy installs); other platforms use
// launchd/systemd artifacts handled by migrate/uninstall.
var sweepLegacyAutoStart = runtime.GOOS == "windows"

// Settings mirrors the API HelperSettings shape.
type Settings struct {
	Enabled bool `json:"enabled" yaml:"-"`
	// ShowTrayIcon controls whether Breeze Assist draws its system-tray icon.
	// Independent of Enabled: the helper still serves chat, remote-access
	// consent and PAM dialogs with the icon hidden (#3202). Callers must
	// default this to TRUE when the server omits the field — see
	// heartbeat.HelperSettings.ShowTrayIcon, which is a *bool for that reason.
	ShowTrayIcon       bool   `json:"showTrayIcon" yaml:"show_tray_icon"`
	ShowOpenPortal     bool   `json:"showOpenPortal" yaml:"show_open_portal"`
	ShowDeviceInfo     bool   `json:"showDeviceInfo" yaml:"show_device_info"`
	ShowRequestSupport bool   `json:"showRequestSupport" yaml:"show_request_support"`
	PortalUrl          string `json:"portalUrl,omitempty" yaml:"portal_url,omitempty"`
}

const watcherStopTimeout = 2 * time.Second

// Config is the YAML shape written to helper_config.yaml.
type Config struct {
	ShowTrayIcon       bool   `yaml:"show_tray_icon"`
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

// WithAgentVersion sets the currently-running agent version, forwarded to the
// verified helper downloader as CurrentVersion.
func WithAgentVersion(v string) Option {
	return func(m *Manager) { m.agentVersion = v }
}

// WithManifestKeys sets a PROVIDER for the deployment-pinned Ed25519
// release-manifest public keys (merged with the embedded trust root in the
// updater) so self-host deployments can verify locally-signed helper manifests.
//
// A provider, not a slice, for the same reason WithBackupServerURL takes one:
// the pinned set is replaced at RUNTIME — the manifest-trust-pin path and
// applyManifestKeyDelegations both rewrite it after a config.Reload(), and the
// main/watchdog updaters re-read it through the heartbeat's guarded accessor.
// Baking a startup snapshot into downloadFunc meant that once the delegated key
// was activated the server signed helper manifests with the new key ID while
// this Manager still verified against the frozen old set, so Breeze Assist
// install/update failed closed until the agent process restarted, with no
// server-side signal.
//
// Nil is treated as "no deployment-pinned keys" (embedded trust root only).
func WithManifestKeys(keys func() []string) Option {
	return func(m *Manager) { m.manifestKeys = keys }
}

// WithRequireManifestSigningKeyID mirrors the agent config field of the same
// name onto the verified helper downloader, so a helper download response that
// omits signingKeyId fails closed on exactly the agents where the agent's own
// self-update does. Without it the helper path would stay in compatibility
// mode after the fleet was switched over — a manifest could still be verified
// by a key other than the one it names.
//
// Also a provider: the control plane can push require_manifest_signing_key_id
// through configUpdate at runtime (wave-6 deviation D4), and a frozen `false`
// here would leave the helper path permanently in compatibility mode on an
// agent whose own self-update had already been switched to strict.
//
// Nil is treated as false (compatibility mode).
func WithRequireManifestSigningKeyID(require func() bool) Option {
	return func(m *Manager) { m.requireManifestSigningKeyID = require }
}

// WithBackupServerURL sets a provider for the configured backup control-plane
// URL, threaded into the verified downloader's netpolicy.Policy so the backup
// origin (not just serverURL's primary) is reachable for helper downloads
// after a failover. Omitting this option leaves the backup control plane
// unreachable for helper downloads even if serverURL follows the promotion —
// it does not default to serverURL's value.
func WithBackupServerURL(backupServerURL func() string) Option {
	return func(m *Manager) { m.backupServerURL = backupServerURL }
}

// Manager handles helper binary lifecycle: install/update plus per-session runtime state.
type Manager struct {
	mu         sync.Mutex
	binaryPath string
	baseDir    string
	// serverURL resolves the control-plane base URL. It is a provider
	// (func() string) rather than a plain string so the verified downloader
	// re-resolves it at call time and follows the heartbeat's backup-server-URL
	// promotion (#2323) after a failover, instead of pinning the dead primary
	// captured at construction (#2478).
	serverURL func() string
	// backupServerURL resolves the configured backup control-plane URL, set
	// via WithBackupServerURL. Nil means no backup is configured/known to
	// this Manager — defaultHelperDownloader treats that as "no backup", not
	// an error.
	backupServerURL   func() string
	authToken         *secmem.SecureString
	agentID           string
	ctx               context.Context
	spawnFunc         SpawnFunc
	sessionEnumerator SessionEnumerator
	sessions          map[string]*sessionState
	isOurProcessFunc  func(pid int, binaryPath string) bool
	// stopIfOursFunc terminates a helper by PID only after confirming, on the
	// SAME OS process handle it kills with, that the PID is a Breeze helper.
	// This is the single-handle check-and-terminate that closes the PID-reuse
	// TOCTOU (#2531) — never split the identity check and the kill back into
	// two separate isOurProcess()+stopByPID() opens.
	stopIfOursFunc func(pid int, binaryPath string) (bool, error)

	// downloadFunc fetches and INTEGRITY-VERIFIES the helper package for the
	// given version, returning the path to a verified temp file. In production
	// this is the updater-backed verified downloader (defaultHelperDownloader)
	// that enforces signed-manifest + SHA-256 verification and control-plane
	// origin. Tests inject a stub. It is NEVER the old unverified fetch.
	downloadFunc func(version string) (string, error)
	agentVersion string
	// manifestKeys and requireManifestSigningKeyID are PROVIDERS, not values:
	// both underlying config fields are mutable at runtime and the verified
	// downloader must re-read them on every download. See WithManifestKeys.
	// Nil means "unset" and is handled by helperUpdaterConfig, not here.
	manifestKeys func() []string

	requireManifestSigningKeyID func() bool

	pendingHelperVersion string
	updateFailures       int
	abandonedVersion     string // version we gave up updating to

	legacyAutoStartCleaned bool
}

// New creates a new helper Manager. serverURL is a provider (func() string) so
// the verified package downloader follows backup-server-URL promotion after a
// failover (#2478) — see the serverURL field doc.
func New(ctx context.Context, serverURL func() string, authToken *secmem.SecureString, agentID string, opts ...Option) *Manager {
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
		stopIfOursFunc:    stopByPIDIfOurs,
	}
	for _, opt := range opts {
		opt(m)
	}
	if m.spawnFunc == nil {
		m.spawnFunc = defaultSpawnFunc
	}
	if m.downloadFunc == nil {
		m.downloadFunc = defaultHelperDownloader(m.serverURL, m.backupServerURL, m.authToken, m.agentVersion, m.manifestKeys, m.requireManifestSigningKeyID)
	}
	return m
}

// resolveServerURL resolves the control-plane base URL from the serverURL
// provider. Nil-safe so a directly-constructed Manager (tests) without a
// provider logs "" rather than panicking.
func (m *Manager) resolveServerURL() string {
	if m.serverURL == nil {
		return ""
	}
	return m.serverURL()
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

	// Snapshot install state BEFORE migrateFromLegacyName — on Linux (and
	// old-name darwin/windows) it can delete the binary, and we must still
	// finish uninstall cleanup exactly once for a legacy box upgrading with
	// Assist disabled.
	wasInstalled := m.isInstalled()
	m.migrateFromLegacyName()
	// Only run the one-time per-session migration when Assist is (or was)
	// actually present. When the policy is off and nothing is installed,
	// uninstallLocked() removes the sessions dir every tick — re-running the
	// migration here would recreate it (and pkill stray helpers / rewrite
	// autostart) in an endless migrate/uninstall thrash loop on every heartbeat.
	if m.needsSessionMigration() && (settings.Enabled || wasInstalled) {
		m.migrateToSessions()
	}

	// Nothing installs the HKLM Run "BreezeHelper" value anymore — spawning is
	// manager-driven — but hosts upgraded before the per-session migration may
	// still carry it, and Windows fires it for EVERY logon session, bypassing
	// the console-only enumerator filter on RDS hosts. The migration-time
	// removal only runs under one-time conditions, so sweep it here once per
	// agent process. Idempotent: removeAutoStart is a no-op when absent.
	if sweepLegacyAutoStart && !m.legacyAutoStartCleaned {
		if err := removeAutoStartFunc(); err != nil {
			log.Warn("failed to remove legacy HKLM Run autostart", "error", err.Error())
		} else {
			m.legacyAutoStartCleaned = true
		}
	}

	if m.sessionEnumerator == nil {
		return
	}

	if settings.Enabled && !m.isInstalled() {
		// Install only when the server has pinned a concrete (signed) helper
		// version via HelperUpgradeTo -> CheckUpdate. The heartbeat always
		// supplies one when bootstrapping a first install, and it is processed
		// before this Apply call within the same heartbeat. Without it we fail
		// closed rather than fetch unverified bytes.
		if m.pendingHelperVersion == "" {
			log.Debug("breeze assist enabled but no signed target version yet; deferring install")
		} else if err := m.downloadAndInstall(m.pendingHelperVersion); err != nil {
			// downloadAndInstall wraps the verified downloader's error, which for
			// any transport failure is a *url.Error carrying the presigned
			// helper-asset URL. This log line ships, so it must be redacted.
			key, value := updater.SafeDownloadErrorFields(err)
			log.Error("failed to install breeze assist", key, value)
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
				// The new config is on disk, but a helper that's already running
				// only read its config at spawn — flag it for a restart so the
				// updated tray settings actually take effect (#1382).
				state.pendingConfigRestart = true
			}

			state.refreshPID()

			// #1382: restart a running helper so it re-reads the changed config.
			// Skip while a chat is active so we don't drop the user's
			// conversation; the flag persists and the restart happens on a later
			// heartbeat once the session is idle. ensureStoppedSession is a
			// no-op when nothing is running (e.g. first spawn), so the
			// ensureRunningSession call below just spawns fresh in that case.
			// Runs after refreshPID so clearing the PID below isn't undone.
			if state.pendingConfigRestart {
				if IsIdle(state.configPath) {
					m.stopSessionWatcher(state)
					if err := m.ensureStoppedSession(state); err != nil {
						log.Warn("failed to stop breeze assist for config reload", "session", si.Key, "error", err.Error())
					} else {
						// Clear the status-file PID too so ensureRunningSession's
						// fallback checks don't treat the just-stopped helper as
						// still running and skip the respawn.
						state.pid = 0
						state.pendingConfigRestart = false
					}
				} else {
					log.Debug("deferring breeze assist config reload until idle; chat active", "session", si.Key)
				}
			}

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

	// After an agent upgrade, m.sessions starts empty in memory. A helper
	// spawned into a non-console (e.g. RDP) session before the upgrade may
	// still be running, but the console-only enumerator never surfaces that
	// session key — so without this merge it would run unmanaged until
	// logoff and its sessions/<key> dir would linger. Fold on-disk session
	// directories into m.sessions so the stale loop below sees (and stops)
	// them via the same refreshPID/ensureStoppedSession mechanics.
	if entries, err := os.ReadDir(filepath.Join(m.baseDir, "sessions")); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			key := entry.Name()
			if activeKeys[key] {
				continue
			}
			if _, exists := m.sessions[key]; exists {
				continue
			}
			m.sessions[key] = newSessionState(key, m.baseDir)
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
		ShowTrayIcon:       s.ShowTrayIcon,
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
	if runtime.GOOS != "windows" && si.UID > 0 && si.UID <= math.MaxInt32 {
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
		_, _ = m.stopIfOursFunc(state.spawnedPID, m.binaryPath)
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
	// stopIfOursFunc verifies helper identity on the same handle it terminates
	// with, so PID reuse can't redirect the kill (#2531).
	for _, pid := range []int{state.spawnedPID, state.pid} {
		if pid <= 0 {
			continue
		}
		if _, err := m.stopIfOursFunc(pid, m.binaryPath); err != nil {
			return err
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

// IsInstalled reports whether the helper binary is present on disk. Exported
// so the heartbeat downgrade guard can distinguish "not installed" from
// "installed but version unreadable" (the latter must fail closed).
func (m *Manager) IsInstalled() bool {
	return m.isInstalled()
}

// downloadAndInstall downloads, INTEGRITY-VERIFIES, and installs the
// platform-appropriate helper package for the given target version.
//
// The download goes through m.downloadFunc (the verified, updater-backed
// downloader) which enforces: Ed25519 signed-release-manifest verification, a
// SHA-256 checksum match over the downloaded bytes, download host == configured
// control-plane ServerURL, and refusal to follow off-origin redirects. Only
// AFTER those checks pass is the privileged installer (installPackageFunc:
// msiexec /i as SYSTEM, hdiutil + cp -R as root) invoked. This closes the
// HIGH-severity RCE where unsigned bytes from a GitHub-CDN redirect were
// executed with full privileges.
//
// Fails closed: with no signed target version there is no manifest entry to
// verify against, so we refuse rather than fetch unversioned/unverified bytes.
func (m *Manager) downloadAndInstall(version string) error {
	if m.authToken == nil {
		return fmt.Errorf("cannot download helper: auth token not available")
	}
	if version == "" {
		return fmt.Errorf("cannot install helper: no signed target version available (refusing to fetch unverified bytes)")
	}
	if m.downloadFunc == nil {
		return fmt.Errorf("cannot download helper: verified downloader not configured")
	}

	log.Info("downloading helper package (verified)", "version", version, "server", m.resolveServerURL())

	verifiedPath, err := m.downloadFunc(version)
	if err != nil {
		return fmt.Errorf("download helper: %w", err)
	}
	defer os.Remove(verifiedPath)

	if err := installPackageFunc(verifiedPath, m.binaryPath); err != nil {
		return fmt.Errorf("install helper package: %w", err)
	}

	log.Info("helper installed", "path", m.binaryPath, "version", version)
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
	lease, acquired := updater.TryBeginProcessMutation("helper-update")
	if !acquired {
		log.Debug("helper update deferred, another component mutation is active", "targetVersion", m.pendingHelperVersion)
		return
	}
	defer lease.Release()

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

	if err := m.downloadAndInstall(m.pendingHelperVersion); err != nil {
		m.updateFailures++
		// Same presigned-URL hazard as the install path above.
		key, value := updater.SafeDownloadErrorFields(err)
		log.Error("failed to install helper update", key, value, "failures", m.updateFailures)
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

// Shutdown stops all session watchers gracefully. Unlike the Apply/update
// paths (which call stopSessionWatcher and immediately restart a new
// watcher), Shutdown must not hang — systemd caps total stop time and a
// watcher stuck in process spawn would prevent the agent from exiting.
// Uses the bounded variant which abandons stuck watchers after a short wait.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, state := range m.sessions {
		m.stopSessionWatcherBounded(state, watcherStopTimeout)
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

// stopSessionWatcher cancels the watcher and waits unbounded for it to
// return. Used on hot paths (Apply, applyPendingUpdate) that immediately
// start a new watcher for the same session — abandoning the old goroutine
// there would let two watchers race on the same sessionState (and a
// mid-spawn watcher could TOCTOU the helper binary during an update).
// For the process-exit path, Shutdown calls stopSessionWatcherBounded.
func (m *Manager) stopSessionWatcher(state *sessionState) {
	if state == nil || state.watcher == nil {
		return
	}
	w := state.watcher
	state.watcher = nil
	w.cancel()
	m.mu.Unlock()
	<-w.done
	m.mu.Lock()
}

// stopSessionWatcherBounded is the shutdown-only variant that abandons a
// stuck watcher after d. The leaked goroutine is harmless at shutdown
// because the process is about to exit.
func (m *Manager) stopSessionWatcherBounded(state *sessionState, d time.Duration) {
	if state == nil || state.watcher == nil {
		return
	}
	w := state.watcher
	state.watcher = nil
	w.cancel()
	m.mu.Unlock()
	select {
	case <-w.done:
	case <-time.After(d):
		log.Warn("session watcher shutdown timed out, abandoning", "session", state.key)
	}
	m.mu.Lock()
}

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
