//go:build darwin

package collectors

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// AppleWarrantyInfo contains warranty data extracted from local macOS plists.
type AppleWarrantyInfo struct {
	CoverageEndDate   string `json:"coverageEndDate,omitempty"`
	CoverageStartDate string `json:"coverageStartDate,omitempty"`
	DeviceName        string `json:"deviceName,omitempty"`
	CoverageType      string `json:"coverageType,omitempty"`
	// Raw contains all plist fields for debugging / future use.
	Raw map[string]any `json:"raw,omitempty"`
}

// CollectAppleWarranty reads Apple warranty plists from
// /Users/*/Library/Application Support/com.apple.NewDeviceOutreach/*.plist
// and returns the best warranty info found. Since the agent typically runs as root,
// it can access all user directories.
func CollectAppleWarranty() (*AppleWarrantyInfo, error) {
	// Glob across all user directories
	pattern := "/Users/*/Library/Application Support/com.apple.NewDeviceOutreach/*.plist"
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("glob warranty plists: %w", err)
	}

	if len(matches) == 0 {
		return nil, nil // No plist files found — not an error, just no data
	}

	var best *AppleWarrantyInfo
	var bestEnd time.Time

	for _, path := range matches {
		info, parseErr := parseAppleWarrantyPlist(path)
		if parseErr != nil {
			// Log but continue — some plists may not contain warranty data
			slog.Warn("failed to parse warranty plist", "path", path, "error", parseErr.Error())
			continue
		}
		if info == nil {
			continue
		}

		// Pick the entry with the latest coverage end date
		if info.CoverageEndDate != "" {
			if t, tErr := time.Parse("2006-01-02", info.CoverageEndDate); tErr == nil {
				if best == nil || t.After(bestEnd) {
					best = info
					bestEnd = t
				}
				continue
			}
			// Try RFC3339 date format
			if t, tErr := time.Parse(time.RFC3339, info.CoverageEndDate); tErr == nil {
				info.CoverageEndDate = t.Format("2006-01-02")
				if best == nil || t.After(bestEnd) {
					best = info
					bestEnd = t
				}
				continue
			}
		}

		// If no end date parsed but we have no best, use this entry anyway
		if best == nil {
			best = info
		}
	}

	return best, nil
}

// parseAppleWarrantyPlist converts a plist to JSON via plutil and extracts warranty fields.
func parseAppleWarrantyPlist(path string) (*AppleWarrantyInfo, error) {
	// Verify file exists and is readable
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Convert plist to JSON using plutil (available on all macOS)
	out, err := exec.CommandContext(ctx, "plutil", "-convert", "json", "-o", "-", path).Output()
	if err != nil {
		return nil, fmt.Errorf("plutil convert: %w", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("json unmarshal: %w", err)
	}

	if len(raw) == 0 {
		return nil, nil
	}

	info := &AppleWarrantyInfo{
		Raw: raw,
	}

	// Extract known fields (case-insensitive key search)
	for key, val := range raw {
		lower := strings.ToLower(key)
		switch {
		case lower == "coverageenddate" || lower == "coverage_end_date" || lower == "warrantyenddate":
			info.CoverageEndDate = normalizeDate(val)
		case lower == "coveragestartdate" || lower == "coverage_start_date" || lower == "warrantystartdate":
			info.CoverageStartDate = normalizeDate(val)
		case lower == "devicename" || lower == "device_name" || lower == "productname":
			if s, ok := val.(string); ok {
				info.DeviceName = s
			}
		case lower == "coveragetype" || lower == "coverage_type" || lower == "warrantytype":
			if s, ok := val.(string); ok {
				info.CoverageType = s
			}
		}
	}

	// Only return if we found at least one warranty field
	if info.CoverageEndDate == "" && info.CoverageStartDate == "" && info.CoverageType == "" {
		return nil, nil
	}

	return info, nil
}

// normalizeDate converts various date formats to YYYY-MM-DD.
func normalizeDate(val any) string {
	switch v := val.(type) {
	case string:
		v = strings.TrimSpace(v)
		// Try YYYY-MM-DD
		if t, err := time.Parse("2006-01-02", v); err == nil {
			return t.Format("2006-01-02")
		}
		// Try RFC3339
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t.Format("2006-01-02")
		}
		// Try common US date format MM/DD/YYYY
		if t, err := time.Parse("01/02/2006", v); err == nil {
			return t.Format("2006-01-02")
		}
		// Try ISO with time
		if t, err := time.Parse("2006-01-02T15:04:05Z", v); err == nil {
			return t.Format("2006-01-02")
		}
		return v // Return as-is if no format matches
	case float64:
		// Could be a Unix timestamp
		if v > 1e9 && v < 1e12 {
			t := time.Unix(int64(v), 0)
			return t.Format("2006-01-02")
		}
		return ""
	default:
		return ""
	}
}
