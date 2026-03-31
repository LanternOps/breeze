//go:build darwin

package collectors

import (
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Collect retrieves available patches/updates on macOS
func (c *PatchCollector) Collect() ([]PatchInfo, error) {
	var patches []PatchInfo

	// Collect macOS system updates
	systemPatches, err := c.collectSystemUpdates()
	if err == nil {
		patches = append(patches, systemPatches...)
	}

	// Collect Homebrew updates (if installed)
	brewPatches, err := c.collectHomebrewUpdates()
	if err == nil {
		patches = append(patches, brewPatches...)
	}

	return patches, nil
}

// collectSystemUpdates checks for macOS system updates using softwareupdate
func (c *PatchCollector) collectSystemUpdates() ([]PatchInfo, error) {
	// Run softwareupdate -l to list available updates
	output, err := runCollectorCombinedOutput(collectorLongCommandTimeout, "softwareupdate", "-l")
	if err != nil {
		// softwareupdate returns exit code 2 when no updates available
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 2 {
			return nil, nil
		}
		// Check if output contains "No new software available"
		if strings.Contains(string(output), "No new software available") {
			return nil, nil
		}
		return nil, err
	}

	return c.parseSoftwareUpdateOutput(output), nil
}

// parseSoftwareUpdateOutput parses the output of softwareupdate -l
func (c *PatchCollector) parseSoftwareUpdateOutput(output []byte) []PatchInfo {
	var patches []PatchInfo

	scanner := newCollectorScanner(output)

	// Regex patterns for parsing softwareupdate output
	// Format: "* Label: macOS Sonoma 14.3"
	// or "* Label: Security Update 2024-001 (Ventura)"
	labelPattern := regexp.MustCompile(`^\s*\*\s+Label:\s+(.+)$`)
	// Title line: "    Title: macOS Sonoma 14.3, Version: 14.3, Size: 1234K, Recommended: YES, Action: restart"
	titlePattern := regexp.MustCompile(`Title:\s*([^,]+)`)
	versionPattern := regexp.MustCompile(`Version:\s*([^,]+)`)
	sizePattern := regexp.MustCompile(`Size:\s*([^,]+)`)
	recommendedPattern := regexp.MustCompile(`Recommended:\s*(YES|NO)`)
	restartPattern := regexp.MustCompile(`Action:\s*restart`)

	var currentPatch *PatchInfo

	for scanner.Scan() {
		line := scanner.Text()

		// Check for label line (starts a new update entry)
		if matches := labelPattern.FindStringSubmatch(line); len(matches) > 1 {
			// Save previous patch if exists
			if currentPatch != nil && currentPatch.Name != "" {
				patches = append(patches, sanitizePatchInfo(*currentPatch))
				if len(patches) >= collectorResultLimit {
					return patches
				}
			}

			label := strings.TrimSpace(matches[1])
			currentPatch = &PatchInfo{
				Name:     truncateCollectorString(label),
				Source:   "apple",
				Category: c.categorizeAppleUpdate(label),
			}
			continue
		}

		// If we have a current patch, look for details
		if currentPatch != nil {
			if matches := titlePattern.FindStringSubmatch(line); len(matches) > 1 {
				currentPatch.Name = truncateCollectorString(strings.TrimSpace(matches[1]))
			}
			if matches := versionPattern.FindStringSubmatch(line); len(matches) > 1 {
				currentPatch.Version = truncateCollectorString(strings.TrimSpace(matches[1]))
			}
			if matches := sizePattern.FindStringSubmatch(line); len(matches) > 1 {
				currentPatch.Description = truncateCollectorString("Size: " + strings.TrimSpace(matches[1]))
			}
			if matches := recommendedPattern.FindStringSubmatch(line); len(matches) > 1 {
				if matches[1] == "YES" {
					currentPatch.Severity = "important"
				}
			}
			if restartPattern.MatchString(line) {
				currentPatch.IsRestart = true
			}
		}
	}

	// Don't forget the last patch
	if currentPatch != nil && currentPatch.Name != "" {
		patches = append(patches, sanitizePatchInfo(*currentPatch))
	}

	return patches
}

// categorizeAppleUpdate determines the category based on update name
func (c *PatchCollector) categorizeAppleUpdate(name string) string {
	nameLower := strings.ToLower(name)

	if strings.Contains(nameLower, "security") {
		return "security"
	}
	if strings.Contains(nameLower, "macos") || strings.Contains(nameLower, "mac os") {
		return "system"
	}
	if strings.Contains(nameLower, "safari") ||
		strings.Contains(nameLower, "xcode") ||
		strings.Contains(nameLower, "command line tools") {
		return "application"
	}

	return "system"
}

// collectHomebrewUpdates checks for Homebrew package updates
func (c *PatchCollector) collectHomebrewUpdates() ([]PatchInfo, error) {
	// First check if brew is installed
	brewPath, err := exec.LookPath("brew")
	if err != nil {
		// Homebrew not installed
		return nil, nil
	}

	// Update Homebrew's package list (quick check, don't do full update)
	// Skip this in favor of just checking outdated to be faster
	// exec.Command(brewPath, "update").Run()

	// Get outdated packages
	output, err := runCollectorOutput(collectorLongCommandTimeout, brewPath, "outdated", "--verbose")
	if err != nil {
		// No outdated packages or error
		return nil, nil
	}

	return c.parseBrewOutdatedOutput(output), nil
}

// parseBrewOutdatedOutput parses the output of brew outdated --verbose
// Format: "package (current_version) < new_version"
// or: "package (current_version) != new_version"
func (c *PatchCollector) parseBrewOutdatedOutput(output []byte) []PatchInfo {
	var patches []PatchInfo

	scanner := newCollectorScanner(output)

	// Pattern: "package (1.2.3) < 1.2.4" or "package (1.2.3) != 1.2.4"
	pattern := regexp.MustCompile(`^(\S+)\s+\(([^)]+)\)\s+[<!=]+\s+(.+)$`)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		appended := false
		if matches := pattern.FindStringSubmatch(line); len(matches) == 4 {
			patches = append(patches, PatchInfo{
				Name:       matches[1],
				CurrentVer: matches[2],
				Version:    matches[3],
				Category:   "homebrew",
				Source:     "homebrew",
			})
			appended = true
		} else {
			// Simple format: just package name
			parts := strings.Fields(line)
			if len(parts) >= 1 {
				patches = append(patches, PatchInfo{
					Name:     parts[0],
					Category: "homebrew",
					Source:   "homebrew",
				})
				appended = true
			}
		}
		if !appended {
			continue
		}
		patches[len(patches)-1] = sanitizePatchInfo(patches[len(patches)-1])
		if len(patches) >= collectorResultLimit {
			break
		}
	}

	return patches
}

// CollectWithCasks includes Homebrew cask updates as well
func (c *PatchCollector) CollectWithCasks() ([]PatchInfo, error) {
	patches, err := c.Collect()
	if err != nil {
		return patches, err
	}

	// Check for outdated casks
	brewPath, err := exec.LookPath("brew")
	if err != nil {
		return patches, nil
	}

	output, err := runCollectorOutput(collectorLongCommandTimeout, brewPath, "outdated", "--cask", "--verbose")
	if err != nil {
		return patches, nil
	}

	caskPatches := c.parseBrewOutdatedOutput(output)
	for i := range caskPatches {
		caskPatches[i].Category = truncateCollectorString("homebrew-cask")
	}

	patches = append(patches, caskPatches...)
	return patches, nil
}

// CollectInstalled retrieves recently installed updates/patches on macOS
// Uses system_profiler which is efficient and returns structured JSON
func (c *PatchCollector) CollectInstalled(maxAge time.Duration) ([]InstalledPatchInfo, error) {
	// Run system_profiler to get install history (JSON output is faster to parse)
	output, err := runCollectorOutput(collectorLongCommandTimeout, "system_profiler", "SPInstallHistoryDataType", "-json")
	if err != nil {
		return nil, err
	}

	return c.parseInstallHistory(output, maxAge), nil
}

// parseInstallHistory parses the JSON output of system_profiler SPInstallHistoryDataType
func (c *PatchCollector) parseInstallHistory(output []byte, maxAge time.Duration) []InstalledPatchInfo {
	var result struct {
		SPInstallHistoryDataType []struct {
			Name        string `json:"_name"`
			Version     string `json:"install_version"`
			Source      string `json:"package_source"`
			InstallDate string `json:"install_date"`
		} `json:"SPInstallHistoryDataType"`
	}

	if err := json.Unmarshal(output, &result); err != nil {
		return nil
	}

	var patches []InstalledPatchInfo
	cutoff := time.Now().Add(-maxAge)

	for _, item := range result.SPInstallHistoryDataType {
		// Skip GarageBand/Logic content packs (not meaningful patches)
		if strings.HasPrefix(item.Name, "MAContent") ||
			strings.HasPrefix(item.Name, "MobileAssets") ||
			strings.Contains(item.Name, "AssetPack") {
			continue
		}

		// Parse the install date (format: "2024-01-15T10:30:00Z")
		installTime, err := time.Parse("2006-01-02T15:04:05Z", item.InstallDate)
		if err != nil {
			// Try alternate format
			installTime, err = time.Parse("2006-01-02", item.InstallDate)
			if err != nil {
				continue
			}
		}

		// Skip patches older than maxAge
		if installTime.Before(cutoff) {
			continue
		}

		// Determine source and category
		source := "apple"
		category := c.categorizeAppleUpdate(item.Name)

		// Check if it's from Apple or third-party
		// system_profiler uses "package_source_apple" for Apple software
		if item.Source != "" && !strings.Contains(item.Source, "apple") {
			source = "third_party"
			category = "application"
		}

		patches = append(patches, InstalledPatchInfo{
			Name:        item.Name,
			Version:     item.Version,
			Category:    category,
			Source:      source,
			InstalledAt: installTime.Format(time.RFC3339),
		})
		patches[len(patches)-1] = sanitizeInstalledPatchInfo(patches[len(patches)-1])
		if len(patches) >= collectorResultLimit {
			break
		}
	}

	return patches
}

func sanitizePatchInfo(patch PatchInfo) PatchInfo {
	patch.Name = truncateCollectorString(patch.Name)
	patch.Version = truncateCollectorString(patch.Version)
	patch.CurrentVer = truncateCollectorString(patch.CurrentVer)
	patch.Category = truncateCollectorString(patch.Category)
	patch.Severity = truncateCollectorString(patch.Severity)
	patch.KBNumber = truncateCollectorString(patch.KBNumber)
	patch.ReleaseDate = truncateCollectorString(patch.ReleaseDate)
	patch.Description = truncateCollectorString(patch.Description)
	patch.Source = truncateCollectorString(patch.Source)
	return patch
}

func sanitizeInstalledPatchInfo(patch InstalledPatchInfo) InstalledPatchInfo {
	patch.Name = truncateCollectorString(patch.Name)
	patch.Version = truncateCollectorString(patch.Version)
	patch.KBNumber = truncateCollectorString(patch.KBNumber)
	patch.Category = truncateCollectorString(patch.Category)
	patch.Source = truncateCollectorString(patch.Source)
	patch.InstalledAt = truncateCollectorString(patch.InstalledAt)
	return patch
}
