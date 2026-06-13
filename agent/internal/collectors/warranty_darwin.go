//go:build darwin

package collectors

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Coverage kind values describing whether coverage is an active recurring
// subscription (AppleCare monthly/annual) or fixed-term coverage with a real
// end date. Derived from the NDO coverageExpirationLabel verb ("Renews ..." vs
// "Expires ..."). Empty means unknown / could not be determined.
const (
	coverageKindSubscription = "subscription" // "Renews <date>" — recurring, no fixed end
	coverageKindFixed        = "fixed"         // "Expires <date>" — true warranty end date
)

// AppleWarrantyInfo contains warranty data extracted from local macOS plists.
type AppleWarrantyInfo struct {
	CoverageEndDate   string `json:"coverageEndDate,omitempty"`
	CoverageStartDate string `json:"coverageStartDate,omitempty"`
	DeviceName        string `json:"deviceName,omitempty"`
	CoverageType      string `json:"coverageType,omitempty"`
	// CoverageKind distinguishes an active AppleCare subscription ("subscription",
	// from a "Renews <date>" label) from fixed-term coverage ("fixed", from an
	// "Expires <date>" label). Empty when the verb is absent/unrecognized.
	// For a subscription, CoverageEndDate is the next renewal/billing date, NOT a
	// true warranty end — consumers should suppress expiry alerts in that case.
	CoverageKind string `json:"coverageKind,omitempty"`
	// Raw contains all plist fields for debugging / future use.
	Raw map[string]any `json:"raw,omitempty"`
}

// CollectAppleWarranty reads Apple warranty data from macOS NDO coverage caches
// and plists. The primary source is the JSON coverage details cache at
// /Users/*/Library/Application Support/com.apple.NewDeviceOutreach/caches/coverageDetails/*.json
// which contains actual warranty/AppleCare data. Falls back to *.plist files in the
// NDO directory root. Since the agent typically runs as root, it can access all user directories.
func CollectAppleWarranty() (*AppleWarrantyInfo, error) {
	serial := getDeviceSerial()

	// Primary source: NDO coverage details cache (JSON)
	info, err := collectFromCoverageCache(serial)
	if err != nil {
		slog.Warn("failed to read coverage cache", "error", err.Error())
	}
	if info != nil {
		return info, nil
	}

	// Fallback: plist files in NDO root
	return collectFromPlists()
}

// getDeviceSerial returns the hardware serial number via ioreg, or "" if unavailable.
func getDeviceSerial() string {
	out, err := runCollectorOutput(collectorShortCommandTimeout, "ioreg", "-rd1", "-c", "IOPlatformExpertDevice")
	if err != nil {
		return ""
	}

	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "IOPlatformSerialNumber") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				return strings.Trim(strings.TrimSpace(parts[1]), "\"")
			}
		}
	}
	return ""
}

// coverageDetailsJSON matches the Apple NDO coverage cache format.
type coverageDetailsJSON struct {
	SerialNumber            string `json:"serialNumber"`
	CoverageLabel           string `json:"coverageLabel"`
	SettingsCoverageSection struct {
		CoverageExpirationLabel string `json:"coverageExpirationLabel"`
		Offer                   struct {
			Expiration string `json:"expiration"`
		} `json:"offer"`
	} `json:"settingsCoverageSection"`
}

// collectFromCoverageCache reads warranty info from NDO JSON coverage cache files.
// If serial is non-empty, it tries to match the device's own serial first.
func collectFromCoverageCache(serial string) (*AppleWarrantyInfo, error) {
	pattern := "/Users/*/Library/Application Support/com.apple.NewDeviceOutreach/caches/coverageDetails/*.json"
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("glob coverage cache: %w", err)
	}
	if len(matches) == 0 {
		return nil, nil
	}

	// If we know the serial, try exact match first
	if serial != "" {
		for _, path := range matches {
			base := strings.TrimSuffix(filepath.Base(path), ".json")
			if base == serial {
				info, parseErr := parseCoverageDetailsJSON(path)
				if parseErr != nil {
					slog.Warn("failed to parse coverage cache", "path", path, "error", parseErr.Error())
				}
				if info != nil {
					return info, nil
				}
			}
		}
	}

	// No serial match — pick the entry with the latest end date
	var best *AppleWarrantyInfo
	var bestEnd time.Time
	for _, path := range matches {
		info, parseErr := parseCoverageDetailsJSON(path)
		if parseErr != nil {
			slog.Warn("failed to parse coverage cache", "path", path, "error", parseErr.Error())
			continue
		}
		if info == nil {
			continue
		}
		if info.CoverageEndDate != "" {
			if t, tErr := time.Parse("2006-01-02", info.CoverageEndDate); tErr == nil {
				if best == nil || t.After(bestEnd) {
					best = info
					bestEnd = t
				}
				continue
			}
		}
		if best == nil {
			best = info
		}
	}
	return best, nil
}

// parseCoverageDetailsJSON reads an NDO coverage cache JSON file.
func parseCoverageDetailsJSON(path string) (*AppleWarrantyInfo, error) {
	statInfo, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if statInfo.Size() > collectorFileReadLimit {
		return nil, fmt.Errorf("coverage cache too large")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cd coverageDetailsJSON
	if err := json.Unmarshal(data, &cd); err != nil {
		return nil, fmt.Errorf("json unmarshal: %w", err)
	}

	if cd.CoverageLabel == "" {
		return nil, nil
	}

	info := &AppleWarrantyInfo{
		CoverageType: truncateCollectorString(cd.CoverageLabel),
		DeviceName:   truncateCollectorString(cd.SerialNumber),
	}

	// Parse end date from Unix timestamp or human-readable label, and derive the
	// coverage kind (subscription vs fixed-term) from the label verb.
	info.CoverageEndDate, info.CoverageKind = parseCoverageExpiration(
		cd.SettingsCoverageSection.Offer.Expiration,
		cd.SettingsCoverageSection.CoverageExpirationLabel,
	)

	// Store raw data for debugging
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err == nil {
		info.Raw = raw
	}

	return info, nil
}

// parseCoverageExpiration extracts a YYYY-MM-DD date from either a Unix timestamp
// string or a human-readable label like "Renews April 17, 2026" / "Expires October 20, 2026".
// It also returns the coverage kind derived from the label verb: "subscription"
// for a "Renews ..." label (recurring AppleCare — date is the next renewal, not a
// true warranty end) or "fixed" for an "Expires ..." label (real end date). The
// kind is "" when no recognized verb is present (e.g. timestamp-only with no label).
func parseCoverageExpiration(timestampStr, label string) (date string, kind string) {
	kind = coverageKindFromLabel(label)

	// Try Unix timestamp first (non-zero)
	if timestampStr != "" && timestampStr != "0" {
		var ts int64
		if _, err := fmt.Sscanf(timestampStr, "%d", &ts); err == nil && ts > 0 {
			return time.Unix(ts, 0).UTC().Format("2006-01-02"), kind
		}
	}

	// Parse human-readable label: strip "Renews " / "Expires " prefix
	if label != "" {
		dateStr := strings.TrimSpace(label)
		for prefix := range coverageLabelVerbs {
			if strings.HasPrefix(dateStr, prefix) {
				dateStr = strings.TrimSpace(strings.TrimPrefix(dateStr, prefix))
				break
			}
		}
		// Parse "January 2, 2006" format
		if t, err := time.Parse("January 2, 2006", dateStr); err == nil {
			return t.Format("2006-01-02"), kind
		}
	}

	return "", kind
}

// coverageLabelVerbs maps an NDO coverageExpirationLabel prefix to a coverage kind.
var coverageLabelVerbs = map[string]string{
	"Renews ":  coverageKindSubscription,
	"Expires ": coverageKindFixed,
}

// coverageKindFromLabel returns the coverage kind implied by the label verb, or
// "" if the label has no recognized "Renews "/"Expires " prefix.
func coverageKindFromLabel(label string) string {
	label = strings.TrimSpace(label)
	for prefix, kind := range coverageLabelVerbs {
		if strings.HasPrefix(label, prefix) {
			return kind
		}
	}
	return ""
}

// collectFromPlists reads warranty info from NDO plist files (legacy fallback).
func collectFromPlists() (*AppleWarrantyInfo, error) {
	pattern := "/Users/*/Library/Application Support/com.apple.NewDeviceOutreach/*.plist"
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, fmt.Errorf("glob warranty plists: %w", err)
	}

	if len(matches) == 0 {
		return nil, nil
	}

	var best *AppleWarrantyInfo
	var bestEnd time.Time

	for _, path := range matches {
		info, parseErr := parseAppleWarrantyPlist(path)
		if parseErr != nil {
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
			if t, tErr := time.Parse(time.RFC3339, info.CoverageEndDate); tErr == nil {
				info.CoverageEndDate = t.Format("2006-01-02")
				if best == nil || t.After(bestEnd) {
					best = info
					bestEnd = t
				}
				continue
			}
		}

		if best == nil {
			best = info
		}
	}

	return best, nil
}

// parseAppleWarrantyPlist converts a plist to JSON via plutil and extracts warranty fields.
func parseAppleWarrantyPlist(path string) (*AppleWarrantyInfo, error) {
	statInfo, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if statInfo.Size() > collectorFileReadLimit {
		return nil, fmt.Errorf("plist too large")
	}

	// Convert plist to JSON using plutil (available on all macOS)
	out, err := runCollectorOutput(collectorShortCommandTimeout, "plutil", "-convert", "json", "-o", "-", path)
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
			info.CoverageEndDate = truncateCollectorString(normalizeDate(val))
		case lower == "coveragestartdate" || lower == "coverage_start_date" || lower == "warrantystartdate":
			info.CoverageStartDate = truncateCollectorString(normalizeDate(val))
		case lower == "devicename" || lower == "device_name" || lower == "productname":
			if s, ok := val.(string); ok {
				info.DeviceName = truncateCollectorString(s)
			}
		case lower == "coveragetype" || lower == "coverage_type" || lower == "warrantytype":
			if s, ok := val.(string); ok {
				info.CoverageType = truncateCollectorString(s)
			}
		case lower == "coverageexpirationlabel" || lower == "coverage_expiration_label" || lower == "expirationlabel":
			// Derive the coverage kind from a "Renews ..."/"Expires ..." verb if
			// the plist happens to carry the NDO expiration label. Most legacy
			// plists do NOT — in that case CoverageKind stays "" (the heartbeat
			// omits it and the API treats absence as fixed-term, which is the
			// safe default since plist fallbacks lack subscription metadata).
			if s, ok := val.(string); ok {
				if k := coverageKindFromLabel(s); k != "" {
					info.CoverageKind = k
				}
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
