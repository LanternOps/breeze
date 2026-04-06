//go:build windows

package patching

import (
	"fmt"
	"regexp"
	"strings"
)

// validChocoPkgName matches valid Chocolatey package names (alphanumeric, dots, hyphens).
var validChocoPkgName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,127}$`)

// ChocolateyProvider integrates with Chocolatey on Windows.
type ChocolateyProvider struct{}

// NewChocolateyProvider creates a new ChocolateyProvider.
func NewChocolateyProvider() *ChocolateyProvider {
	return &ChocolateyProvider{}
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
	output, err := commandOutputWithTimeout(patchScanTimeout, "choco", "outdated", "-r")
	if err != nil {
		return nil, fmt.Errorf("choco outdated failed: %w", err)
	}

	scanner := newPatchScanner(output)
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
		if !validChocoPkgName.MatchString(parts[0]) {
			continue
		}

		patches = append(patches, AvailablePatch{
			ID:          truncatePatchField(parts[0]),
			Title:       truncatePatchField(parts[0]),
			Version:     truncatePatchField(parts[2]),
			Description: truncatePatchDescription("current: " + parts[1]),
		})
		if len(patches) >= patchResultItemLimit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("choco outdated parse failed: %w", err)
	}

	return patches, nil
}

// Install upgrades a Chocolatey package.
func (c *ChocolateyProvider) Install(patchID string) (InstallResult, error) {
	if !validChocoPkgName.MatchString(patchID) {
		return InstallResult{}, fmt.Errorf("invalid package name: %q", patchID)
	}
	output, err := commandCombinedOutputWithTimeout(patchMutateTimeout, "choco", "upgrade", "-y", patchID)
	if err != nil {
		return InstallResult{}, fmt.Errorf("choco upgrade failed: %w: %s", err, truncatePatchOutput(output))
	}

	return InstallResult{
		PatchID: patchID,
		Message: truncatePatchOutput(output),
	}, nil
}

// Uninstall removes a Chocolatey package.
func (c *ChocolateyProvider) Uninstall(patchID string) error {
	if !validChocoPkgName.MatchString(patchID) {
		return fmt.Errorf("invalid package name: %q", patchID)
	}
	output, err := commandCombinedOutputWithTimeout(patchMutateTimeout, "choco", "uninstall", "-y", patchID)
	if err != nil {
		return fmt.Errorf("choco uninstall failed: %w: %s", err, truncatePatchOutput(output))
	}

	return nil
}

// GetInstalled returns installed Chocolatey packages.
func (c *ChocolateyProvider) GetInstalled() ([]InstalledPatch, error) {
	// Try without --localonly first (Chocolatey v2+, where list is local-only by default).
	// Fall back to --localonly for Chocolatey v1.
	output, err := commandOutputWithTimeout(patchListTimeout, "choco", "list", "-r")
	if err != nil {
		output, err = commandOutputWithTimeout(patchListTimeout, "choco", "list", "--localonly", "-r")
		if err != nil {
			return nil, fmt.Errorf("choco list failed: %w", err)
		}
	}

	scanner := newPatchScanner(output)
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
		if !validChocoPkgName.MatchString(parts[0]) {
			continue
		}

		installed = append(installed, InstalledPatch{
			ID:      truncatePatchField(parts[0]),
			Title:   truncatePatchField(parts[0]),
			Version: truncatePatchField(parts[1]),
		})
		if len(installed) >= patchResultItemLimit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("choco list parse failed: %w", err)
	}

	return installed, nil
}
