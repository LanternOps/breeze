//go:build darwin

package systemstate

import (
	"context"
	"fmt"
	"log/slog"
	"os"
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

// newCollector ignores opts: only the Windows collector uses them.
func newCollector(_ CollectOptions) Collector {
	return &DarwinCollector{}
}

// CollectState gathers all macOS system state artifacts into stagingDir.
func (c *DarwinCollector) CollectState(ctx context.Context, stagingDir string) (*SystemStateManifest, error) {
	hostname, _ := os.Hostname()
	manifest := &SystemStateManifest{
		Platform:    runtime.GOOS,
		OSVersion:   osVersion(ctx, "darwin", darwinVersion),
		Hostname:    hostname,
		CollectedAt: time.Now().UTC(),
	}

	steps := []collectionStep{
		{"preferences", c.collectPreferences},
		{"launch_daemons", c.collectLaunchDaemons},
		{"launch_agents", c.collectLaunchAgents},
		{"network", c.collectNetwork},
		{"packages", c.collectPackages},
		{"users_groups", c.collectUsersGroups},
		{"hosts", c.collectHosts},
	}

	if err := runBestEffortSteps(ctx, manifest, steps, stagingDir); err != nil {
		return manifest, err
	}

	attachHardwareProfile(ctx, manifest, c.CollectHardwareProfile)

	return manifest, nil
}

// ---------------------------------------------------------------------------
// System preferences
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectPreferences(ctx context.Context, stagingDir string) ([]Artifact, error) {
	src := "/Library/Preferences"
	if _, err := os.Stat(src); err != nil {
		return nil, nil // not present
	}
	dst := filepath.Join(stagingDir, "preferences")
	if err := copyTree(ctx, src, dst); err != nil {
		return nil, fmt.Errorf("copy preferences: %w", err)
	}
	return collectArtifactsInDir(ctx, "preferences", dst, stagingDir)
}

// ---------------------------------------------------------------------------
// LaunchDaemons
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectLaunchDaemons(ctx context.Context, stagingDir string) ([]Artifact, error) {
	src := "/Library/LaunchDaemons"
	if _, err := os.Stat(src); err != nil {
		return nil, nil
	}
	dst := filepath.Join(stagingDir, "launch_daemons")
	if err := copyTree(ctx, src, dst); err != nil {
		return nil, fmt.Errorf("copy LaunchDaemons: %w", err)
	}
	return collectArtifactsInDir(ctx, "launch_daemons", dst, stagingDir)
}

// ---------------------------------------------------------------------------
// LaunchAgents
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectLaunchAgents(ctx context.Context, stagingDir string) ([]Artifact, error) {
	src := "/Library/LaunchAgents"
	if _, err := os.Stat(src); err != nil {
		return nil, nil
	}
	dst := filepath.Join(stagingDir, "launch_agents")
	if err := copyTree(ctx, src, dst); err != nil {
		return nil, fmt.Errorf("copy LaunchAgents: %w", err)
	}
	return collectArtifactsInDir(ctx, "launch_agents", dst, stagingDir)
}

// ---------------------------------------------------------------------------
// Network configuration
// ---------------------------------------------------------------------------

func (c *DarwinCollector) collectNetwork(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "network")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "ports.txt")
	cmd := collectorCommand(ctx, "networksetup", "-listallhardwareports")
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

func (c *DarwinCollector) collectPackages(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "packages")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "installed.txt")
	cmd := collectorCommand(ctx, "pkgutil", "--pkgs")
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

func (c *DarwinCollector) collectUsersGroups(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "users")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	var artifacts []Artifact
	for _, name := range []string{"passwd", "group"} {
		src := filepath.Join("/etc", name)
		dst := filepath.Join(dir, name)
		if err := copyFile(ctx, src, dst); err != nil {
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

func (c *DarwinCollector) collectHosts(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "hosts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	src := "/etc/hosts"
	dst := filepath.Join(dir, "hosts")
	if err := copyFile(ctx, src, dst); err != nil {
		return nil, fmt.Errorf("copy hosts: %w", err)
	}
	return []Artifact{artifactFromFile("etc_hosts", "config", dst, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// CollectHardwareProfile
// ---------------------------------------------------------------------------

func (c *DarwinCollector) CollectHardwareProfile(ctx context.Context) (*HardwareProfile, error) {
	hw := &HardwareProfile{}

	// CPU model
	if out, err := collectorCommand(ctx, "sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
		hw.CPUModel = strings.TrimSpace(string(out))
	}

	// CPU cores
	if out, err := collectorCommand(ctx, "sysctl", "-n", "hw.ncpu").Output(); err == nil {
		hw.CPUCores, _ = strconv.Atoi(strings.TrimSpace(string(out)))
	}

	// Memory
	if out, err := collectorCommand(ctx, "sysctl", "-n", "hw.memsize").Output(); err == nil {
		bytes, _ := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
		hw.TotalMemoryMB = bytes / (1024 * 1024)
	}

	// Disks - diskutil list (plain text)
	if out, err := collectorCommand(ctx, "diskutil", "list").Output(); err == nil {
		hw.Disks = parseDarwinDiskutil(string(out))
	}

	// NICs
	if out, err := collectorCommand(ctx, "networksetup", "-listallhardwareports").Output(); err == nil {
		hw.NetworkAdapters = parseDarwinNICs(string(out))
	}

	// UEFI - all Apple Silicon and most Intel Macs since ~2006 use UEFI.
	if out, err := collectorCommand(ctx, "sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
		hw.IsUEFI = true // All supported macOS machines are UEFI.
		_ = out
	}

	// System model as motherboard equivalent.
	if out, err := collectorCommand(ctx, "sysctl", "-n", "hw.model").Output(); err == nil {
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

func darwinVersion(ctx context.Context) string {
	out, err := collectorCommand(ctx, "sw_vers", "-productVersion").Output()
	if err != nil {
		return "darwin"
	}
	return "macOS " + strings.TrimSpace(string(out))
}
