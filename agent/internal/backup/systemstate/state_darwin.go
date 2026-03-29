//go:build darwin

package systemstate

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// DarwinCollector gathers macOS system state: preferences, launch daemons/agents,
// network configuration, installed packages, users/groups, and hosts.
type DarwinCollector struct{}

// NewCollector returns a DarwinCollector.
func NewCollector() Collector {
	return &DarwinCollector{}
}

// CollectState gathers all macOS system state artifacts into stagingDir.
func (c *DarwinCollector) CollectState(stagingDir string) (*SystemStateManifest, error) {
	hostname, _ := os.Hostname()
	manifest := &SystemStateManifest{
		Platform:    runtime.GOOS,
		OSVersion:   darwinVersion(),
		Hostname:    hostname,
		CollectedAt: time.Now().UTC(),
	}

	type step struct {
		name string
		fn   func(string) ([]Artifact, error)
	}
	steps := []step{
		{"preferences", c.collectPreferences},
		{"launch_daemons", c.collectLaunchDaemons},
		{"launch_agents", c.collectLaunchAgents},
		{"network", c.collectNetwork},
		{"packages", c.collectPackages},
		{"users_groups", c.collectUsersGroups},
		{"hosts", c.collectHosts},
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

	hw, err := c.CollectHardwareProfile()
	if err != nil {
		slog.Warn("systemstate: hardware profile failed", "error", err.Error())
	} else {
		manifest.HardwareProfile = hw
	}

	return manifest, nil
}

// ---------------------------------------------------------------------------
// System preferences
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectPreferences(stagingDir string) ([]Artifact, error) {
	src := "/Library/Preferences"
	if _, err := os.Stat(src); err != nil {
		return nil, nil // not present
	}
	dst := filepath.Join(stagingDir, "preferences")
	if err := copyTree(src, dst); err != nil {
		return nil, fmt.Errorf("copy preferences: %w", err)
	}
	return collectArtifactsInDir("preferences", dst, stagingDir)
}

// ---------------------------------------------------------------------------
// LaunchDaemons
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectLaunchDaemons(stagingDir string) ([]Artifact, error) {
	src := "/Library/LaunchDaemons"
	if _, err := os.Stat(src); err != nil {
		return nil, nil
	}
	dst := filepath.Join(stagingDir, "launch_daemons")
	if err := copyTree(src, dst); err != nil {
		return nil, fmt.Errorf("copy LaunchDaemons: %w", err)
	}
	return collectArtifactsInDir("launch_daemons", dst, stagingDir)
}

// ---------------------------------------------------------------------------
// LaunchAgents
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectLaunchAgents(stagingDir string) ([]Artifact, error) {
	src := "/Library/LaunchAgents"
	if _, err := os.Stat(src); err != nil {
		return nil, nil
	}
	dst := filepath.Join(stagingDir, "launch_agents")
	if err := copyTree(src, dst); err != nil {
		return nil, fmt.Errorf("copy LaunchAgents: %w", err)
	}
	return collectArtifactsInDir("launch_agents", dst, stagingDir)
}

// ---------------------------------------------------------------------------
// Network configuration
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectNetwork(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "network")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "ports.txt")
	cmd := exec.Command("networksetup", "-listallhardwareports")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("networksetup: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("network_ports", "config", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Installed packages
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectPackages(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "packages")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "installed.txt")
	cmd := exec.Command("pkgutil", "--pkgs")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("pkgutil: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("installed_packages", "packages", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Users and groups
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectUsersGroups(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "users")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	var artifacts []Artifact
	for _, name := range []string{"passwd", "group"} {
		src := filepath.Join("/etc", name)
		dst := filepath.Join(dir, name)
		if err := copyFile(src, dst); err != nil {
			slog.Warn("systemstate: copy failed", "file", src, "error", err.Error())
			continue
		}
		artifacts = append(artifacts, artifactFromFile("etc_"+name, "config", dst, stagingDir))
	}
	return artifacts, nil
}

// ---------------------------------------------------------------------------
// Hosts file
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectHosts(stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "hosts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	src := "/etc/hosts"
	dst := filepath.Join(dir, "hosts")
	if err := copyFile(src, dst); err != nil {
		return nil, fmt.Errorf("copy hosts: %w", err)
	}
	return []Artifact{artifactFromFile("etc_hosts", "config", dst, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// CollectHardwareProfile
// ---------------------------------------------------------------------------

func (c *DarwinCollector) CollectHardwareProfile() (*HardwareProfile, error) {
	hw := &HardwareProfile{}

	// CPU model
	if out, err := exec.Command("sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
		hw.CPUModel = strings.TrimSpace(string(out))
	}

	// CPU cores
	if out, err := exec.Command("sysctl", "-n", "hw.ncpu").Output(); err == nil {
		hw.CPUCores, _ = strconv.Atoi(strings.TrimSpace(string(out)))
	}

	// Memory
	if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
		bytes, _ := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
		hw.TotalMemoryMB = bytes / (1024 * 1024)
	}

	// Disks — diskutil list (plain text)
	if out, err := exec.Command("diskutil", "list").Output(); err == nil {
		hw.Disks = parseDarwinDiskutil(string(out))
	}

	// NICs
	if out, err := exec.Command("networksetup", "-listallhardwareports").Output(); err == nil {
		hw.NetworkAdapters = parseDarwinNICs(string(out))
	}

	// UEFI — all Apple Silicon and most Intel Macs since ~2006 use UEFI.
	if out, err := exec.Command("sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
		hw.IsUEFI = true // All supported macOS machines are UEFI.
		_ = out
	}

	// System model as motherboard equivalent.
	if out, err := exec.Command("sysctl", "-n", "hw.model").Output(); err == nil {
		hw.Motherboard = strings.TrimSpace(string(out))
	}

	return hw, nil
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

// parseDarwinDiskutil parses `diskutil list` output into DiskInfo entries.
// Format:  /dev/diskN (type):
func parseDarwinDiskutil(output string) []DiskInfo {
	var disks []DiskInfo
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "/dev/disk") {
			name := strings.Fields(line)[0]
			disks = append(disks, DiskInfo{Name: name})
		}
	}
	return disks
}

// parseDarwinNICs parses `networksetup -listallhardwareports` output.
// Format:
//
//	Hardware Port: <name>
//	Device: <device>
//	Ethernet Address: <mac>
func parseDarwinNICs(output string) []NICInfo {
	var nics []NICInfo
	var current NICInfo
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Hardware Port:") {
			current = NICInfo{Name: strings.TrimPrefix(line, "Hardware Port: ")}
		} else if strings.HasPrefix(line, "Ethernet Address:") {
			current.MACAddress = strings.TrimPrefix(line, "Ethernet Address: ")
			if current.Name != "" && current.MACAddress != "" && current.MACAddress != "N/A" {
				nics = append(nics, current)
			}
			current = NICInfo{}
		}
	}
	return nics
}

// ---------------------------------------------------------------------------
// macOS version helper
// ---------------------------------------------------------------------------

func darwinVersion() string {
	out, err := exec.Command("sw_vers", "-productVersion").Output()
	if err != nil {
		return "darwin"
	}
	return "macOS " + strings.TrimSpace(string(out))
}
