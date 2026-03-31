//go:build linux

package patching

import (
	"fmt"
	"os/exec"
	"strings"
)

// YumProvider integrates with dnf/yum package managers.
type YumProvider struct{}

func NewYumProvider() *YumProvider {
	return &YumProvider{}
}

func (y *YumProvider) ID() string {
	return "yum"
}

func (y *YumProvider) Name() string {
	return "YUM/DNF"
}

func (y *YumProvider) Scan() ([]AvailablePatch, error) {
	mgr, err := detectYumManager()
	if err != nil {
		return nil, err
	}

	output, runErr := commandCombinedOutputWithTimeout(patchScanTimeout, mgr, "check-update", "-q")
	if runErr != nil {
		// dnf/yum return exit code 100 when updates are available.
		if exitErr, ok := runErr.(*exec.ExitError); !ok || exitErr.ExitCode() != 100 {
			return nil, fmt.Errorf("%s check-update failed: %w", mgr, runErr)
		}
	}

	scanner := newPatchScanner(output)
	patches := []AvailablePatch{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "Last metadata") || strings.HasPrefix(line, "Obsoleting") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		pkgArch := fields[0]
		name := pkgArch
		if idx := strings.LastIndex(pkgArch, "."); idx > 0 {
			name = pkgArch[:idx]
		}
		if err := validateYumPackageName(name); err != nil {
			continue
		}

		patches = append(patches, AvailablePatch{
			ID:      truncatePatchField(name),
			Title:   truncatePatchField(name),
			Version: truncatePatchField(fields[1]),
		})
		if len(patches) >= patchResultItemLimit {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%s check-update parse failed: %w", mgr, err)
	}

	return patches, nil
}

func (y *YumProvider) Install(patchID string) (InstallResult, error) {
	mgr, err := detectYumManager()
	if err != nil {
		return InstallResult{}, err
	}
	if err := validateYumPackageName(patchID); err != nil {
		return InstallResult{}, err
	}

	output, runErr := commandCombinedOutputWithTimeout(patchMutateTimeout, mgr, "-y", "update", patchID)
	if runErr != nil {
		return InstallResult{}, fmt.Errorf("%s update failed: %w: %s", mgr, runErr, truncatePatchOutput(output))
	}

	message := truncatePatchOutput(output)
	lower := strings.ToLower(message)
	rebootRequired := strings.Contains(lower, "reboot") || strings.Contains(lower, "restart")

	return InstallResult{
		PatchID:        patchID,
		RebootRequired: rebootRequired,
		Message:        message,
	}, nil
}

func (y *YumProvider) Uninstall(patchID string) error {
	mgr, err := detectYumManager()
	if err != nil {
		return err
	}
	if err := validateYumPackageName(patchID); err != nil {
		return err
	}

	output, runErr := commandCombinedOutputWithTimeout(patchMutateTimeout, mgr, "-y", "remove", patchID)
	if runErr != nil {
		return fmt.Errorf("%s remove failed: %w: %s", mgr, runErr, truncatePatchOutput(output))
	}

	return nil
}

func (y *YumProvider) GetInstalled() ([]InstalledPatch, error) {
	output, err := commandOutputWithTimeout(patchListTimeout, "rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\n")
	if err != nil {
		return nil, fmt.Errorf("rpm query failed: %w", err)
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
		if err := validateYumPackageName(parts[0]); err != nil {
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
		return nil, fmt.Errorf("rpm query parse failed: %w", err)
	}

	return installed, nil
}

func detectYumManager() (string, error) {
	if _, err := exec.LookPath("dnf"); err == nil {
		return "dnf", nil
	}
	if _, err := exec.LookPath("yum"); err == nil {
		return "yum", nil
	}
	return "", fmt.Errorf("neither dnf nor yum found")
}
