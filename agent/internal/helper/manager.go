package helper

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/breeze-rmm/agent/internal/logging"
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

// Manager handles helper binary lifecycle: config writing, install, start, stop.
type Manager struct {
	mu          sync.Mutex
	lastEnabled bool
	binaryPath  string
	configPath  string
	serverURL   string
	authToken   string
	agentID     string
}

// New creates a new helper Manager.
func New(serverURL, authToken, agentID string) *Manager {
	return &Manager{
		binaryPath: defaultBinaryPath(),
		configPath: defaultConfigPath(),
		serverURL:  serverURL,
		authToken:  authToken,
		agentID:    agentID,
	}
}

func defaultBinaryPath() string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/Breeze/breeze-helper" + ext
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "Breeze", "breeze-helper"+ext)
	default:
		return "/usr/local/bin/breeze-helper" + ext
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
			log.Error("failed to write helper config", "error", err.Error())
			return
		}

		if !m.isInstalled() {
			if err := m.downloadAndInstall(); err != nil {
				log.Error("failed to install helper", "error", err.Error())
				return
			}
		}

		if err := m.ensureRunning(); err != nil {
			log.Error("failed to start helper", "error", err.Error())
		}

		if !m.lastEnabled {
			log.Info("helper enabled and started")
		}
	} else {
		if m.lastEnabled {
			if err := m.ensureStopped(); err != nil {
				log.Error("failed to stop helper", "error", err.Error())
			} else {
				log.Info("helper disabled and stopped")
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

func (m *Manager) downloadAndInstall() error {
	url := fmt.Sprintf("%s/api/v1/agents/download/helper/%s/%s", m.serverURL, runtime.GOOS, runtime.GOARCH)
	log.Info("downloading helper binary", "url", url)

	tmpPath := m.binaryPath + ".download"
	if err := downloadFile(url, tmpPath, m.authToken); err != nil {
		return fmt.Errorf("download helper: %w", err)
	}

	if err := os.Chmod(tmpPath, 0755); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("chmod helper: %w", err)
	}

	dir := filepath.Dir(m.binaryPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("create binary dir: %w", err)
	}

	if err := os.Rename(tmpPath, m.binaryPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("install helper: %w", err)
	}

	// Platform-specific auto-start registration
	if err := installAutoStart(m.binaryPath); err != nil {
		log.Warn("failed to install auto-start for helper", "error", err.Error())
	}

	log.Info("helper binary installed", "path", m.binaryPath)
	return nil
}

func (m *Manager) ensureRunning() error {
	// Check if already running
	if isHelperRunning() {
		return nil
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
