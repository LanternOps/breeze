package helper

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"

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

// SpawnFunc launches the Breeze Assist binary in the appropriate user session.
// On Windows: wraps SpawnProcessInSession for each active session.
// On macOS/Linux: nil (falls back to exec.Command).
type SpawnFunc func(binaryPath string) error

// ErrNoActiveSession is returned by SpawnFunc when no user session is available.
var ErrNoActiveSession = fmt.Errorf("no active user session")

// Option configures a Manager.
type Option func(*Manager)

// WithSpawnFunc sets a platform-specific function for launching the helper
// binary in a user session. Required on Windows (Session 0 service).
func WithSpawnFunc(fn SpawnFunc) Option {
	return func(m *Manager) { m.spawnFunc = fn }
}

// Manager handles helper binary lifecycle: config writing, install, start, stop.
type Manager struct {
	mu                   sync.Mutex
	lastEnabled          bool
	binaryPath           string
	configPath           string
	serverURL            string
	authToken            *secmem.SecureString
	agentID              string
	ctx                  context.Context
	spawnFunc            SpawnFunc
	watcher              *watcher
	pendingHelperVersion string
}

// New creates a new helper Manager.
func New(ctx context.Context, serverURL string, authToken *secmem.SecureString, agentID string, opts ...Option) *Manager {
	m := &Manager{
		ctx:        ctx,
		binaryPath: defaultBinaryPath(),
		configPath: defaultConfigPath(),
		serverURL:  serverURL,
		authToken:  authToken,
		agentID:    agentID,
	}
	for _, opt := range opts {
		opt(m)
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

func defaultConfigPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/Breeze/helper_config.yaml"
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "Breeze", "helper_config.yaml")
	default:
		return "/etc/breeze/helper_config.yaml"
	}
}

// Apply is called on each heartbeat with the latest helper settings.
// It writes the config, installs/starts or stops the helper as needed.
func (m *Manager) Apply(settings *Settings) {
	if settings == nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if settings.Enabled {
		if err := m.writeConfig(settings); err != nil {
			log.Error("failed to write breeze assist config", "error", err.Error())
			return
		}

		if !m.isInstalled() {
			if err := m.downloadAndInstall(); err != nil {
				log.Error("failed to install breeze assist", "error", err.Error())
				return
			}
		}

		m.applyPendingUpdate()

		if err := m.ensureRunning(); err != nil {
			log.Error("failed to start breeze assist", "error", err.Error())
		} else {
			m.startWatcher()
		}

		if !m.lastEnabled {
			log.Info("breeze assist enabled and started")
		}
	} else {
		if m.lastEnabled {
			m.stopWatcher()
			if err := m.ensureStopped(); err != nil {
				log.Error("failed to stop breeze assist", "error", err.Error())
			} else {
				log.Info("breeze assist disabled and stopped")
			}
		}
	}

	m.lastEnabled = settings.Enabled
}

func (m *Manager) writeConfig(settings *Settings) error {
	cfg := Config{
		ShowOpenPortal:     settings.ShowOpenPortal,
		ShowDeviceInfo:     settings.ShowDeviceInfo,
		ShowRequestSupport: settings.ShowRequestSupport,
		PortalUrl:          settings.PortalUrl,
	}

	data, err := yaml.Marshal(&cfg)
	if err != nil {
		return fmt.Errorf("marshal helper config: %w", err)
	}

	dir := filepath.Dir(m.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	// Atomic write: temp file + rename
	tmpPath := m.configPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := os.Rename(tmpPath, m.configPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename config: %w", err)
	}

	return nil
}

func (m *Manager) isInstalled() bool {
	_, err := os.Stat(m.binaryPath)
	return err == nil
}

// downloadAndInstall downloads the platform-appropriate helper package
// (MSI on Windows, DMG on macOS, AppImage on Linux) and installs it.
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
	tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := downloadFile(url, tmpPath, m.authToken.Reveal()); err != nil {
		return fmt.Errorf("download helper: %w", err)
	}

	if err := installPackage(tmpPath, m.binaryPath); err != nil {
		return fmt.Errorf("install helper package: %w", err)
	}

	// Platform-specific auto-start registration
	if err := installAutoStart(m.binaryPath); err != nil {
		log.Warn("failed to install auto-start for helper", "error", err.Error())
	}

	log.Info("helper installed", "path", m.binaryPath)
	return nil
}

func (m *Manager) ensureRunning() error {
	if isHelperRunning() {
		return nil
	}

	if m.spawnFunc != nil {
		return m.spawnFunc(m.binaryPath)
	}

	cmd := exec.Command(m.binaryPath)
	cmd.Dir = filepath.Dir(m.binaryPath)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Start()
}

func (m *Manager) ensureStopped() error {
	return stopHelper()
}

// Shutdown stops the watcher gracefully.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopWatcher()
}

func (m *Manager) startWatcher() {
	if m.watcher != nil {
		return
	}
	m.watcher = newWatcher(m.ctx, m)
	go m.watcher.run()
}

// stopWatcher cancels the watcher and waits for it to exit.
// IMPORTANT: Must release m.mu before joining to avoid deadlock —
// the watcher acquires mu during its tick, so if we hold mu and
// wait on done, we deadlock if the watcher is blocked on mu.Lock().
func (m *Manager) stopWatcher() {
	if m.watcher == nil {
		return
	}
	w := m.watcher
	m.watcher = nil
	w.cancel()
	m.mu.Unlock()
	<-w.done
	m.mu.Lock()
}

// CheckUpdate stores a pending Helper version upgrade. The actual update
// happens when the Helper is idle (checked on each Apply call).
func (m *Manager) CheckUpdate(targetVersion string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pendingHelperVersion != targetVersion {
		log.Info("helper update pending", "targetVersion", targetVersion)
		m.pendingHelperVersion = targetVersion
	}
}

// InstalledVersion returns the version from helper_status.yaml, or empty string.
func (m *Manager) InstalledVersion() string {
	status, err := ReadStatus(m.configPath)
	if err != nil {
		return ""
	}
	return status.Version
}

// applyPendingUpdate checks if a Helper update is pending and the Helper is idle,
// then performs the update. Must be called with m.mu held.
func (m *Manager) applyPendingUpdate() {
	if m.pendingHelperVersion == "" {
		return
	}

	// Skip if already at target version — avoids stuck retry loops when
	// ensureStopped fails (e.g., launchctl bootout as root on macOS).
	if installed := m.InstalledVersion(); installed == m.pendingHelperVersion {
		log.Info("helper already at target version, clearing pending update",
			"version", installed)
		m.pendingHelperVersion = ""
		return
	}

	if !IsIdle(m.configPath) {
		log.Debug("helper update deferred, chat active", "targetVersion", m.pendingHelperVersion)
		return
	}

	log.Info("helper is idle, applying update", "targetVersion", m.pendingHelperVersion)

	// Stop the running helper
	if err := m.ensureStopped(); err != nil {
		log.Error("failed to stop helper for update", "error", err.Error())
		return
	}

	// Back up the current binary
	backupPath := m.binaryPath + ".backup"
	if err := copyFile(m.binaryPath, backupPath); err != nil {
		log.Warn("failed to backup helper binary", "error", err.Error())
		// Continue anyway — fresh install will work
	}

	// Download and install new version
	if err := m.downloadAndInstall(); err != nil {
		log.Error("failed to install helper update", "error", err.Error())
		// Attempt rollback
		if restoreErr := restoreBackup(backupPath, m.binaryPath); restoreErr != nil {
			log.Error("failed to rollback helper", "error", restoreErr.Error())
		}
		// Restart old version
		if err := m.ensureRunning(); err != nil {
			log.Error("failed to restart helper after rollback", "error", err.Error())
		}
		return
	}

	// Start the new version
	if err := m.ensureRunning(); err != nil {
		log.Error("failed to start updated helper", "error", err.Error())
		// Attempt rollback
		if restoreErr := restoreBackup(backupPath, m.binaryPath); restoreErr != nil {
			log.Error("failed to rollback helper", "error", restoreErr.Error())
		}
		m.ensureRunning() // try to start the old one
		return
	}

	log.Info("helper updated successfully", "requestedVersion", m.pendingHelperVersion)
	m.pendingHelperVersion = ""

	// Clean up backup
	os.Remove(backupPath)
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
