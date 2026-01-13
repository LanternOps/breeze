//go:build linux

package patching

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"strings"

	"go.uber.org/zap"
)

// AptProvider integrates with APT on Debian/Ubuntu systems.
type AptProvider struct {
	logger *zap.Logger
}

// NewAptProvider creates a new AptProvider.
func NewAptProvider(logger *zap.Logger) *AptProvider {
	return &AptProvider{logger: logger}
}

// ID returns the provider identifier.
func (a *AptProvider) ID() string {
	return "apt"
}

// Name returns the human-readable provider name.
func (a *AptProvider) Name() string {
	return "APT"
}

// Scan returns available upgrades using apt.
func (a *AptProvider) Scan() ([]AvailablePatch, error) {
	output, err := exec.Command("apt", "list", "--upgradable").Output()
	if err != nil {
		return nil, fmt.Errorf("apt list failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	patches := []AvailablePatch{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "Listing") {
			continue
		}

		name, version := parseAptUpgradable(line)
		if name == "" {
			continue
		}

		patches = append(patches, AvailablePatch{
			ID:      name,
			Title:   name,
			Version: version,
		})
	}

	return patches, nil
}

// Install upgrades a package using apt-get.
func (a *AptProvider) Install(patchID string) (InstallResult, error) {
	cmd := exec.Command("apt-get", "-y", "install", "--only-upgrade", patchID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return InstallResult{}, fmt.Errorf("apt-get install failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return InstallResult{
		PatchID:  patchID,
		Message: strings.TrimSpace(string(output)),
	}, nil
}

// Uninstall removes a package using apt-get.
func (a *AptProvider) Uninstall(patchID string) error {
	cmd := exec.Command("apt-get", "-y", "remove", patchID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("apt-get remove failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

// GetInstalled returns installed packages using dpkg-query.
func (a *AptProvider) GetInstalled() ([]InstalledPatch, error) {
	output, err := exec.Command("dpkg-query", "-W", "-f=${Package}\t${Version}\n").Output()
	if err != nil {
		return nil, fmt.Errorf("dpkg-query failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	installed := []InstalledPatch{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		installed = append(installed, InstalledPatch{
			ID:      parts[0],
			Title:   parts[0],
			Version: parts[1],
		})
	}

	return installed, nil
}

func parseAptUpgradable(line string) (string, string) {
	parts := strings.SplitN(line, " ", 2)
	if len(parts) == 0 {
		return "", ""
	}

	nameVersion := strings.SplitN(parts[0], "/", 2)
	if len(nameVersion) != 2 {
		return "", ""
	}

	return nameVersion[0], nameVersion[1]
}
