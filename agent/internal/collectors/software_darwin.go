//go:build darwin

package collectors

import (
	"encoding/json"
	"strings"
	"time"
)

// systemProfilerOutput represents the JSON structure from system_profiler
type systemProfilerOutput struct {
	SPApplicationsDataType []applicationInfo `json:"SPApplicationsDataType"`
}

// applicationInfo represents a single application from system_profiler
type applicationInfo struct {
	Name         string `json:"_name"`
	Version      string `json:"version"`
	ObtainedFrom string `json:"obtained_from"`
	Path         string `json:"path"`
	LastModified string `json:"lastModified"`
}

// Collect retrieves installed software from macOS using system_profiler
func (c *SoftwareCollector) Collect() ([]SoftwareItem, error) {
	output, err := runCollectorOutput(collectorLongCommandTimeout, "system_profiler", "SPApplicationsDataType", "-json")
	if err != nil {
		return nil, err
	}

	var profilerData systemProfilerOutput
	if err := json.Unmarshal(output, &profilerData); err != nil {
		return nil, err
	}

	var software []SoftwareItem
	seen := make(map[string]bool)

	for _, app := range profilerData.SPApplicationsDataType {
		// Skip apps without a name
		if app.Name == "" {
			continue
		}

		// Deduplicate by name+version (same app may appear in multiple locations)
		key := app.Name + "|" + app.Version
		if seen[key] {
			continue
		}
		seen[key] = true

		item := SoftwareItem{
			Name:            app.Name,
			Version:         app.Version,
			Vendor:          normalizeVendor(app.ObtainedFrom),
			InstallLocation: app.Path,
			InstallDate:     parseInstallDate(app.LastModified),
		}

		software = append(software, sanitizeSoftwareItem(item))
		if len(software) >= collectorResultLimit {
			break
		}
	}

	return software, nil
}

// normalizeVendor converts obtained_from values to human-readable vendor strings
func normalizeVendor(obtainedFrom string) string {
	switch strings.ToLower(obtainedFrom) {
	case "apple":
		return "Apple"
	case "mac_app_store", "mac app store":
		return "Mac App Store"
	case "identified_developer", "identified developer":
		return "Identified Developer"
	case "unknown":
		return "Unknown"
	default:
		if obtainedFrom == "" {
			return ""
		}
		return obtainedFrom
	}
}

// parseInstallDate attempts to parse the lastModified date from system_profiler
// and returns it in a consistent format (YYYY-MM-DD)
func parseInstallDate(dateStr string) string {
	if dateStr == "" {
		return ""
	}

	// system_profiler returns dates in various formats depending on locale
	// Common formats include:
	// - "2024-01-15T10:30:00Z" (ISO 8601)
	// - "1/15/24, 10:30 AM" (US locale)
	// - "15/01/2024 10:30:00" (European locale)
	formats := []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z",
		"2006-01-02 15:04:05 -0700",
		"1/2/06, 3:04 PM",
		"1/2/2006, 3:04 PM",
		"2/1/2006 15:04:05",
		"Jan 2, 2006, 3:04 PM",
		"2 Jan 2006 15:04:05",
	}

	for _, format := range formats {
		if t, err := time.Parse(format, dateStr); err == nil {
			return t.Format("2006-01-02")
		}
	}

	// Unparseable — return empty so the API inserts NULL rather than crashing
	return ""
}

func sanitizeSoftwareItem(item SoftwareItem) SoftwareItem {
	item.Name = truncateCollectorString(item.Name)
	item.Version = truncateCollectorString(item.Version)
	item.Vendor = truncateCollectorString(item.Vendor)
	item.InstallDate = truncateCollectorString(item.InstallDate)
	item.InstallLocation = truncateCollectorString(item.InstallLocation)
	item.UninstallString = truncateCollectorString(item.UninstallString)
	return item
}
