//go:build windows

package patching

import (
	"bufio"
	"bytes"
	"fmt"
	"os/exec"
	"strings"

	"go.uber.org/zap"
)

// ChocolateyProvider integrates with Chocolatey on Windows.
type ChocolateyProvider struct {
	logger *zap.Logger
}

// NewChocolateyProvider creates a new ChocolateyProvider.
func NewChocolateyProvider(logger *zap.Logger) *ChocolateyProvider {
	return &ChocolateyProvider{logger: logger}
}

// ID returns the provider identifier.
func (c *ChocolateyProvider) ID() string {
	return "chocolatey"
}

// Name returns the human-readable provider name.
func (c *ChocolateyProvider) Name() string {
	return "Chocolatey"
}

// Scan returns available upgrades using choco.
func (c *ChocolateyProvider) Scan() ([]AvailablePatch, error) {
	output, err := exec.Command("choco", "outdated", "-r").Output()
	if err != nil {
		return nil, fmt.Errorf("choco outdated failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	patches := []AvailablePatch{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 3 {
			continue
		}

		patches = append(patches, AvailablePatch{
			ID:          parts[0],
			Title:       parts[0],
			Version:     parts[2],
			Description: "current: " + parts[1],
		})
	}

	return patches, nil
}

// Install upgrades a Chocolatey package.
func (c *ChocolateyProvider) Install(patchID string) (InstallResult, error) {
	output, err := exec.Command("choco", "upgrade", "-y", patchID).CombinedOutput()
	if err != nil {
		return InstallResult{}, fmt.Errorf("choco upgrade failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return InstallResult{
		PatchID:  patchID,
		Message: strings.TrimSpace(string(output)),
	}, nil
}

// Uninstall removes a Chocolatey package.
func (c *ChocolateyProvider) Uninstall(patchID string) error {
	output, err := exec.Command("choco", "uninstall", "-y", patchID).CombinedOutput()
	if err != nil {
		return fmt.Errorf("choco uninstall failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

// GetInstalled returns installed Chocolatey packages.
func (c *ChocolateyProvider) GetInstalled() ([]InstalledPatch, error) {
	output, err := exec.Command("choco", "list", "--localonly", "-r").Output()
	if err != nil {
		return nil, fmt.Errorf("choco list failed: %w", err)
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	installed := []InstalledPatch{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 2 {
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
