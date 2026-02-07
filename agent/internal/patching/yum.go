//go:build linux

package patching

import (
	"bufio"
	"bytes"
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

	cmd := exec.Command(mgr, "check-update", "-q")
	output, runErr := cmd.CombinedOutput()
	if runErr != nil {
		// dnf/yum return exit code 100 when updates are available.
		if exitErr, ok := runErr.(*exec.ExitError); !ok || exitErr.ExitCode() != 100 {
			return nil, fmt.Errorf("%s check-update failed: %w", mgr, runErr)
		}
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
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

		patches = append(patches, AvailablePatch{
			ID:      name,
			Title:   name,
			Version: fields[1],
		})
	}

	return patches, nil
}

func (y *YumProvider) Install(patchID string) (InstallResult, error) {
	mgr, err := detectYumManager()
	if err != nil {
		return InstallResult{}, err
	}

	output, runErr := exec.Command(mgr, "-y", "update", patchID).CombinedOutput()
	if runErr != nil {
		return InstallResult{}, fmt.Errorf("%s update failed: %w: %s", mgr, runErr, strings.TrimSpace(string(output)))
	}

	lower := strings.ToLower(string(output))
	rebootRequired := strings.Contains(lower, "reboot") || strings.Contains(lower, "restart")

	return InstallResult{
		PatchID:        patchID,
		RebootRequired: rebootRequired,
		Message:        strings.TrimSpace(string(output)),
	}, nil
}

func (y *YumProvider) Uninstall(patchID string) error {
	mgr, err := detectYumManager()
	if err != nil {
		return err
	}

	output, runErr := exec.Command(mgr, "-y", "remove", patchID).CombinedOutput()
	if runErr != nil {
		return fmt.Errorf("%s remove failed: %w: %s", mgr, runErr, strings.TrimSpace(string(output)))
	}

	return nil
}

func (y *YumProvider) GetInstalled() ([]InstalledPatch, error) {
	output, err := exec.Command("rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\n").Output()
	if err != nil {
		return nil, fmt.Errorf("rpm query failed: %w", err)
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

func detectYumManager() (string, error) {
	if _, err := exec.LookPath("dnf"); err == nil {
		return "dnf", nil
	}
	if _, err := exec.LookPath("yum"); err == nil {
		return "yum", nil
	}
	return "", fmt.Errorf("neither dnf nor yum found")
}
