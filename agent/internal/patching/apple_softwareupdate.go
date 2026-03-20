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

	// If the patchID doesn't look like a softwareupdate label (e.g. it's a
	// human-readable title like "Safari"), try to resolve it to the actual
	// label by running a fresh scan. softwareupdate labels typically contain
	// version numbers with dashes (e.g. "Safari18.3-18.3").
	resolvedID := patchID
	if !looksLikeSoftwareUpdateLabel(patchID) {
		if label := p.resolveLabel(patchID); label != "" {
			resolvedID = label
		}
	}

	cmd := exec.Command("softwareupdate", "-i", resolvedID)
	output, err := cmd.CombinedOutput()
	outStr := strings.TrimSpace(string(output))
	if err != nil {
		return InstallResult{}, fmt.Errorf("softwareupdate install failed: %w: %s", err, outStr)
	}

	// softwareupdate exits 0 even when no matching update is found.
	// Detect this and report it as an error so the operation isn't
	// falsely recorded as successful.
	lower := strings.ToLower(outStr)
	if isNoOpSoftwareUpdateOutput(lower) {
		return InstallResult{}, fmt.Errorf("softwareupdate did not install %q — update not found or already installed. Output: %s", resolvedID, outStr)
	}

	rebootRequired := strings.Contains(lower, "restart") || strings.Contains(lower, "reboot")

	return InstallResult{
		PatchID:        patchID,
		RebootRequired: rebootRequired,
		Message:        outStr,
	}, nil
}

// looksLikeSoftwareUpdateLabel returns true if the ID looks like an actual
// softwareupdate label (contains a dash followed by a version number).
// Labels look like "Safari18.3-18.3", "macOS Sequoia 15.3.2-15.3.2".
func looksLikeSoftwareUpdateLabel(id string) bool {
	// Labels contain at least one dash followed by a digit
	idx := strings.LastIndex(id, "-")
	if idx < 0 || idx >= len(id)-1 {
		return false
	}
	after := id[idx+1:]
	return len(after) > 0 && after[0] >= '0' && after[0] <= '9'
}

// resolveLabel runs a fresh `softwareupdate -l` and attempts to match the
// given title or partial name to an available update's label.
func (p *AppleSoftwareUpdateProvider) resolveLabel(titleOrName string) string {
	available, err := p.Scan()
	if err != nil || len(available) == 0 {
		return ""
	}

	lower := strings.ToLower(strings.TrimSpace(titleOrName))

	// Exact title match first
	for _, patch := range available {
		if strings.ToLower(patch.Title) == lower {
			return patch.ID
		}
	}

	// Try matching title + version (e.g. "Safari 18.3")
	for _, patch := range available {
		combined := strings.ToLower(patch.Title + " " + patch.Version)
		if combined == lower {
			return patch.ID
		}
	}

	// Prefix match (e.g. "Safari" matches "Safari18.3-18.3")
	for _, patch := range available {
		if strings.HasPrefix(strings.ToLower(patch.ID), lower) {
			return patch.ID
		}
	}

	return ""
}

// isNoOpSoftwareUpdateOutput returns true if the (lowercased) output indicates
// that softwareupdate didn't actually install anything.
func isNoOpSoftwareUpdateOutput(lower string) bool {
	if strings.Contains(lower, "no new software available") ||
		strings.Contains(lower, "no updates are available") ||
		strings.Contains(lower, "no updates found") {
		return true
	}
	// If the output is essentially empty, nothing happened
	if strings.TrimSpace(lower) == "" {
		return true
	}
	// Positive indicators that an install actually happened
	if strings.Contains(lower, "installing") ||
		strings.Contains(lower, "installed") ||
		strings.Contains(lower, "downloaded") ||
		strings.Contains(lower, "done with") ||
		strings.Contains(lower, "done.") {
		return false
	}
	// If the output is very short (< 40 chars) and doesn't contain
	// positive indicators, it's suspicious — treat as no-op.
	// Normal install output is multi-line with progress info.
	if len(strings.TrimSpace(lower)) < 40 {
		return true
	}
	return false
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
				ID:       label,
				Title:    label,
				KBNumber: label, // Preserve the exact label for round-trip install resolution
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
