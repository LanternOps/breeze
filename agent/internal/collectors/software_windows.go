//go:build windows

package collectors

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

// Registry paths for installed software
var softwareRegistryPaths = []struct {
	root registry.Key
	path string
}{
	// 64-bit applications
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
	// 32-bit applications on 64-bit Windows
	{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`},
	// Per-user applications
	{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
}

// Collect retrieves installed software from Windows registry
func (c *SoftwareCollector) Collect() ([]SoftwareItem, error) {
	var software []SoftwareItem
	seen := make(map[string]bool)

	for _, regPath := range softwareRegistryPaths {
		items, err := collectFromRegistry(regPath.root, regPath.path)
		if err != nil {
			// Continue on error - some paths may not exist or be accessible
			continue
		}

		for _, item := range items {
			// Deduplicate by name+version
			key := fmt.Sprintf("%s|%s", item.Name, item.Version)
			if !seen[key] {
				seen[key] = true
				software = append(software, item)
			}
		}
	}

	return software, nil
}

func collectFromRegistry(rootKey registry.Key, path string) ([]SoftwareItem, error) {
	key, err := registry.OpenKey(rootKey, path, registry.READ)
	if err != nil {
		return nil, err
	}
	defer key.Close()

	subkeys, err := key.ReadSubKeyNames(-1)
	if err != nil {
		return nil, err
	}

	var software []SoftwareItem

	for _, subkeyName := range subkeys {
		subkey, err := registry.OpenKey(key, subkeyName, registry.READ)
		if err != nil {
			continue
		}

		item := readSoftwareFromKey(subkey)
		subkey.Close()

		// Skip items without a display name or system components
		if item.Name == "" {
			continue
		}

		// Skip Windows updates and system components
		if isSystemComponent(subkey) {
			continue
		}

		software = append(software, item)
	}

	return software, nil
}

func readSoftwareFromKey(key registry.Key) SoftwareItem {
	item := SoftwareItem{}

	item.Name, _ = readStringValue(key, "DisplayName")
	item.Version, _ = readStringValue(key, "DisplayVersion")
	item.Vendor, _ = readStringValue(key, "Publisher")
	rawDate, _ := readStringValue(key, "InstallDate")
	item.InstallDate = parseInstallDate(rawDate)
	item.InstallLocation, _ = readStringValue(key, "InstallLocation")
	item.UninstallString, _ = readStringValue(key, "UninstallString")

	return item
}

func readStringValue(key registry.Key, name string) (string, error) {
	val, _, err := key.GetStringValue(name)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(val), nil
}

// yyyymmddRegex matches dates in YYYYMMDD format (e.g., "20240115")
var yyyymmddRegex = regexp.MustCompile(`^\d{8}$`)

// parseInstallDate normalizes a Windows registry InstallDate value to ISO 8601
// (YYYY-MM-DD). The registry value is typically YYYYMMDD but some installers
// write locale-dependent strings (e.g. French: "jeu. févr. 12 19:40:25 2026").
// Returns "" for unparseable values so the API stores NULL instead of crashing.
func parseInstallDate(dateStr string) string {
	dateStr = strings.TrimSpace(dateStr)
	if dateStr == "" {
		return ""
	}

	// Most common: YYYYMMDD (e.g., "20240115")
	if yyyymmddRegex.MatchString(dateStr) {
		if t, err := time.Parse("20060102", dateStr); err == nil {
			return t.Format("2006-01-02")
		}
	}

	// Already ISO 8601
	if t, err := time.Parse("2006-01-02", dateStr); err == nil {
		return t.Format("2006-01-02")
	}

	// Try common locale-dependent formats written by various installers
	formats := []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z",
		"2006-01-02 15:04:05",
		"01/02/2006",
		"1/2/2006",
		"02/01/2006",
		"Jan 2, 2006",
		"2 Jan 2006",
		"January 2, 2006",
		"Mon Jan 2 15:04:05 2006",
		"Mon. Jan. 2 15:04:05 2006",
	}

	for _, format := range formats {
		if t, err := time.Parse(format, dateStr); err == nil {
			return t.Format("2006-01-02")
		}
	}

	// Unparseable — return empty so the API inserts NULL rather than crashing
	return ""
}

func isSystemComponent(key registry.Key) bool {
	// Check SystemComponent flag
	val, _, err := key.GetIntegerValue("SystemComponent")
	if err == nil && val == 1 {
		return true
	}

	// Check for Windows Update entries
	name, _ := readStringValue(key, "DisplayName")
	if strings.HasPrefix(name, "Update for") ||
		strings.HasPrefix(name, "Security Update for") ||
		strings.HasPrefix(name, "Hotfix for") {
		return true
	}

	return false
}
