package security

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// SecurityScanner coordinates security scans on the local system.
type SecurityScanner struct {
	QuarantineDir string
	MaxFileSize   int64
	MaxReadBytes  int64
	Config        *config.Config
}

// ScanResult captures the output of a security scan.
type ScanResult struct {
	Threats  []Threat       `json:"threats"`
	Status   SecurityStatus `json:"status"`
	Duration time.Duration  `json:"duration"`
}

// QuickScan performs a fast scan of common threat locations.
func (s *SecurityScanner) QuickScan() (ScanResult, error) {
	return s.scanPaths(defaultQuickPaths())
}

// FullScan performs a comprehensive scan of system locations.
func (s *SecurityScanner) FullScan() (ScanResult, error) {
	return s.scanPaths(defaultFullPaths())
}

// CustomScan scans the provided paths.
func (s *SecurityScanner) CustomScan(paths []string) (ScanResult, error) {
	return s.scanPaths(paths)
}

func (s *SecurityScanner) scanPaths(paths []string) (ScanResult, error) {
	start := time.Now()

	options := defaultThreatScanOptions()
	if s.MaxFileSize > 0 {
		options.MaxFileSize = s.MaxFileSize
	}
	if s.MaxReadBytes > 0 {
		options.MaxReadBytes = s.MaxReadBytes
	}

	quarantineDir := s.quarantineDir()
	if quarantineDir != "" {
		options.ExcludePaths = append(options.ExcludePaths, quarantineDir)
	}

	threats, scanErr := detectThreats(paths, options)
	status, statusErr := CollectStatus(s.Config)

	status.ThreatCount = len(threats)
	status.LastScanAt = time.Now().UTC().Format(time.RFC3339)
	if status.LastScanType == "" {
		status.LastScanType = "custom"
	}

	result := ScanResult{
		Threats:  threats,
		Status:   status,
		Duration: time.Since(start),
	}

	return result, errors.Join(scanErr, statusErr)
}

func (s *SecurityScanner) quarantineDir() string {
	if s.QuarantineDir != "" {
		return s.QuarantineDir
	}

	return DefaultQuarantineDir()
}

// DefaultQuarantineDir returns the default quarantine path for this host.
func DefaultQuarantineDir() string {
	base := defaultDataDir()
	if base != "" {
		return filepath.Join(base, "quarantine")
	}

	return filepath.Join(os.TempDir(), "breeze-quarantine")
}

func defaultQuickPaths() []string {
	paths := []string{os.TempDir()}
	home, _ := os.UserHomeDir()

	switch runtime.GOOS {
	case "windows":
		systemDrive := os.Getenv("SystemDrive")
		if systemDrive != "" {
			paths = append(paths, filepath.Join(systemDrive, "Windows", "Temp"))
		}
		if home != "" {
			paths = append(paths,
				filepath.Join(home, "Downloads"),
				filepath.Join(home, "AppData", "Local", "Temp"),
				filepath.Join(home, "AppData", "Roaming"),
			)
		}
		if programData := os.Getenv("ProgramData"); programData != "" {
			paths = append(paths, programData)
		}
	case "darwin":
		if home != "" {
			paths = append(paths,
				filepath.Join(home, "Downloads"),
				filepath.Join(home, "Library", "LaunchAgents"),
				filepath.Join(home, "Library", "Application Support"),
			)
		}
		paths = append(paths, "/Library/LaunchDaemons", "/Library/LaunchAgents")
	default:
		if home != "" {
			paths = append(paths,
				filepath.Join(home, "Downloads"),
				filepath.Join(home, ".config", "autostart"),
			)
		}
		paths = append(paths,
			"/tmp",
			"/var/tmp",
			"/etc/cron.d",
			"/etc/cron.daily",
			"/etc/cron.hourly",
			"/etc/cron.weekly",
			"/etc/cron.monthly",
		)
	}

	return filterExistingPaths(paths)
}

func defaultFullPaths() []string {
	paths := []string{}
	home, _ := os.UserHomeDir()

	switch runtime.GOOS {
	case "windows":
		systemDrive := os.Getenv("SystemDrive")
		if systemDrive != "" {
			root := systemDrive
			if !strings.HasSuffix(root, string(os.PathSeparator)) {
				root += string(os.PathSeparator)
			}
			paths = append(paths, root)
		}
		if home != "" {
			paths = append(paths, home)
		}
		if programData := os.Getenv("ProgramData"); programData != "" {
			paths = append(paths, programData)
		}
	case "darwin":
		paths = append(paths, "/Applications", "/Library", "/Users")
	default:
		paths = append(paths, "/", "/home", "/opt", "/usr", "/var", "/etc")
	}

	return filterExistingPaths(paths)
}

func filterExistingPaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	var filtered []string
	for _, path := range paths {
		path = filepath.Clean(path)
		if path == "." || path == "" {
			continue
		}
		key := strings.ToLower(path)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if _, err := os.Stat(path); err == nil {
			filtered = append(filtered, path)
		}
	}
	return filtered
}
