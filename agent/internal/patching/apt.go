//go:build linux

package patching

import (
	"fmt"
	"strings"
)

// AptProvider integrates with APT on Debian/Ubuntu systems.
type AptProvider struct{}

// NewAptProvider creates a new AptProvider.
func NewAptProvider() *AptProvider {
	return &AptProvider{}
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
	output, err := commandOutputWithTimeout(patchScanTimeout, "apt", "list", "--upgradable")
	if err != nil {
		return nil, fmt.Errorf("apt list failed: %w", err)
	}

	scanner := newPatchScanner(output)
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
		if err := validateAptPackageName(name); err != nil {
			continue
		}

		patches = append(patches, AvailablePatch{
			ID:      truncatePatchField(name),
			Title:   truncatePatchField(name),
			Version: truncatePatchField(version),
		})
		if len(patches) >= patchResultItemLimit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("apt list parse failed: %w", err)
	}

	return patches, nil
}

// Install upgrades a package using apt-get.
func (a *AptProvider) Install(patchID string) (InstallResult, error) {
	if err := validateAptPackageName(patchID); err != nil {
		return InstallResult{}, err
	}
	output, err := commandCombinedOutputWithTimeout(patchMutateTimeout, "apt-get", "-y", "install", "--only-upgrade", patchID)
	if err != nil {
		return InstallResult{}, fmt.Errorf("apt-get install failed: %w: %s", err, truncatePatchOutput(output))
	}

	return InstallResult{
		PatchID: patchID,
		Message: truncatePatchOutput(output),
	}, nil
}

// Uninstall removes a package using apt-get.
func (a *AptProvider) Uninstall(patchID string) error {
	if err := validateAptPackageName(patchID); err != nil {
		return err
	}
	output, err := commandCombinedOutputWithTimeout(patchMutateTimeout, "apt-get", "-y", "remove", patchID)
	if err != nil {
		return fmt.Errorf("apt-get remove failed: %w: %s", err, truncatePatchOutput(output))
	}

	return nil
}

// GetInstalled returns installed packages using dpkg-query.
func (a *AptProvider) GetInstalled() ([]InstalledPatch, error) {
	output, err := commandOutputWithTimeout(patchListTimeout, "dpkg-query", "-W", "-f=${Package}\t${Version}\n")
	if err != nil {
		return nil, fmt.Errorf("dpkg-query failed: %w", err)
	}

	scanner := newPatchScanner(output)
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
		if err := validateAptPackageName(parts[0]); err != nil {
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
		return nil, fmt.Errorf("dpkg-query parse failed: %w", err)
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
