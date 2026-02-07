//go:build darwin

package patching

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// AppleSoftwareUpdateProvider integrates with macOS softwareupdate.
type AppleSoftwareUpdateProvider struct{}

// NewAppleSoftwareUpdateProvider creates a new AppleSoftwareUpdateProvider.
func NewAppleSoftwareUpdateProvider() *AppleSoftwareUpdateProvider {
	return &AppleSoftwareUpdateProvider{}
}

func (p *AppleSoftwareUpdateProvider) ID() string {
	return "apple-softwareupdate"
}

func (p *AppleSoftwareUpdateProvider) Name() string {
	return "Apple Software Update"
}

func (p *AppleSoftwareUpdateProvider) Scan() ([]AvailablePatch, error) {
	cmd := exec.Command("softwareupdate", "-l")
	output, err := cmd.CombinedOutput()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 2 {
			return []AvailablePatch{}, nil
		}
		if strings.Contains(strings.ToLower(string(output)), "no new software") {
			return []AvailablePatch{}, nil
		}
		return nil, fmt.Errorf("softwareupdate list failed: %w", err)
	}

	return parseSoftwareUpdateList(output), nil
}

func (p *AppleSoftwareUpdateProvider) Install(patchID string) (InstallResult, error) {
	if patchID == "" {
		return InstallResult{}, fmt.Errorf("patch ID is required")
	}

	cmd := exec.Command("softwareupdate", "-i", patchID)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return InstallResult{}, fmt.Errorf("softwareupdate install failed: %w: %s", err, strings.TrimSpace(string(output)))
	}

	lower := strings.ToLower(string(output))
	rebootRequired := strings.Contains(lower, "restart") || strings.Contains(lower, "reboot")

	return InstallResult{
		PatchID:        patchID,
		RebootRequired: rebootRequired,
		Message:        strings.TrimSpace(string(output)),
	}, nil
}

func (p *AppleSoftwareUpdateProvider) Uninstall(patchID string) error {
	return fmt.Errorf("apple software updates cannot be uninstalled automatically: %s", patchID)
}

func (p *AppleSoftwareUpdateProvider) GetInstalled() ([]InstalledPatch, error) {
	cmd := exec.Command("system_profiler", "SPInstallHistoryDataType", "-json")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("system_profiler install history failed: %w", err)
	}

	return parseAppleInstallHistory(output, time.Now(), 90*24*time.Hour)
}

func parseAppleInstallHistory(output []byte, now time.Time, maxAge time.Duration) ([]InstalledPatch, error) {
	var result struct {
		SPInstallHistoryDataType []struct {
			Name        string `json:"_name"`
			Version     string `json:"install_version"`
			Source      string `json:"package_source"`
			InstallDate string `json:"install_date"`
		} `json:"SPInstallHistoryDataType"`
	}

	if err := json.Unmarshal(output, &result); err != nil {
		return nil, fmt.Errorf("parse install history failed: %w", err)
	}

	cutoff := now.Add(-maxAge)
	installed := make([]InstalledPatch, 0, len(result.SPInstallHistoryDataType))
	for _, item := range result.SPInstallHistoryDataType {
		if item.Name == "" || isIgnoredInstallHistoryItem(item.Name) {
			continue
		}
		if !isApplePackageSource(item.Source) {
			continue
		}

		installTime, parseErr := time.Parse("2006-01-02T15:04:05Z", item.InstallDate)
		if parseErr != nil {
			installTime, parseErr = time.Parse("2006-01-02", item.InstallDate)
		}
		if parseErr == nil && installTime.Before(cutoff) {
			continue
		}

		installed = append(installed, InstalledPatch{
			ID:      item.Name,
			Title:   item.Name,
			Version: item.Version,
		})
	}

	return installed, nil
}

func isApplePackageSource(source string) bool {
	source = strings.TrimSpace(strings.ToLower(source))
	if source == "" {
		return true
	}
	return strings.Contains(source, "apple")
}

func isIgnoredInstallHistoryItem(name string) bool {
	return strings.HasPrefix(name, "MAContent") ||
		strings.HasPrefix(name, "MobileAssets") ||
		strings.Contains(name, "AssetPack")
}

func parseSoftwareUpdateList(output []byte) []AvailablePatch {
	scanner := bufio.NewScanner(bytes.NewReader(output))
	labelPattern := regexp.MustCompile(`^\s*\*\s+Label:\s+(.+)$`)
	titlePattern := regexp.MustCompile(`Title:\s*([^,]+)`)
	versionPattern := regexp.MustCompile(`Version:\s*([^,]+)`)
	restartPattern := regexp.MustCompile(`Action:\s*restart`)

	patches := []AvailablePatch{}
	var current *AvailablePatch

	flush := func() {
		if current != nil && current.ID != "" {
			patches = append(patches, *current)
		}
	}

	for scanner.Scan() {
		line := scanner.Text()
		if matches := labelPattern.FindStringSubmatch(line); len(matches) > 1 {
			flush()
			label := strings.TrimSpace(matches[1])
			current = &AvailablePatch{
				ID:    label,
				Title: label,
			}
			continue
		}

		if current == nil {
			continue
		}

		if matches := titlePattern.FindStringSubmatch(line); len(matches) > 1 {
			current.Title = strings.TrimSpace(matches[1])
		}
		if matches := versionPattern.FindStringSubmatch(line); len(matches) > 1 {
			current.Version = strings.TrimSpace(matches[1])
		}
		if restartPattern.MatchString(line) {
			if current.Description == "" {
				current.Description = "restart required"
			} else {
				current.Description += "; restart required"
			}
		}
	}

	flush()
	return patches
}
