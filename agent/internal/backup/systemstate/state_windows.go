//go:build windows

package systemstate

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// WindowsCollector gathers Windows system state: registry hives, boot config,
// driver inventory, certificates, services, scheduled tasks, firewall rules,
// Windows features, and IIS configuration.
type WindowsCollector struct{}

// NewCollector returns a WindowsCollector.
func NewCollector() Collector {
	return &WindowsCollector{}
}

// CollectState gathers all Windows system state artifacts into stagingDir.
// Individual collection steps log errors but do not abort the entire run.
func (c *WindowsCollector) CollectState(stagingDir string) (*SystemStateManifest, error) {
	hostname, _ := os.Hostname()
	manifest := &SystemStateManifest{
		Platform:    runtime.GOOS,
		OSVersion:   windowsVersion(),
		Hostname:    hostname,
		CollectedAt: time.Now().UTC(),
	}

	type step struct {
		name string
		fn   func(string) ([]Artifact, error)
	}
	steps := []step{
		{"registry", c.collectRegistry},
		{"boot", c.collectBootConfig},
		{"drivers", c.collectDrivers},
		{"certs", c.collectCertificates},
		{"services", c.collectServices},
		{"tasks", c.collectScheduledTasks},
		{"firewall", c.collectFirewall},
		{"features", c.collectFeatures},
		{"iis", c.collectIIS},
	}

	for _, s := range steps {
		arts, err := s.fn(stagingDir)
		if err != nil {
			slog.Warn("systemstate: step failed", "step", s.name, "error", err.Error())
			continue
		}
		manifest.Artifacts = append(manifest.Artifacts, arts...)
	}

	if len(manifest.Artifacts) == 0 {
		return manifest, fmt.Errorf("system state collection produced no artifacts — all %d steps failed", len(steps))
	}

	// Attach hardware profile (best-effort).
	hw, err := c.CollectHardwareProfile()
	if err != nil {
		slog.Warn("systemstate: hardware profile failed", "error", err.Error())
	} else {
		manifest.HardwareProfile = hw
	}

	return manifest, nil
}

// ---------------------------------------------------------------------------
// Registry hives
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectRegistry(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "registry")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	hives := []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY"}
	var artifacts []Artifact
	for _, hive := range hives {
		outPath := filepath.Join(dir, hive)
		cmd := exec.Command("reg", "save", `HKLM\`+hive, outPath, "/y")
		if out, err := cmd.CombinedOutput(); err != nil {
			slog.Warn("systemstate: reg save failed", "hive", hive, "error", err.Error(), "output", string(out))
			continue
		}
		artifacts = append(artifacts, artifactFromFile("registry_"+hive, "registry", outPath, stagingDir))
	}
	return artifacts, nil
}

// ---------------------------------------------------------------------------
// Boot configuration
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectBootConfig(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "boot")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "bcd_export")
	cmd := exec.Command("bcdedit", "/export", outPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("bcdedit export: %s: %w", string(out), err)
	}
	return []Artifact{artifactFromFile("bcd_export", "boot", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Driver inventory
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectDrivers(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "drivers")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "inventory.csv")
	cmd := exec.Command("driverquery", "/v", "/fo", "csv")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("driverquery: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("driver_inventory", "drivers", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Certificate stores
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectCertificates(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "certs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	cmd := exec.Command("certutil", "-backupDB", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("certutil backupDB: %s: %w", string(out), err)
	}
	return collectArtifactsInDir("certs", dir, stagingDir)
}

// ---------------------------------------------------------------------------
// Service configurations
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectServices(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "services")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "services.txt")
	cmd := exec.Command("sc", "query", "type=service", "state=all")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("sc query: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("service_list", "services", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectScheduledTasks(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "tasks")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "tasks.csv")
	cmd := exec.Command("schtasks", "/query", "/fo", "csv", "/v")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("schtasks: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("scheduled_tasks", "tasks", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Firewall rules
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectFirewall(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "firewall")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "rules.wfw")
	cmd := exec.Command("netsh", "advfirewall", "export", outPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("netsh advfirewall export: %s: %w", string(out), err)
	}
	return []Artifact{artifactFromFile("firewall_rules", "firewall", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Windows features
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectFeatures(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "features")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "features.txt")
	cmd := exec.Command("dism", "/online", "/get-features", "/format:table")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("dism get-features: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("windows_features", "features", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// IIS configuration (optional — skip if appcmd not found)
// ---------------------------------------------------------------------------

func (c *WindowsCollector) collectIIS(stagingDir string) ([]Artifact, error) {
	appcmd := filepath.Join(os.Getenv("WINDIR"), "system32", "inetsrv", "appcmd.exe")
	if _, err := os.Stat(appcmd); err != nil {
		slog.Info("systemstate: IIS not installed, skipping")
		return nil, nil
	}

	dir := filepath.Join(stagingDir, "iis")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "config.xml")
	cmd := exec.Command(appcmd, "list", "config", "/xml")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("appcmd list config: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("iis_config", "config", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Windows version helper
// ---------------------------------------------------------------------------

func windowsVersion() string {
	out, err := exec.Command("cmd", "/c", "ver").Output()
	if err != nil {
		return "windows"
	}
	return strings.TrimSpace(string(out))
}
