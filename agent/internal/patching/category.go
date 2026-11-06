package patching

import "strings"

// classifyWindowsUpdateCategory maps a Windows Update's category names to the
// single canonical category string Breeze uses downstream (patches.category,
// Update Ring category rules).
//
// It scans EVERY category name, not just the first, and returns the
// most-specific match. WUA attaches several categories to an update — e.g. a
// cumulative update can carry both a product category ("Windows 11") and a
// classification ("Security Updates"). Reading only index 0 (the previous
// behaviour) frequently landed on the product name and mislabelled the update
// as "application", so a ring's Security rule would miss real security updates.
//
// The returned values are kept in sync with the Update Ring category options
// (apps/web/src/components/patches/UpdateRingForm.tsx) and the approval
// evaluator (apps/api/src/services/patchApprovalEvaluator.ts): security,
// firmware, driver, definitions, feature, system, application.
func classifyWindowsUpdateCategory(names []string) string {
	// Ordered most-specific -> least-specific. The first rank with any matching
	// category name wins, so a "Security Updates" classification beats a generic
	// product-name category regardless of WUA ordering.
	ranked := []struct {
		category string
		match    func(string) bool
	}{
		{"security", func(n string) bool { return strings.Contains(n, "security") || strings.Contains(n, "critical") }},
		{"firmware", func(n string) bool { return strings.Contains(n, "firmware") }},
		{"driver", func(n string) bool { return strings.Contains(n, "driver") }},
		{"definitions", func(n string) bool { return strings.Contains(n, "definition") }},
		// "Feature Packs" and "Upgrades" — the latter is where WUA files Windows
		// feature releases ("Windows 11, version 25H2"); rings govern those
		// through the feature category and the feature-update policy. Exact on
		// "upgrades": the product category "Windows 10 and later upgrade &
		// servicing drivers" is drivers.
		{"feature", func(n string) bool { return strings.Contains(n, "feature") || strings.TrimSpace(n) == "upgrades" }},
		{"system", func(n string) bool {
			return strings.Contains(n, "service pack") || strings.Contains(n, "update rollup")
		}},
	}

	lowered := make([]string, 0, len(names))
	for _, n := range names {
		lowered = append(lowered, strings.ToLower(n))
	}

	for _, r := range ranked {
		for _, n := range lowered {
			if r.match(n) {
				return r.category
			}
		}
	}

	return "application"
}

// Values of AvailablePatch.ReportedUpdateType. The API's device_patches CHECK
// allows exactly these, and an API that has never heard of a newer value drops it
// rather than the scan.
const (
	ReportedUpdateTypeDriver     = "driver"
	ReportedUpdateTypeFirmware   = "firmware"
	ReportedUpdateTypeQuality    = "quality"
	ReportedUpdateTypeFeature    = "feature"
	ReportedUpdateTypeDefinition = "definition"
	ReportedUpdateTypeOther      = "other"
)

// reportedWindowsUpdateType is what this device says one Windows Update is, for
// the API's "one owner per update class" rule (#11073).
//
// Only a WUA driver can be a driver or firmware here. The category string cannot
// do it alone, because a product category can name drivers. A security
// classification does not change the answer: the API reads the category beside
// this and leaves such an update with Windows Update.
//
// kind comes from ClassifyDriverUpdate, the classifier the Surface lane uses, so
// the two agree on what firmware is. Its doubtful answers lean to firmware, which
// here means the stricter delivery test on the API.
func reportedWindowsUpdateType(updateType, category string, kind DriverKind) string {
	if updateType == UpdateTypeDriver {
		if kind == DriverKindFirmware || category == "firmware" {
			return ReportedUpdateTypeFirmware
		}
		return ReportedUpdateTypeDriver
	}
	if updateType == UpdateTypeFeature {
		return ReportedUpdateTypeFeature
	}
	switch category {
	case "security", "system":
		return ReportedUpdateTypeQuality
	case "definitions":
		return ReportedUpdateTypeDefinition
	case "feature":
		return ReportedUpdateTypeFeature
	}
	return ReportedUpdateTypeOther
}

// reportedWindowsUpdate is what one scanned update reports: its type, and for a
// driver the vendor lane that owns it. read is the COM property reader on Windows.
// A property that cannot be read stays empty: an empty class reads as firmware, and
// an empty manufacturer has no owner, both the safe direction.
func reportedWindowsUpdate(updateType, category, title string, read func(property string) (string, error)) (reportedType, owner string) {
	if updateType != UpdateTypeDriver {
		return reportedWindowsUpdateType(updateType, category, DriverKindDriver), ""
	}
	class, _ := read("DriverClass")
	model, _ := read("DriverModel")
	maker, _ := read("DriverManufacturer")
	u := DriverUpdate{Title: title, DriverClass: class, DriverModel: model, DriverManufacturer: maker}
	return reportedWindowsUpdateType(updateType, category, ClassifyDriverUpdate(u)), driverUpdateOwner(u)
}
