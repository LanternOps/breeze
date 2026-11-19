//go:build linux

package systemstate

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// LinuxCollector gathers Linux system state: /etc/ tree, boot config,
// package lists, systemd services, firewall rules, and crontabs.
type LinuxCollector struct{}

// NewCollector returns a LinuxCollector.
func NewCollector() Collector {
	return &LinuxCollector{}
}

// newCollector ignores opts: only the Windows collector uses them.
func newCollector(_ CollectOptions) Collector {
	return &LinuxCollector{}
}

// CollectState gathers all Linux system state artifacts into stagingDir.
func (c *LinuxCollector) CollectState(ctx context.Context, stagingDir string) (*SystemStateManifest, error) {
	hostname, _ := os.Hostname()
	manifest := &SystemStateManifest{
		Platform:    runtime.GOOS,
		OSVersion:   osVersion(ctx, "linux", linuxVersion),
		Hostname:    hostname,
		CollectedAt: time.Now().UTC(),
	}

	steps := []collectionStep{
		{"etc", c.collectEtc},
		{"boot", c.collectBootConfig},
		{"packages", c.collectPackages},
		{"services", c.collectServices},
		{"firewall", c.collectFirewall},
		{"crontabs", c.collectCrontabs},
	}

	if err := runBestEffortSteps(ctx, manifest, steps, stagingDir); err != nil {
		return manifest, err
	}

	attachHardwareProfile(ctx, manifest, c.CollectHardwareProfile)

	return manifest, nil
}

// ---------------------------------------------------------------------------
// /etc/ tree
// ---------------------------------------------------------------------------

func (c *LinuxCollector) collectEtc(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dst := filepath.Join(stagingDir, "etc")
	if err := copyTree(ctx, "/etc", dst); err != nil {
		return nil, fmt.Errorf("copy /etc: %w", err)
	}
	return collectArtifactsInDir(ctx, "etc_tree", dst, stagingDir)
}

// ---------------------------------------------------------------------------
// Boot config (GRUB)
// ---------------------------------------------------------------------------

func (c *LinuxCollector) collectBootConfig(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "boot")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	// Try grub.cfg from common locations.
	candidates := []string{
		"/boot/grub/grub.cfg",
		"/boot/grub2/grub.cfg",
	}
	var artifacts []Artifact
	for _, src := range candidates {
		if _, err := os.Stat(src); err != nil {
			continue
		}
		dst := filepath.Join(dir, filepath.Base(src))
		if err := copyFile(ctx, src, dst); err != nil {
			slog.Warn("systemstate: copy boot config failed", "src", src, "error", err.Error())
			continue
		}
		artifacts = append(artifacts, artifactFromFile("grub_cfg", "boot", dst, stagingDir))
		break // only need one
	}
	return artifacts, nil
}

// ---------------------------------------------------------------------------
// Package list (dpkg or rpm)
// ---------------------------------------------------------------------------

func (c *LinuxCollector) collectPackages(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "packages")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	var artifacts []Artifact

	// Try dpkg first (Debian/Ubuntu).
	if _, err := exec.LookPath("dpkg"); err == nil {
		outPath := filepath.Join(dir, "dpkg.txt")
		cmd := collectorCommand(ctx, "dpkg", "--get-selections")
		data, err := cmd.Output()
		if err == nil {
			if wErr := os.WriteFile(outPath, data, 0o600); wErr == nil {
				artifacts = append(artifacts, artifactFromFile("dpkg_selections", "packages", outPath, stagingDir))
			}
		}
	}

	// Try rpm (RHEL/CentOS/Fedora).
	if _, err := exec.LookPath("rpm"); err == nil {
		outPath := filepath.Join(dir, "rpm.txt")
		cmd := collectorCommand(ctx, "rpm", "-qa")
		data, err := cmd.Output()
		if err == nil {
			if wErr := os.WriteFile(outPath, data, 0o600); wErr == nil {
				artifacts = append(artifacts, artifactFromFile("rpm_packages", "packages", outPath, stagingDir))
			}
		}
	}

	return artifacts, nil
}

// ---------------------------------------------------------------------------
// Systemd services
// ---------------------------------------------------------------------------

func (c *LinuxCollector) collectServices(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "services")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "systemd.txt")
	cmd := collectorCommand(ctx, "systemctl", "list-unit-files", "--type=service")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("systemctl list-unit-files: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("systemd_services", "services", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Firewall rules (iptables)
// ---------------------------------------------------------------------------

func (c *LinuxCollector) collectFirewall(ctx context.Context, stagingDir string) ([]Artifact, error) {
	if _, err := exec.LookPath("iptables-save"); err != nil {
		slog.Info("systemstate: iptables-save not found, skipping firewall")
		return nil, nil
	}

	dir := filepath.Join(stagingDir, "firewall")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	outPath := filepath.Join(dir, "iptables.rules")
	cmd := collectorCommand(ctx, "iptables-save")
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("iptables-save: %w", err)
	}
	if err := os.WriteFile(outPath, data, 0o600); err != nil {
		return nil, err
	}
	return []Artifact{artifactFromFile("iptables_rules", "firewall", outPath, stagingDir)}, nil
}

// ---------------------------------------------------------------------------
// Crontabs
// ---------------------------------------------------------------------------

func (c *LinuxCollector) collectCrontabs(ctx context.Context, stagingDir string) ([]Artifact, error) {
	dir := filepath.Join(stagingDir, "crontabs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	var artifacts []Artifact

	// /etc/crontab
	src := "/etc/crontab"
	if _, err := os.Stat(src); err == nil {
		dst := filepath.Join(dir, "crontab")
		if err := copyFile(ctx, src, dst); err == nil {
			artifacts = append(artifacts, artifactFromFile("etc_crontab", "config", dst, stagingDir))
		}
	}

	// /var/spool/cron/ (per-user crontabs)
	spoolDir := "/var/spool/cron"
	if _, err := os.Stat(spoolDir); err == nil {
		dst := filepath.Join(dir, "spool")
		if err := copyTree(ctx, spoolDir, dst); err == nil {
			arts, _ := collectArtifactsInDir(ctx, "cron_spool", dst, stagingDir)
			artifacts = append(artifacts, arts...)
		}
	}

	return artifacts, nil
}

// ---------------------------------------------------------------------------
// Linux version helper
// ---------------------------------------------------------------------------

func linuxVersion(ctx context.Context) string {
	// Try /etc/os-release first.
	data, err := os.ReadFile("/etc/os-release")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				val := strings.TrimPrefix(line, "PRETTY_NAME=")
				return strings.Trim(val, `"`)
			}
		}
	}
	// Fallback to kernel version.
	out, err := collectorCommand(ctx, "uname", "-r").Output()
	if err != nil {
		return "linux"
	}
	return "Linux " + strings.TrimSpace(string(out))
}
